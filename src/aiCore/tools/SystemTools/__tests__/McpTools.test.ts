import type { Assistant } from '@/types/assistant'

import { createMcpTools } from '../McpTools'

const mockFetchAssistantMcpTools = jest.fn()
const mockGetMcpServer = jest.fn()
const mockCallTool = jest.fn()

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
    expect(mockCallTool).toHaveBeenCalledWith(expect.objectContaining({ id: 'server:remote' }), 'search.web/v2', {
      query: 'Cherry'
    })
  })

  it('propagates remote MCP tool failures into the agent loop', async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'remote failure' }], isError: true })
    const [tool] = await createMcpTools(assistant)

    await expect(tool.execute('call-1', {}, new AbortController().signal, jest.fn())).rejects.toThrow('remote failure')
  })
})
