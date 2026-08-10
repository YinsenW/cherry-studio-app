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
  id: 'assistant-local-mcp',
  name: 'Agent',
  prompt: '',
  type: 'system',
  topics: [],
  mcpServers: [{ id: '@cherry/time' } as NonNullable<Assistant['mcpServers']>[number]]
}

describe('local MCP Agent bridge integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetchAssistantMcpTools.mockResolvedValue([
      {
        id: 'builtin-time',
        serverId: '@cherry/time',
        serverName: '@cherry/time',
        name: 'GetCurrentTime',
        description: 'Get current time and date',
        isBuiltIn: true,
        inputSchema: { type: 'object', properties: {} }
      }
    ])
    mockGetMcpServer.mockResolvedValue({
      id: '@cherry/time',
      name: '@cherry/time',
      type: 'inMemory',
      isActive: true
    })
  })

  it('executes the real @cherry/time implementation through an AgentTool', async () => {
    const [tool] = await createMcpTools(assistant)

    expect(tool.name).toBe('GetCurrentTime')
    const result = await tool.execute('call-time', {}, new AbortController().signal, jest.fn())
    const block = result.content[0]
    expect(block.type).toBe('text')
    if (block.type !== 'text') throw new Error('Expected a text Agent tool result')
    expect(JSON.parse(block.text)).toEqual({ time: expect.any(String) })
    expect(mockCallTool).not.toHaveBeenCalled()
  })
})
