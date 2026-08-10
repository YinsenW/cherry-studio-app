import type { Assistant } from '@/types/assistant'
import type { MCPServer } from '@/types/mcp'
import type { MCPTool } from '@/types/tool'

import { type McpMarketplaceInstallDependencies, McpMarketplaceInstallService } from '../McpMarketplaceInstallService'

jest.mock('@/services/AssistantService', () => ({
  assistantService: {
    getAssistant: jest.fn(),
    updateAssistant: jest.fn()
  }
}))

jest.mock('@/services/McpService', () => ({
  mcpService: {
    cacheMcpTools: jest.fn(),
    createMcpServer: jest.fn(),
    getAllMcpServers: jest.fn(),
    getMcpServer: jest.fn(),
    getMcpTools: jest.fn(),
    invalidateToolsCache: jest.fn(),
    updateMcpServer: jest.fn()
  }
}))

jest.mock('../McpClientService', () => ({
  mcpClientService: {
    invalidateToolsCache: jest.fn(),
    listTools: jest.fn()
  }
}))

const candidate: MCPServer = {
  id: 'marketplace-exa',
  name: 'Exa',
  type: 'streamableHttp',
  baseUrl: 'https://mcp.exa.ai/mcp',
  provider: 'Official MCP Registry',
  providerUrl: 'https://registry.modelcontextprotocol.io/v0.1/servers/ai.exa%2Fexa/versions/latest',
  isActive: true
}

const exaTools = [
  {
    id: 'mcp:marketplace-exa:web_search_exa',
    serverId: candidate.id,
    serverName: candidate.name,
    name: 'web_search_exa',
    type: 'mcp',
    isBuiltIn: false,
    inputSchema: { type: 'object', properties: {} }
  }
] as MCPTool[]

