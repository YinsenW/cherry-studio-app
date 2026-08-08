import type { Agent } from '@earendil-works/pi-agent-core'

import type { Chunk } from '@/types/chunk'
import { ChunkType } from '@/types/chunk'
import type { MCPToolResponse } from '@/types/mcp'

import { getMcpAgentToolMetadata } from './mcpToolNames'

type PiAgentEvent = Parameters<Parameters<Agent['subscribe']>[0]>[0]
type TerminalMessage = {
  role?: string
  stopReason?: string
  errorMessage?: string
  statusCode?: number
  responseBody?: string
}

export type AgentChunkAdapterState = {
  agentEnded: boolean
  hasVisibleOutput: boolean
  terminalError: boolean
}

export type AgentEventToChunk = ((event: PiAgentEvent) => Promise<void>) & {
  getState: () => AgentChunkAdapterState
}

const EMPTY_AGENT_RESPONSE_MESSAGE = 'The agent completed without producing a visible response.'
const INCOMPLETE_TOOL_MESSAGE = 'Tool execution did not complete before the agent session ended.'

function getTerminalFailure(message: TerminalMessage | undefined) {
  if (
    !message ||
    (message.stopReason !== 'error' && message.stopReason !== 'aborted' && !message.errorMessage?.trim())
  ) {
    return null
  }

  const aborted = message.stopReason === 'aborted'
  return {
    message: aborted ? 'Request was aborted.' : message.errorMessage?.trim() || 'The agent request failed.',
    aborted,
    statusCode: message.statusCode,
    responseBody: message.responseBody
  }
}

/** 把 pi 工具的调用参数 + 结果转成现有 UI 的 MCPToolResponse（工具块渲染需要） */
function makeToolResponse(
  name: string,
  toolCallId: string,
  args: Record<string, unknown>,
  status: MCPToolResponse['status'],
  resultText?: string,
  resultDetails?: unknown
): MCPToolResponse {
  const registeredRemoteTool = getMcpAgentToolMetadata(name)
  const remoteTool = /^mcp:([^:]+):(.+)$/.exec(name)
  const toolName = registeredRemoteTool?.toolName ?? remoteTool?.[2] ?? name
  const serverId = registeredRemoteTool?.serverId ?? remoteTool?.[1]
  return {
    id: toolCallId,
    tool: {
      id: serverId ? name : `builtin_${name}`,
      serverId: serverId ?? 'builtin',
      serverName: registeredRemoteTool?.serverName ?? (serverId ? 'MCP' : 'System'),
      name: toolName,
      description: toolName,
      inputSchema: { type: 'object', properties: {} },
      isBuiltIn: !serverId,
      type: 'mcp'
    },
    toolCallId,
    arguments: args,
    status,
    ...(resultText || resultDetails !== undefined
      ? {
          response: {
            type: 'text',
            text: resultText ?? '',
            ...(resultDetails !== undefined ? { details: resultDetails } : {})
          }
        }
      : {})
  }
}

/**
 * 把 pi-agent 的事件流适配为 Cherry 现有聊天块流（Chunk）。
 *
 * 关键点：
 * - 文本增量 → TEXT_START/TEXT_DELTA/TEXT_COMPLETE（复用现有文本块渲染）
 * - 工具执行 → MCP_TOOL_PENDING/MCP_TOOL_COMPLETE（复用现有 ToolBlock 渲染，且**不触发**中间件自动执行——因为 chunk 在这里直接喂给 streamProcessor，不走 aiCore 中间件链）
 * - agent 结束 → BLOCK_COMPLETE（结束消息状态）
 */
