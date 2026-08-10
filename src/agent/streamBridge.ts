import { createExecutor } from '@cherrystudio/ai-core'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolCall, Usage } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { fetch as expoFetch } from 'expo/fetch'

import { createAiSdkProvider } from '@/aiCore/provider/factory'
import { prepareSpecialProviderConfig, providerToAiSdkConfig } from '@/aiCore/provider/providerConfig'
import { loggerService } from '@/services/LoggerService'
import type { StreamTextParams } from '@/types/aiCoretypes'
import type { Assistant, Model as CherryModel, Provider as CherryProvider } from '@/types/assistant'

import { getAgentErrorMessage, normalizeAgentError } from './agentError'
import { piMessagesToAiSdkMessages } from './messageBridge'
import { agentToolToAiSdkTool } from './toolAdapter'

const logger = loggerService.withContext('streamBridge')
const EMPTY_RESPONSE_ERROR_MESSAGE = 'The model provider returned an empty response.'
const MAX_EMPTY_RESPONSE_ATTEMPTS = 2
type SuccessfulStopReason = Extract<AssistantMessage['stopReason'], 'stop' | 'length' | 'toolUse' | 'deferred'>

function toPiStopReason(finishReason: string): SuccessfulStopReason {
  switch (finishReason) {
    case 'length':
      return 'length'
    case 'tool-calls':
      return 'toolUse'
    default:
      return 'stop'
  }
}

type AgentRequestParamsBuilder = (
  messages: ReturnType<typeof piMessagesToAiSdkMessages>,
  assistant: Assistant,
  provider: CherryProvider,
  options: { requestOptions: { signal?: AbortSignal } }
) => Promise<{ params: StreamTextParams }>

const buildAgentRequestParams: AgentRequestParamsBuilder = async (...args) => {
  const { buildStreamTextParams } = await import('@/aiCore/prepareParams')
  return buildStreamTextParams(...args)
}

/**
 * 用 Cherry 的 provider 体系实现 pi-agent-core 的 streamFn。
 *
 * pi-agent-core 的运行时不绑定任何模型后端，只要求一个满足
 * StreamFn 契约的函数。这里把它接到 Cherry 的 AI SDK provider：
 *   - pi 的 Context.messages → AI SDK model message
 *   - pi 的 AgentTool → AI SDK tool
 *   - AI SDK 的 fullStream 块 → pi 的 AssistantMessageEvent 协议
 *
 * 按 StreamFn 契约不抛出异常：失败通过 error 事件编码。
 */
