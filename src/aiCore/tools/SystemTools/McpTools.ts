import type { AgentTool } from '@earendil-works/pi-agent-core'

import { fetchAssistantMcpTools } from '@/services/ApiService'
import { loggerService } from '@/services/LoggerService'
import { mcpClientService } from '@/services/mcp/McpClientService'
import { mcpService } from '@/services/McpService'
import type { Assistant } from '@/types/assistant'

const logger = loggerService.withContext('McpTools')

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
      const server = await mcpService.getMcpServer(mcpTool.serverId)
      if (!server) continue

      // 只处理 streamableHttp——inMemory 的工具已经在 SystemTool
      // 里直接注入，SSE 尚未支持
      if (server.type !== 'streamableHttp') continue

      tools.push({
        name: mcpTool.id,
        label: `${server.name} · ${mcpTool.name}`,
        description: mcpTool.description ?? mcpTool.name,
        parameters: (mcpTool.inputSchema ?? { type: 'object', properties: {} }) as AgentTool['parameters'],
        execute: async (callId, args, _signal, _onUpdate) => {
          const resp = await mcpClientService.callTool(server, mcpTool.name, args as Record<string, unknown>)
          const text = Array.isArray(resp.content)
            ? resp.content
                .map(c => ('text' in c ? String(c.text) : JSON.stringify(c)))
                .join('\n')
            : JSON.stringify(resp)
          return {
            content: [{ type: 'text', text: text || (resp.isError ? 'Tool error' : 'OK') }],
            details: { isError: resp.isError }
          }
        }
      })
    }
  } catch (error) {
    logger.warn('Failed to load MCP tools for agent:', error as Error)
  }

  return tools
}
