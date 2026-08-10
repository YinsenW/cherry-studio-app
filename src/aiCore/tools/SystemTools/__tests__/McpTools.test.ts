import type { Assistant } from '@/types/assistant'

import { createMcpTools } from '../McpTools'

const mockFetchAssistantMcpTools = jest.fn()
const mockGetMcpServer = jest.fn()
const mockCallTool = jest.fn()
const mockBuiltinExecute = jest.fn(async () => ({
  content: [{ type: 'text' as const, text: '2026-08-10 12:00:00' }],
  details: { source: 'local-time' }
}))
const mockAiSdkToolToAgentTool = jest.fn((name: string, _tool?: unknown) => ({
  name,
  label: name,
  description: 'Local built-in tool',
  parameters: { type: 'object', properties: {} },
  execute: mockBuiltinExecute
}))

jest.mock('@/agent/toolAdapter', () => ({
  aiSdkToolToAgentTool: (name: string, tool: unknown) => mockAiSdkToolToAgentTool(name, tool)
}))
jest.mock('@/aiCore/tools/SystemTools', () => ({
  SystemTool: { GetCurrentTime: { description: 'Get current time' } }
}))

jest.mock('@/services/ApiService', () => ({
  fetchAssistantMcpTools: (...args: unknown[]) => mockFetchAssistantMcpTools(...args)
}))
jest.mock('@/services/McpService', () => ({
  mcpService: { getMcpServer: (...args: unknown[]) => mockGetMcpServer(...args) }
}))
jest.mock('@/services/mcp/McpClientService', () => ({
  mcpClientService: { callTool: (...args: unknown[]) => mockCallTool(...args) }
}))

const assistant: Assistant = {
  id: 'assistant-1',
  name: 'Agent',
  prompt: '',
  type: 'system',
  topics: []
}

describe('createMcpTools', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetchAssistantMcpTools.mockResolvedValue([
      {
        id: 'tool-1',
        serverId: 'server:remote',
        name: 'search.web/v2',
        description: 'Search the web',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
      }
    ])
    mockGetMcpServer.mockResolvedValue({
      id: 'server:remote',
      name: 'Remote Search',
      type: 'streamableHttp'
    })
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'result' }], isError: false })
  })

  it('creates provider-compatible names while calling the original remote tool', async () => {
    const [tool] = await createMcpTools(assistant)

    expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    await expect(tool.execute('call-1', { query: 'Cherry' }, new AbortController().signal, jest.fn())).resolves.toEqual(
      expect.objectContaining({ content: [{ type: 'text', text: 'result' }] })
    )
    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'server:remote' }),
      'search.web/v2',
      { query: 'Cherry' },
      expect.any(AbortSignal)
    )
  })

  it('propagates remote MCP tool failures into the agent loop', async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'remote failure' }], isError: true })
    const [tool] = await createMcpTools(assistant)

    await expect(tool.execute('call-1', {}, new AbortController().signal, jest.fn())).rejects.toThrow('remote failure')
  })

  it('keeps valid tools when another discovered tool is malformed', async () => {
    mockFetchAssistantMcpTools.mockResolvedValueOnce([
      {
        id: 'tool-bad',
        serverId: 'server:remote',
        name: undefined,
        inputSchema: { type: 'object', properties: {} }
      },
      {
        id: 'tool-good',
        serverId: 'server:remote',
        name: 'search.web/v2',
        inputSchema: { type: 'object', properties: {} }
      }
    ])

    const tools = await createMcpTools(assistant)

    expect(tools).toHaveLength(1)
    expect(tools[0].name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('registers and executes an attached in-memory MCP through its local SystemTool implementation', async () => {
    mockFetchAssistantMcpTools.mockResolvedValueOnce([
      {
        id: 'builtin-time',
        serverId: '@cherry/time',
        serverName: '@cherry/time',
        name: 'GetCurrentTime',
        description: 'Get current time',
        isBuiltIn: true,
        inputSchema: { type: 'object', properties: {} }
      }
    ])
    mockGetMcpServer.mockResolvedValueOnce({
      id: '@cherry/time',
      name: '@cherry/time',
      type: 'inMemory',
      isActive: true
    })

    const [tool] = await createMcpTools(assistant)

    expect(tool).toMatchObject({
      name: 'GetCurrentTime',
      label: '@cherry/time · GetCurrentTime',
      description: 'Get current time'
    })
    await expect(tool.execute('call-time', {}, new AbortController().signal, jest.fn())).resolves.toEqual(
      expect.objectContaining({ content: [{ type: 'text', text: '2026-08-10 12:00:00' }] })
    )
    expect(mockAiSdkToolToAgentTool).toHaveBeenCalledWith(
      'GetCurrentTime',
      expect.objectContaining({ description: 'Get current time' })
    )
    expect(mockCallTool).not.toHaveBeenCalled()
  })
})
