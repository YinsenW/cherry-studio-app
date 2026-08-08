import { createExecutor } from '@cherrystudio/ai-core'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolCall, Usage } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { fetch as expoFetch } from 'expo/fetch'

import { createAiSdkProvider } from '@/aiCore/provider/factory'
import { prepareSpecialProviderConfig, providerToAiSdkConfig } from '@/aiCore/provider/providerConfig'
import { loggerService } from '@/services/LoggerService'
import type { Model as CherryModel, Provider as CherryProvider } from '@/types/assistant'

import { piMessagesToAiSdkMessages } from './messageBridge'
import { agentToolToAiSdkTool } from './toolAdapter'

const logger = loggerService.withContext('streamBridge')
const EMPTY_RESPONSE_ERROR_MESSAGE = 'The model provider returned an empty response.'
type SuccessfulStopReason = Extract<AssistantMessage['stopReason'], 'stop' | 'length' | 'toolUse' | 'deferred'>

function normalizeStreamError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    return new Error(String(error.message))
  }

  if (typeof error === 'string') {
    return new Error(error)
  }

  try {
    return new Error(JSON.stringify(error) || 'Unknown model provider error')
  } catch {
    return new Error(String(error))
  }
}

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
export function createStreamFn(model: CherryModel, provider: CherryProvider): StreamFn {
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

        const result = await executor.streamText({
          model: aiModel,
          system: context.systemPrompt,
          messages,
          tools: tools as Parameters<typeof executor.streamText>[0]['tools'],
          abortSignal: options?.signal
        })

        stream.push({ type: 'start', partial: buildPartial() })

        for await (const chunk of result.fullStream) {
          if (chunk.type === 'text-delta') {
            text += chunk.text
            stream.push({
              type: 'text_delta',
              contentIndex: 0,
              delta: chunk.text,
              partial: buildPartial()
            })
          } else if (chunk.type === 'tool-call') {
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
            throw normalizeStreamError(chunk.error)
          } else if (chunk.type === 'abort') {
            abortedByStream = true
            throw new Error('Request was aborted.')
          }
        }

        // Some compatible providers do not expose text deltas even though the
        // final StreamTextResult contains text. Recover it before treating the
        // turn as empty; message_end will create the UI text block.
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
          throw new Error(EMPTY_RESPONSE_ERROR_MESSAGE)
        }

        const finalMessage = buildPartial(stopReason)
        stream.push({ type: 'done', reason: stopReason, message: finalMessage })
        stream.end(finalMessage)
      } catch (error) {
        logger.error('streamBridge executor 调用失败:', error)
        const aborted = abortedByStream || options?.signal?.aborted === true
        // AI_APICallError 的 `message` 字段经常是空串（真实错误在 statusCode /
        // responseBody 里）。若 errorMessage 为空，agentToChunk 会把失败回合
        // 当成静默成功——正是"发消息没反应"的根因。从可用的字段里拼一个可读消息。
        const errorMessageText = (() => {
          if (aborted) return 'Request was aborted.'
          const anyErr = error as Error & { statusCode?: number; responseBody?: string }
          if (typeof anyErr.responseBody === 'string' && anyErr.responseBody) return anyErr.responseBody
          if (typeof anyErr.statusCode === 'number') return `HTTP ${anyErr.statusCode}`
          if (error instanceof Error && error.message) return error.message
          return error ? String(error) : 'Unknown LLM error'
        })()
        const errorMessage: AssistantMessage = {
          ...buildPartial(aborted ? 'aborted' : 'error'),
          // Keep cancellation recognisable by the existing streaming callbacks,
          // which render it as a paused message instead of a failed message.
          errorMessage: errorMessageText
        }
        stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: errorMessage })
        stream.end(errorMessage)
      }
    })()

    return stream
  }
}
