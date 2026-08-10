import type { Assistant } from '@/types/assistant'
import type { MCPServer } from '@/types/mcp'

import { assistantService } from '../AssistantService'
import { loggerService } from '../LoggerService'

const logger = loggerService.withContext('McpAssistantBindingService')

type AssistantBindingService = Pick<typeof assistantService, 'getAssistant' | 'updateAssistant'>

/**
 * Attach MCP servers to the latest persisted Assistant snapshot.
 *
 * The MCP management screen owns global server configuration, while Agent
 * discovery intentionally reads an Assistant-specific allow-list. Manual
 * create/import/enable actions therefore need this explicit bridge just like
 * marketplace installs do. Failures stay non-fatal because the global MCP
 * record is still valid and can be attached later from the chat tool picker.
 */
export async function attachMcpServersToAssistant(
  assistantId: Assistant['id'] | undefined,
  servers: MCPServer[],
  service: AssistantBindingService = assistantService
): Promise<boolean> {
  if (!assistantId || servers.length === 0) {
    return false
  }

  try {
    const assistant = await service.getAssistant(assistantId)
    if (!assistant) {
      logger.warn('Cannot attach MCP servers because the current assistant was not found', { assistantId })
      return false
    }

    const incomingById = new Map(servers.map(server => [server.id, server]))
    const nextServers = [
      ...(assistant.mcpServers ?? []).filter(server => !incomingById.has(server.id)),
      ...incomingById.values()
    ]

    await service.updateAssistant(assistant.id, { mcpServers: nextServers })
    return true
  } catch (error) {
    logger.warn('MCP servers were saved globally but could not be attached to the current assistant', {
      assistantId,
      serverIds: servers.map(server => server.id),
      error
    })
    return false
  }
}
