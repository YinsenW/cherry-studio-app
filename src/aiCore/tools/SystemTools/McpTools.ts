import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'

import { registerMcpAgentToolName } from '@/agent/mcpToolNames'
import { aiSdkToolToAgentTool } from '@/agent/toolAdapter'
import { SystemTool } from '@/aiCore/tools/SystemTools'
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
 * Streamable HTTP tools execute through the MCP client. Selected in-memory
 * MCP tools execute through their existing local SystemTool implementation.
 * Keeping both transports behind this adapter guarantees that an explicitly
 * attached built-in server is still visible when a custom model is absent
 * from Cherry's static function-calling capability table.
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

        if (server.type === 'inMemory') {
          const localTool = SystemTool[mcpTool.name as keyof typeof SystemTool]
          if (!localTool) {
            throw new Error(`Built-in MCP tool implementation not found: ${mcpTool.name}`)
          }

          const agentTool = aiSdkToolToAgentTool(mcpTool.name, localTool as Parameters<typeof aiSdkToolToAgentTool>[1])
          tools.push({
            ...agentTool,
            label: `${server.name} · ${mcpTool.name}`,
            description: mcpTool.description ?? agentTool.description
          })
          continue
        }

        // The mobile runtime supports Streamable HTTP, not legacy SSE/stdio.
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
          execute: async (callId, args, signal, onUpdate) => {
            const resp = await mcpClientService.callTool(
              server,
              mcpTool.name,
              args as Record<string, unknown>,
              signal,
              progress => {
                const progressText =
                  progress.message?.trim() ||
                  (typeof progress.total === 'number' && progress.total > 0
                    ? `MCP progress: ${Math.min(100, Math.round((progress.progress / progress.total) * 100))}%`
                    : `MCP progress: ${progress.progress}`)
                onUpdate?.({
                  content: [{ type: 'text', text: progressText }],
                  details: { progress }
                })
              }
            )
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

  logger.info(`Registered ${tools.length} MCP tool(s) for Agent ${assistant.id}`)
  return tools
}