export function createStreamFn(
  model: CherryModel,
  provider: CherryProvider,
  requestAssistant?: Assistant,
  requestParamsBuilder: AgentRequestParamsBuilder = buildAgentRequestParams
): StreamFn {
  return (piModel, context, options) => {
    const stream = createAssistantMessageEventStream()

    void (async () => {
      let text = ''
      const toolCalls: ToolCall[] = []
      let stopReason: SuccessfulStopReason = 'stop'
      let abortedByStream = false

      const emptyUsage: Usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }

      const buildPartial = (stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
        role: 'assistant',
        content: [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls],
        api: provider.apiHost ?? 'custom',
        provider: provider.id,
        model: model.id,
        usage: emptyUsage,
        stopReason,
        timestamp: Date.now()
      })

      try {
        const config = providerToAiSdkConfig(provider, model)
        // 关键：注入 expoFetch（与普通聊天 ModernAiProvider 的 applyCustomFetchToConfig 一致）。
        // 否则 @ai-sdk/openai-compatible 用 RN 默认 fetch，读 SSE 流返回 Empty response body，
        // 导致 assistant 文本永远为空（这就是模拟器上复现的根因）。
        if (config.options) {
          config.options.fetch = expoFetch
        }
        await prepareSpecialProviderConfig(provider, config)
        // 用 createProviderCore 创建 provider（与普通聊天同源），拿已解析的 model 对象。
        // 传字符串 model.id 给 executor 会触发 globalModelResolver，自定义 provider（mock-agent）
        // 未注册会报 "No providers registered"。
        const localProvider = await createAiSdkProvider(config)
        if (!localProvider) {
          throw new Error('Failed to create provider instance')
        }
        const aiModel = localProvider.languageModel(model.id)
        const executor = createExecutor(config.providerId, config.options)
        const messages = piMessagesToAiSdkMessages(context.messages)
        const tools = context.tools?.length
          ? Object.fromEntries(context.tools.map(tool => [tool.name, agentToolToAiSdkTool(tool)]))
          : undefined
        const requestParams = requestAssistant
          ? (
              await requestParamsBuilder(messages, requestAssistant, provider, {
                requestOptions: { signal: options?.signal }
              })
            ).params
          : { messages, abortSignal: options?.signal }
        const {
          prompt: _prompt,
          system: _system,
          messages: _messages,
          tools: _tools,
          ...sharedRequestParams
        } = requestParams

        const streamRequest = {
          ...sharedRequestParams,
          model: aiModel,
          system: context.systemPrompt,
          messages,
          tools: tools as Parameters<typeof executor.streamText>[0]['tools'],
          abortSignal: options?.signal
        } satisfies Parameters<typeof executor.streamText>[0]
        let streamStarted = false
        const ensureStreamStarted = () => {
          if (streamStarted) return
          streamStarted = true
          stream.push({ type: 'start', partial: buildPartial() })
        }

        for (let attempt = 1; attempt <= MAX_EMPTY_RESPONSE_ATTEMPTS; attempt++) {
          stopReason = 'stop'
          const result = await executor.streamText(streamRequest)
          // Keep the pi stream protocol stable: every attempt sequence has
          // exactly one start event, emitted before any provider chunks.
          ensureStreamStarted()

          for await (const chunk of result.fullStream) {
            if (chunk.type === 'text-delta') {
              ensureStreamStarted()
              text += chunk.text
              stream.push({
                type: 'text_delta',
                contentIndex: 0,
                delta: chunk.text,
                partial: buildPartial()
              })
            } else if (chunk.type === 'tool-call') {
              ensureStreamStarted()
              // fullStream 的 tool-call 块有两种形态（静态/动态），
              // 统一用可选访问提取字段。
              const chunkAny = chunk as {
                toolCallId?: string
                toolName?: string
                input?: Record<string, unknown>
              }
              toolCalls.push({
                type: 'toolCall',
                id: chunkAny.toolCallId ?? `tool-${toolCalls.length}`,
                name: chunkAny.toolName ?? 'unknown',
                arguments: chunkAny.input ?? {}
              })
              stream.push({
                type: 'toolcall_end',
                contentIndex: text ? 1 : 0,
                toolCall: toolCalls[toolCalls.length - 1],
                partial: buildPartial()
              })
            } else if (chunk.type === 'finish') {
              if (chunk.finishReason === 'error') {
                throw new Error('The model provider ended the stream with an error.')
              }
              stopReason = toPiStopReason(chunk.finishReason)
            } else if (chunk.type === 'error') {
              throw normalizeAgentError(chunk.error)
            } else if (chunk.type === 'abort') {
              abortedByStream = true
              throw new Error('Request was aborted.')
            }
          }

          // Some compatible providers do not expose text deltas even though
          // the final StreamTextResult contains text. Recover it before
          // treating the turn as empty; message_end creates the UI text block.
          if (!text) {
            text = (await result.text) || ''
          }

          // Likewise, retain final tool calls if a provider omitted their
          // intermediate fullStream event.
          if (toolCalls.length === 0) {
            const finalToolCalls = (await result.toolCalls) || []
            for (const finalToolCall of finalToolCalls) {
              toolCalls.push({
                type: 'toolCall',
                id: finalToolCall.toolCallId,
                name: finalToolCall.toolName,
                arguments: finalToolCall.input as Record<string, unknown>
              })
            }
          }

          if (!text.trim() && toolCalls.length === 0) {
            if (attempt < MAX_EMPTY_RESPONSE_ATTEMPTS && options?.signal?.aborted !== true) {
              logger.warn('Provider returned no text or tool calls; retrying the Agent request once.', {
                providerId: provider.id,
                modelId: model.id
              })
              text = ''
              continue
            }
            throw new Error(EMPTY_RESPONSE_ERROR_MESSAGE)
          }

          ensureStreamStarted()
          const finalMessage = buildPartial(stopReason)
          stream.push({ type: 'done', reason: stopReason, message: finalMessage })
          stream.end(finalMessage)
          return
        }
      } catch (error) {
        logger.error('streamBridge executor 调用失败:', error)
        const errorLike =
          typeof error === 'object' && error !== null ? (error as { name?: unknown; message?: unknown }) : undefined
        const aborted =
          abortedByStream ||
          options?.signal?.aborted === true ||
          errorLike?.name === 'AbortError' ||
          errorLike?.message === 'Request was aborted.'
        const normalizedError = normalizeAgentError(error)
        const errorMessageText = aborted ? 'Request was aborted.' : getAgentErrorMessage(normalizedError)
        const errorMessage: AssistantMessage & { statusCode?: number; responseBody?: string } = {
          ...buildPartial(aborted ? 'aborted' : 'error'),
          // Keep cancellation recognisable by the existing streaming callbacks,
          // which render it as a paused message instead of a failed message.
          errorMessage: errorMessageText,
          ...(normalizedError.statusCode !== undefined ? { statusCode: normalizedError.statusCode } : {}),
          ...(normalizedError.responseBody ? { responseBody: normalizedError.responseBody } : {})
        }
        stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: errorMessage })
        stream.end(errorMessage)
      }
    })()

    return stream
  }
}
