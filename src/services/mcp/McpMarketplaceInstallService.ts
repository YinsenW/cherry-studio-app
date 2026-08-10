import type { Assistant } from '@/types/assistant'
import type { MCPServer } from '@/types/mcp'
import type { MCPTool } from '@/types/tool'

import { assistantService } from '../AssistantService'
import { loggerService } from '../LoggerService'
import { mcpService } from '../McpService'
import { mcpClientService } from './McpClientService'

const logger = loggerService.withContext('McpMarketplaceInstallService')

type McpServiceDependency = Pick<
  typeof mcpService,
  'createMcpServer' | 'getAllMcpServers' | 'getMcpServer' | 'getMcpTools' | 'invalidateToolsCache' | 'updateMcpServer'
>

type AssistantServiceDependency = Pick<typeof assistantService, 'getAssistant' | 'updateAssistant'>

type McpClientDependency = Pick<typeof mcpClientService, 'invalidateToolsCache' | 'listTools'>

export interface McpMarketplaceInstallDependencies {
  mcpService: McpServiceDependency
  assistantService: AssistantServiceDependency
  mcpClientService: McpClientDependency
}

export interface McpMarketplaceInstallOptions {
  /** Assistant that opened the marketplace. When supplied, installation also enables the MCP for that assistant. */
  assistantId?: Assistant['id']
}

export interface McpMarketplaceInstallResult {
  server: MCPServer
  tools: MCPTool[]
  alreadyInstalled: boolean
  assistantAttachmentRequested: boolean
  attachedToAssistant: boolean
  toolDiscoveryFailed: boolean
  /** Sanitized transport/protocol error suitable for showing in the UI. */
  toolDiscoveryError?: string
}

function sanitizeDiscoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|authorization|token)["']?\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined

  try {
    const url = new URL(value)
    url.hash = ''
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '')
    }
    return url.toString()
  } catch {
    return value.trim().replace(/\/+$/, '')
  }
}

function isSameMarketplaceServer(existing: MCPServer, candidate: MCPServer): boolean {
  if (existing.id === candidate.id) return true

  if (candidate.provider && candidate.providerUrl) {
    if (existing.provider === candidate.provider && existing.providerUrl === candidate.providerUrl) {
      return true
    }
  }

  const existingEndpoint = normalizeEndpoint(existing.baseUrl)
  const candidateEndpoint = normalizeEndpoint(candidate.baseUrl)
  return Boolean(candidateEndpoint && existingEndpoint === candidateEndpoint)
}

/**
 * Completes the marketplace install transaction at the application layer:
 * persist/reactivate the server, verify the database round trip, discover its
 * tools, then attach it to the assistant that initiated the install.
 */
export class McpMarketplaceInstallService {
  constructor(
    private readonly dependencies: McpMarketplaceInstallDependencies = {
      mcpService,
      assistantService,
      mcpClientService
    }
  ) {}

  async install(
    candidate: MCPServer,
    options: McpMarketplaceInstallOptions = {}
  ): Promise<McpMarketplaceInstallResult> {
    // Adding a market preset is also an explicit enable action. Presets stay
    // inactive until this point so an app update never adds network access to
    // an Agent behind the user's back.
    const activeCandidate: MCPServer = { ...candidate, isActive: true }
    const existingServers = await this.dependencies.mcpService.getAllMcpServers()
    const existing = existingServers.find(server => isSameMarketplaceServer(server, activeCandidate))
    const alreadyInstalled = Boolean(existing)

    let installed = existing
    if (!installed) {
      installed = await this.dependencies.mcpService.createMcpServer(activeCandidate)
    } else {
      // Re-installation must refresh endpoint/header configuration. Otherwise
      // correcting a token or a registry deployment URL would keep using the
      // stale client configuration forever. Existing per-tool and trust
      // preferences survive because the marketplace candidate does not
      // overwrite them.
      const refreshed: MCPServer = {
        ...installed,
        ...activeCandidate,
        id: installed.id,
        headers: activeCandidate.headers,
        disabledTools: installed.disabledTools ?? activeCandidate.disabledTools,
        disabledAutoApproveTools: installed.disabledAutoApproveTools ?? activeCandidate.disabledAutoApproveTools,
        isTrusted: installed.isTrusted ?? activeCandidate.isTrusted,
        trustedAt: installed.trustedAt ?? activeCandidate.trustedAt,
        installedAt: installed.installedAt ?? activeCandidate.installedAt,
        isActive: true
      }
      const { id: _serverId, ...updates } = refreshed
      await this.dependencies.mcpService.updateMcpServer(installed.id, updates)
      installed = refreshed
    }

    const persisted = await this.dependencies.mcpService.getMcpServer(installed.id)
    if (!persisted) {
      throw new Error(`Marketplace MCP ${installed.id} was not available after persistence.`)
    }

    this.dependencies.mcpService.invalidateToolsCache(persisted.id)
    this.dependencies.mcpClientService.invalidateToolsCache(persisted.id)

    let tools: MCPTool[] = []
    let toolDiscoveryFailed = false
    let toolDiscoveryError: string | undefined
    try {
      tools =
        persisted.type === 'inMemory'
          ? await this.dependencies.mcpService.getMcpTools(persisted.id, true)
          : await this.dependencies.mcpClientService.listTools(persisted)
    } catch (error) {
      // The server is still installed so OAuth or temporary connectivity can
      // be repaired from its detail screen. Do not turn a successful database
      // write into a misleading total-install failure.
      toolDiscoveryFailed = true
      toolDiscoveryError = sanitizeDiscoveryError(error) || 'Unknown MCP discovery error'
      logger.warn('Marketplace MCP was installed but initial tool discovery failed', {
        serverId: persisted.id,
        error: toolDiscoveryError
      })
    }

    const assistantAttachmentRequested = Boolean(options.assistantId)
    let attachedToAssistant = false
    if (options.assistantId) {
      try {
        const assistant = await this.dependencies.assistantService.getAssistant(options.assistantId)
        if (assistant) {
          const currentServers = assistant.mcpServers ?? []
          const nextServers = [
            ...currentServers.filter(
              server => server.id !== persisted.id && !isSameMarketplaceServer(server, persisted)
            ),
            persisted
          ]
          await this.dependencies.assistantService.updateAssistant(assistant.id, { mcpServers: nextServers })
          attachedToAssistant = true
        }
      } catch {
        logger.warn('Marketplace MCP was installed but could not be attached to the requesting assistant', {
          serverId: persisted.id,
          assistantId: options.assistantId
        })
      }
    }

    return {
      server: persisted,
      tools,
      alreadyInstalled,
      assistantAttachmentRequested,
      attachedToAssistant,
      toolDiscoveryFailed,
      toolDiscoveryError
    }
  }
}

export const mcpMarketplaceInstallService = new McpMarketplaceInstallService()
