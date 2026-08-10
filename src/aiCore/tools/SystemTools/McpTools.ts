import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'

import { registerMcpAgentToolName } from '@/agent/mcpToolNames'
import { fetchAssistantMcpTools } from '@/services/ApiService'
import { loggerService } from '@/services/LoggerService'
import { mcpClientService } from '@/services/mcp/McpClientService'
import { mcpService } from '@/services/McpService'
import type { Assistant } from '@/types/assistant'
import type { MCPToolResultContent } from '@/types/mcp'

const logger = loggerService.withContext('McpTools')

function contentToAgentBlocks(content: MCPToolResultContent[]): AgentToolResult<unknown>['content'] {
  const blocks: AgentToolResult<unknown>['content'] = []

  for (const item of content) {
    if (item.type === 'text') {
      blocks.push({ type: 'text', text: item.text ?? '' })
      continue
    }

    if (item.type === 'image' && item.data && item.mimeType) {
      blocks.push({ type: 'image', data: item.data, mimeType: item.mimeType })
      continue
    }

    // pi-agent-core currently accepts text and image result blocks. Preserve
    // every other MCP content block in a readable textual form; the complete
    // typed result remains available under `details` for the UI and logs.
    blocks.push({ type: 'text', text: JSON.stringify(item) })
  }

  return blocks
}

/**
 * 把用户配置的 MCP 服务器工具接入 agent。
 *
 * 只接入 streamableHttp 类型的服务器——SSE 尚未支持，inMemory
 * 服务器的工具已在 sendAgentMessage 中通过 SystemTool / AndroidTool
 * 等直接注入，不需要经由 MCP 协议层。
 *
 * 复用现有链路（fetchAssistantMcpTools + mcpClientService.callTool），
 * 一次接线让 agent 获得用户所有已启用的远程 MCP 能力。
 */
export async function createMcpTools(assistant: Assistant): Promise<AgentTool[]> {
  const tools: AgentTool[] = []

  try {
    const mcpTools = await fetchAssistantMcpTools(assistant)

    for (const mcpTool of mcpTools) {
      try {
        const server = await mcpService.getMcpServer(mcpTool.serverId)
        if (!server) continue

        // 只处理 streamableHttp——inMemory 的工具已经在 SystemTool
        // 里直接注入，SSE 尚未支持
        if (server.type !== 'streamableHttp') continue

        tools.push({
          name: registerMcpAgentToolName({
            serverId: server.id,
            serverName: server.name,
            toolName: mcpTool.name
          }),
          label: `${server.name} · ${mcpTool.name}`,
          description: mcpTool.description ?? mcpTool.name,
          parameters: (mcpTool.inputSchema ?? { type: 'object', properties: {} }) as AgentTool['parameters'],
          execute: async (callId, args, signal, _onUpdate) => {
            const resp = await mcpClientService.callTool(server, mcpTool.name, args as Record<string, unknown>, signal)
            const text = Array.isArray(resp.content)
              ? resp.content.map(c => ('text' in c ? String(c.text) : JSON.stringify(c))).join('\n')
              : JSON.stringify(resp)
            if (resp.isError) {
              throw new Error(text || 'MCP tool execution failed.')
            }
            const content = contentToAgentBlocks(resp.content ?? [])
            return {
              content:
                content.length > 0
                  ? content
                  : [
                      {
                        type: 'text' as const,
                        text: resp.structuredContent ? JSON.stringify(resp.structuredContent) : 'OK'
                      }
                    ],
              details: {
                isError: resp.isError,
                structuredContent: resp.structuredContent,
                content: resp.content
              }
            }
          }
        })
      } catch (error) {
        // A malformed tool must not prevent every other valid tool from being
        // registered for the same assistant.
        logger.warn(`Skipping MCP tool ${mcpTool.name || '<unnamed>'}:`, error as Error)
      }
    }
  } catch (error) {
    logger.warn('Failed to load MCP tools for agent:', error as Error)
  }

  return tools
}