describe('McpMarketplaceInstallService', () => {
  let storedServer: MCPServer | null
  let assistant: Assistant
  let dependencies: McpMarketplaceInstallDependencies

  beforeEach(() => {
    storedServer = null
    assistant = {
      id: 'assistant-1',
      name: 'Agent',
      prompt: '',
      type: 'system',
      topics: [],
      mcpServers: []
    }

    dependencies = {
      mcpService: {
        cacheMcpTools: jest.fn(),
        getAllMcpServers: jest.fn(async () => (storedServer ? [storedServer] : [])),
        createMcpServer: jest.fn(async server => {
          storedServer = server
          return server
        }),
        getMcpServer: jest.fn(async () => storedServer),
        getMcpTools: jest.fn(async () => []),
        updateMcpServer: jest.fn(async (_id, updates) => {
          if (storedServer) storedServer = { ...storedServer, ...updates }
        }),
        invalidateToolsCache: jest.fn()
      },
      assistantService: {
        getAssistant: jest.fn(async () => assistant),
        updateAssistant: jest.fn(async (_id, updates) => {
          assistant = { ...assistant, ...updates }
        })
      },
      mcpClientService: {
        invalidateToolsCache: jest.fn(),
        listTools: jest.fn(async () => exaTools)
      }
    }
  })

  it('persists, discovers tools, and attaches a marketplace server to the requesting Agent', async () => {
    const service = new McpMarketplaceInstallService(dependencies)

    const result = await service.install(candidate, { assistantId: assistant.id })

    expect(dependencies.mcpService.createMcpServer).toHaveBeenCalledWith(candidate)
    expect(dependencies.mcpService.getMcpServer).toHaveBeenCalledWith(candidate.id)
    expect(dependencies.mcpClientService.listTools).toHaveBeenCalledWith(candidate)
    expect(dependencies.mcpService.cacheMcpTools).toHaveBeenCalledWith(candidate.id, exaTools)
    expect(dependencies.assistantService.updateAssistant).toHaveBeenCalledWith(assistant.id, {
      mcpServers: [candidate]
    })
    expect(result).toMatchObject({
      server: candidate,
      tools: exaTools,
      alreadyInstalled: false,
      assistantAttachmentRequested: true,
      attachedToAssistant: true,
      toolDiscoveryFailed: false
    })
  })

  it('refreshes, reactivates, and attaches an existing marketplace server instead of treating Add as a no-op', async () => {
    storedServer = {
      ...candidate,
      id: 'existing-exa',
      baseUrl: 'https://old.example/mcp',
      headers: { Authorization: 'Bearer expired' },
      disabledTools: ['web_fetch_exa'],
      isTrusted: true,
      trustedAt: 123,
      isActive: false
    }
    const service = new McpMarketplaceInstallService(dependencies)

    const result = await service.install(candidate, { assistantId: assistant.id })

    expect(dependencies.mcpService.createMcpServer).not.toHaveBeenCalled()
    expect(dependencies.mcpService.updateMcpServer).toHaveBeenCalledWith(
      'existing-exa',
      expect.objectContaining({
        baseUrl: candidate.baseUrl,
        headers: undefined,
        disabledTools: ['web_fetch_exa'],
        isTrusted: true,
        trustedAt: 123,
        isActive: true
      })
    )
    expect(dependencies.assistantService.updateAssistant).toHaveBeenCalledWith(assistant.id, {
      mcpServers: [
        expect.objectContaining({
          id: 'existing-exa',
          baseUrl: candidate.baseUrl,
          disabledTools: ['web_fetch_exa'],
          isTrusted: true,
          trustedAt: 123,
          isActive: true
        })
      ]
    })
    expect(result).toMatchObject({
      alreadyInstalled: true,
      attachedToAssistant: true,
      server: {
        id: 'existing-exa',
        baseUrl: candidate.baseUrl,
        disabledTools: ['web_fetch_exa'],
        isActive: true
      }
    })
  })

  it('keeps a persisted and attached server visible when initial tool discovery temporarily fails', async () => {
    jest.mocked(dependencies.mcpClientService.listTools).mockRejectedValueOnce(new Error('offline'))
    const service = new McpMarketplaceInstallService(dependencies)

    const result = await service.install(candidate, { assistantId: assistant.id })

    expect(result).toMatchObject({
      server: candidate,
      tools: [],
      attachedToAssistant: true,
      toolDiscoveryFailed: true,
      toolDiscoveryError: 'offline'
    })
    expect(dependencies.assistantService.updateAssistant).toHaveBeenCalled()
    expect(dependencies.mcpService.cacheMcpTools).not.toHaveBeenCalled()
  })

  it('redacts credentials before returning a tool discovery error to the UI', async () => {
    jest
      .mocked(dependencies.mcpClientService.listTools)
      .mockRejectedValueOnce(new Error('Authorization: Bearer super-secret-token'))
    const service = new McpMarketplaceInstallService(dependencies)

    const result = await service.install(candidate, { assistantId: assistant.id })

    expect(result.toolDiscoveryError).toContain('[REDACTED]')
    expect(result.toolDiscoveryError).not.toContain('super-secret-token')
  })

  it('reuses a manually added server with the same normalized endpoint', async () => {
    storedServer = {
      ...candidate,
      id: 'manual-exa',
      provider: 'Manual',
      providerUrl: undefined,
      baseUrl: 'https://mcp.exa.ai/mcp/',
      isActive: false
    }
    const service = new McpMarketplaceInstallService(dependencies)

    const result = await service.install(candidate, { assistantId: assistant.id })

    expect(dependencies.mcpService.createMcpServer).not.toHaveBeenCalled()
    expect(dependencies.mcpService.updateMcpServer).toHaveBeenCalledWith(
      'manual-exa',
      expect.objectContaining({ baseUrl: candidate.baseUrl, isActive: true })
    )
    expect(result.server.id).toBe('manual-exa')
  })

  it('enables, discovers, and attaches an in-memory preset without using the HTTP client', async () => {
    const builtin: MCPServer = {
      id: '@cherry/time',
      name: '@cherry/time',
      type: 'inMemory',
      isActive: false
    }
    const builtinTools = [
      {
        id: 'builtin-time',
        serverId: builtin.id,
        serverName: builtin.name,
        name: 'GetCurrentTime',
        type: 'mcp',
        isBuiltIn: true,
        inputSchema: { type: 'object', properties: {} }
      }
    ] as MCPTool[]
    jest.mocked(dependencies.mcpService.getMcpTools).mockResolvedValueOnce(builtinTools)
    const service = new McpMarketplaceInstallService(dependencies)

    const result = await service.install(builtin, { assistantId: assistant.id })

    expect(dependencies.mcpService.createMcpServer).toHaveBeenCalledWith({ ...builtin, isActive: true })
    expect(dependencies.mcpService.getMcpTools).toHaveBeenCalledWith(builtin.id, true)
    expect(dependencies.mcpService.cacheMcpTools).toHaveBeenCalledWith(builtin.id, builtinTools)
    expect(dependencies.mcpClientService.listTools).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      tools: builtinTools,
      attachedToAssistant: true,
      toolDiscoveryFailed: false,
      server: { id: builtin.id, isActive: true }
    })
  })
})
