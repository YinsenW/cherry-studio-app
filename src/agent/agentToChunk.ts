import type { Agent } from '@earendil-works/pi-agent-core'

import type { Chunk } from '@/types/chunk'
import { ChunkType } from '@/types/chunk'
import type { MCPToolResponse } from '@/types/mcp'

type PiAgentEvent = Parameters<Parameters<Agent['subscribe']>[0]>[0]

/** 把 pi 工具的调用参数 + 结果转成现有 UI 的 MCPToolResponse（工具块渲染需要） */
function makeToolResponse(
  name: string,
  toolCallId: string,
  args: Record<string, unknown>,
  status: MCPToolResponse['status'],
  resultText?: string
): MCPToolResponse {
  const remoteTool = /^mcp:([^:]+):(.+)$/.exec(name)
  const toolName = remoteTool?.[2] ?? name
  return {
    id: toolCallId,
    tool: {
      id: remoteTool ? name : `builtin_${name}`,
      serverId: remoteTool?.[1] ?? 'builtin',
      serverName: remoteTool ? 'MCP' : 'System',
      name: toolName,
      description: toolName,
      inputSchema: { type: 'object', properties: {} },
      isBuiltIn: !remoteTool,
      type: 'mcp'
    },
    toolCallId,
    arguments: args,
    status,
    ...(resultText ? { response: { type: 'text', text: resultText } } : {})
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
  const pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>()

  return async (event: PiAgentEvent) => {
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
          responses: [makeToolResponse(event.toolName, event.toolCallId, event.args as Record<string, unknown>, 'pending')]
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
              resultText
            )
          ]
        })
        pendingTools.delete(event.toolCallId)
        break
      }

      case 'agent_end': {
        // 如果最终 assistant 消息带 errorMessage，把错误暴露到 UI（否则无响应难排查）
        const last = event.messages?.[event.messages.length - 1]
        if (last && 'errorMessage' in last && last.errorMessage) {
          const wasAborted = last.stopReason === 'aborted'
          await emit({
            type: ChunkType.ERROR,
            error: {
              code: 'AGENT_ERROR',
              message: wasAborted ? 'Request was aborted.' : last.errorMessage
            }
          })
          break
        }
        await emit({ type: ChunkType.BLOCK_COMPLETE })
        break
      }

      default:
        break
    }
  }
}
