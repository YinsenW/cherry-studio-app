import type { MCPServer } from '@/types/mcp'
import type { MCPTool } from '@/types/tool'

import { mcpClientService } from '../mcp/McpClientService'
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
    toolsLoadPromises: Map<string, Promise<MCPTool[]>>
    toolsCacheGenerations: Map<string, number>
    mcpServerSubscribers: Map<string, Set<() => void>>
    globalSubscribers: Set<() => void>
    allMcpServersSubscribers: Set<() => void>
  }
  internals.mcpCache.clear()
  internals.accessOrder.length = 0
  internals.allMcpServersCache.clear()
  internals.allMcpServersCacheTimestamp = null
  internals.toolsCache.clear()
  internals.toolsLoadPromises.clear()
  internals.toolsCacheGenerations.clear()
  internals.mcpServerSubscribers.clear()
  internals.globalSubscribers.clear()
  internals.allMcpServersSubscribers.clear()
  ;(global as typeof globalThis & { __mockStorageData?: Map<string, string> }).__mockStorageData?.clear()
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

  it('reuses the last successful remote tool snapshot after an app-memory restart', async () => {
    const remoteTools = [
      {
        id: 'remote-search',
        serverId: server.id,
        serverName: server.name,
        name: 'search',
        type: 'mcp',
        inputSchema: { type: 'object', properties: {} }
      }
    ] as MCPTool[]
    jest.mocked(mcpClientService.listTools).mockResolvedValueOnce(remoteTools)
    await service.createMcpServer(server)

    await expect(service.getMcpTools(server.id)).resolves.toEqual(remoteTools)

    const internals = service as unknown as { toolsCache: Map<string, unknown> }
    internals.toolsCache.clear()
    await expect(service.getMcpTools(server.id)).resolves.toEqual(remoteTools)

    expect(mcpClientService.listTools).toHaveBeenCalledTimes(1)
  })

  it('returns a stale remote snapshot immediately while refreshing it in the background', async () => {
    const oldTools = [
      {
        id: 'old-search',
        serverId: server.id,
        serverName: server.name,
        name: 'old_search',
        type: 'mcp',
        inputSchema: { type: 'object', properties: {} }
      }
    ] as MCPTool[]
    const refreshedTools = [{ ...oldTools[0], id: 'new-search', name: 'new_search' }] as MCPTool[]
    await service.createMcpServer(server)
    service.cacheMcpTools(server.id, oldTools, Date.now() - 10 * 60_000)

    let finishRefresh: ((tools: MCPTool[]) => void) | undefined
    jest.mocked(mcpClientService.listTools).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishRefresh = resolve
        })
    )

    await expect(service.getMcpTools(server.id)).resolves.toEqual(oldTools)
    expect(mcpClientService.listTools).toHaveBeenCalledTimes(1)

    finishRefresh?.(refreshedTools)
    await Promise.resolve()
    await Promise.resolve()

    await expect(service.getMcpTools(server.id)).resolves.toEqual(refreshedTools)
  })

  it('removes the durable tool snapshot when a server configuration is invalidated', async () => {
    await service.createMcpServer(server)
    service.cacheMcpTools(server.id, [])
    const storageData = (global as typeof globalThis & { __mockStorageData?: Map<string, string> }).__mockStorageData
    expect([...storageData!.keys()].some(key => key.endsWith(server.id))).toBe(true)

    service.invalidateToolsCache(server.id)

    expect([...storageData!.keys()].some(key => key.endsWith(server.id))).toBe(false)
  })

  it('keeps tool schemas hot when a full UI payload only changes active and disabled state', async () => {
    const remoteTools = [
      {
        id: 'remote-search',
        serverId: server.id,
        serverName: server.name,
        name: 'search',
        type: 'mcp',
        inputSchema: { type: 'object', properties: {} }
      }
    ] as MCPTool[]
    jest.mocked(mcpClientService.listTools).mockResolvedValueOnce(remoteTools)
    await service.createMcpServer(server)
    await service.getMcpTools(server.id)
    const fullUiUpdate = {
      name: server.name,
      type: server.type,
      baseUrl: server.baseUrl,
      headers: server.headers,
      isActive: false,
      disabledTools: ['search']
    }

    await service.updateMcpServer(server.id, fullUiUpdate)
    await expect(service.getMcpTools(server.id)).resolves.toEqual([])

    expect(mcpClientService.closeClient).not.toHaveBeenCalled()
    expect(mcpClientService.listTools).toHaveBeenCalledTimes(1)
  })
})
