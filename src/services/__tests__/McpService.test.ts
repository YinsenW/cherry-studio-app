import type { MCPServer } from '@/types/mcp'
import type { MCPTool } from '@/types/tool'

import { McpService } from '../McpService'

const mockUpsertMcps = jest.fn()

jest.mock('@database', () => ({
  mcpDatabase: {
    upsertMcps: (...args: unknown[]) => mockUpsertMcps(...args),
    getMcps: jest.fn(async () => []),
    getMcpById: jest.fn(async () => null),
    deleteMcpById: jest.fn(async () => undefined)
  }
}))

jest.mock('@/services/mcp/McpClientService', () => ({
  mcpClientService: {
    closeClient: jest.fn(async () => undefined),
    listTools: jest.fn(async () => []),
    callTool: jest.fn(),
    invalidateToolsCache: jest.fn()
  }
}))

const server: MCPServer = {
  id: 'marketplace-server',
  name: 'Marketplace Server',
  type: 'streamableHttp',
  baseUrl: 'https://example.com/mcp',
  isActive: true
}

function resetService(service: McpService) {
  const internals = service as unknown as {
    mcpCache: Map<string, MCPServer>
    accessOrder: string[]
    allMcpServersCache: Map<string, MCPServer>
    allMcpServersCacheTimestamp: number | null
    toolsCache: Map<string, { tools: MCPTool[]; timestamp: number }>
    mcpServerSubscribers: Map<string, Set<() => void>>
    globalSubscribers: Set<() => void>
    allMcpServersSubscribers: Set<() => void>
  }
  internals.mcpCache.clear()
  internals.accessOrder.length = 0
  internals.allMcpServersCache.clear()
  internals.allMcpServersCacheTimestamp = null
  internals.toolsCache.clear()
  internals.mcpServerSubscribers.clear()
  internals.globalSubscribers.clear()
  internals.allMcpServersSubscribers.clear()
}

describe('McpService marketplace persistence boundary', () => {
  const service = McpService.getInstance()

  beforeEach(() => {
    jest.clearAllMocks()
    resetService(service)
  })

  it('publishes a newly created server only after its database write succeeds', async () => {
    let completeWrite: (() => void) | undefined
    mockUpsertMcps.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          completeWrite = resolve
        })
    )
    const subscriber = jest.fn()
    service.subscribeMcpServer(server.id, subscriber)
    const creation = service.createMcpServer(server)

    expect(service.getMcpServerCached(server.id)).toBeNull()
    expect(subscriber).not.toHaveBeenCalled()

    completeWrite?.()
    await expect(creation).resolves.toEqual(server)

    expect(service.getMcpServerCached(server.id)).toEqual(server)
    expect(subscriber).toHaveBeenCalledTimes(1)
  })

  it('does not leave a ghost server in caches when persistence fails', async () => {
    mockUpsertMcps.mockRejectedValueOnce(new Error('database unavailable'))
    const subscriber = jest.fn()
    service.subscribeMcpServer(server.id, subscriber)

    await expect(service.createMcpServer(server)).rejects.toThrow('database unavailable')

    expect(service.getMcpServerCached(server.id)).toBeNull()
    expect(subscriber).not.toHaveBeenCalled()
  })

  it('binds static in-memory tools to the real persisted server ID', async () => {
    const builtin: MCPServer = {
      id: '@cherry/time',
      name: '@cherry/time',
      type: 'inMemory',
      isActive: true
    }
    await service.createMcpServer(builtin)

    const tools = await service.getMcpTools(builtin.id, true)

    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'GetCurrentTime',
          serverId: builtin.id,
          serverName: builtin.name,
          isBuiltIn: true
        })
      ])
    )
    expect(tools.every(tool => tool.serverId === builtin.id)).toBe(true)
  })
})