export function createAgentEventToChunk(emit: (chunk: Chunk) => void | Promise<void>) {
  let textStarted = false
  let terminalError: ReturnType<typeof getTerminalFailure> = null
  let agentEnded = false
  let hasVisibleOutput = false
  let terminalFailed = false
  const pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>()

  const adapter = (async (event: PiAgentEvent) => {
    switch (event.type) {
      case 'agent_start':
        await emit({ type: ChunkType.LLM_RESPONSE_CREATED })
        break

      case 'message_start':
        // 用户消息已由发送端落库，这里跳过，避免重复渲染
        break

      case 'message_update': {
        const deltaEvent = event.assistantMessageEvent
        if (deltaEvent.type === 'text_delta') {
          if (!textStarted) {
            await emit({ type: ChunkType.TEXT_START })
            textStarted = true
          }
          // 关键：发累积文本而不是增量 delta。
          // 现有 onTextChunk 是覆盖式写入（content = text），普通聊天发累积文本
          // （AiSdkToChunkAdapter accumulate 模式），如果发增量会导致逐字覆盖、
          // 只剩末尾，最后 onTextComplete 才全量落盘（表现为"最后一下全出来"）。
          const accumulatedText = deltaEvent.partial.content
            .filter(part => part.type === 'text')
            .map(part => (part as { text: string }).text)
            .join('')
          await emit({ type: ChunkType.TEXT_DELTA, text: accumulatedText })
        }
        break
      }

      case 'message_end': {
        if (event.message.role === 'assistant') {
          if (event.message.errorMessage) {
            terminalError = getTerminalFailure(event.message as TerminalMessage)
          } else if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
            terminalError = getTerminalFailure(event.message as TerminalMessage)
          }

          // 关键：TEXT_COMPLETE 必须带完整文本，否则 onTextComplete 会用空字符串
          // 覆盖 block 的 content（模拟器上验证出的根因：文本被冲掉）。
          const fullText = event.message.content
            .filter(part => part.type === 'text')
            .map(part => (part as { text: string }).text)
            .join('')

          // Most providers emit text_delta events. Some compatible providers,
          // however, only expose the completed message. Preserve that response
          // instead of treating a successful turn as an empty assistant block.
          if (textStarted || fullText) {
            if (fullText.trim()) {
              hasVisibleOutput = true
            }
            if (!textStarted) {
              await emit({ type: ChunkType.TEXT_START })
            }
            await emit({ type: ChunkType.TEXT_COMPLETE, text: fullText })
            textStarted = false
          }
        }
        break
      }

      case 'tool_execution_start':
        await emit({
          type: ChunkType.MCP_TOOL_PENDING,
          responses: [
            makeToolResponse(event.toolName, event.toolCallId, event.args as Record<string, unknown>, 'pending')
          ]
        })
        pendingTools.set(event.toolCallId, { name: event.toolName, args: event.args as Record<string, unknown> })
        break

      case 'tool_execution_end': {
        const pendingTool = pendingTools.get(event.toolCallId)
        const resultText =
          event.result?.content
            ?.filter(part => part.type === 'text')
            .map(part => (part as { text: string }).text)
            .join('') ?? ''
        const status = event.isError ? 'error' : ('done' as const)
        await emit({
          type: ChunkType.MCP_TOOL_COMPLETE,
          responses: [
            makeToolResponse(
              pendingTool?.name ?? 'tool',
              event.toolCallId,
              pendingTool?.args ?? {},
              status,
              resultText,
              event.result?.details
            )
          ]
        })
        pendingTools.delete(event.toolCallId)
        hasVisibleOutput = true
        break
      }

      case 'tool_execution_update': {
        const pendingTool = pendingTools.get(event.toolCallId)
        const progressText = event.partialResult?.content
          ?.filter((part: { type?: string }) => part.type === 'text')
          .map((part: { text?: string }) => part.text ?? '')
          .join('')
        await emit({
          type: ChunkType.MCP_TOOL_IN_PROGRESS,
          responses: [
            makeToolResponse(
              pendingTool?.name ?? event.toolName,
              event.toolCallId,
              pendingTool?.args ?? (event.args as Record<string, unknown>),
              'invoking',
              progressText,
              event.partialResult?.details
            )
          ]
        })
        break
      }

      case 'agent_end': {
        agentEnded = true
        const finalAssistant = [...(event.messages ?? [])]
          .reverse()
          .find(message => message.role === 'assistant' || 'stopReason' in message || 'errorMessage' in message) as
          | TerminalMessage
          | undefined
        let finalError = getTerminalFailure(finalAssistant) ?? terminalError

        if (pendingTools.size > 0) {
          for (const [toolCallId, pendingTool] of pendingTools) {
            await emit({
              type: ChunkType.MCP_TOOL_COMPLETE,
              responses: [
                makeToolResponse(pendingTool.name, toolCallId, pendingTool.args, 'error', INCOMPLETE_TOOL_MESSAGE)
              ]
            })
          }
          pendingTools.clear()
          finalError ??= {
            message: INCOMPLETE_TOOL_MESSAGE,
            aborted: false,
            statusCode: undefined,
            responseBody: undefined
          }
        }

        if (finalError) {
          terminalFailed = true
          const error = new Error(finalError.aborted ? 'Request was aborted.' : finalError.message) as Error & {
            code: string
            statusCode?: number
            responseBody?: string
          }
          error.code = 'AGENT_ERROR'
          error.statusCode = finalError.statusCode
          error.responseBody = finalError.responseBody
          await emit({
            type: ChunkType.ERROR,
            error
          })
          terminalError = null
          break
        }

        if (!hasVisibleOutput) {
          terminalFailed = true
          const error = new Error(EMPTY_AGENT_RESPONSE_MESSAGE) as Error & { code: string }
          error.code = 'AGENT_PROTOCOL_INCOMPLETE'
          await emit({ type: ChunkType.ERROR, error })
          break
        }

        await emit({ type: ChunkType.BLOCK_COMPLETE })
        break
      }

      default:
        break
    }
  }) as AgentEventToChunk

  adapter.getState = () => ({
    agentEnded,
    hasVisibleOutput,
    terminalError: terminalFailed || terminalError !== null
  })

  return adapter
}
