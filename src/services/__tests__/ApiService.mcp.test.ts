import type { Assistant } from '@/types/assistant'
import type { MCPServer } from '@/types/mcp'

import { fetchAssistantMcpTools } from '../ApiService'

const mockGetMcpServer = jest.fn()
const mockGetMcpTools = jest.fn()

jest.mock('@database', () => ({ messageDatabase: {} }))
jest.mock('i18next', () => ({ t: jest.fn() }))
jest.mock('@/i18n', () => ({ __esModule: true, default: { t: jest.fn() } }))
jest.mock('@/aiCore', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('@/aiCore/index_new', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('@/aiCore/prepareParams', () => ({ buildStreamTextParams: jest.fn() }))
jest.mock('@/config/models', () => ({ isDedicatedImageGenerationModel: jest.fn(), isEmbeddingModel: jest.fn() }))
jest.mock('@/services/AssistantService', () => ({
  assistantService: {},
  getAssistantModel: jest.fn(),
  getDefaultModel: jest.fn()
}))
jest.mock('@/services/LoggerService', () => ({
  loggerService: {
    withContext: () => ({
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn()
    })
  }
}))
jest.mock('@/services/McpService', () => ({
  mcpService: {
    getMcpServer: (...args: unknown[]) => mockGetMcpServer(...args),
    getMcpTools: (...args: unknown[]) => mockGetMcpTools(...args)
  }
}))
jest.mock('@/services/ProviderService', () => ({ getAssistantProvider: jest.fn() }))
jest.mock('@/services/StreamProcessingService', () => ({ createStreamProcessor: jest.fn() }))
jest.mock('@/services/TopicService', () => ({ topicService: {} }))
jest.mock('@/utils/mcpTool', () => ({ isPromptToolUse: jest.fn(), isSupportedToolUse: jest.fn() }))
jest.mock('@/utils/messageUtils/find', () => ({ findFileBlocks: jest.fn(), getMainTextContent: jest.fn() }))
jest.mock('@/utils/providerUtils', () => ({ hasApiKey: jest.fn() }))

const assistant: Assistant = {
  id: 'assistant-1',
  name: 'Agent',
  prompt: '',
  type: 'system',
  topics: [],
  mcpServers: [{ id: 'server-1' } as MCPServer]
}

const server: MCPServer = {
  id: 'server-1',
  name: 'Remote Search',
  type: 'streamableHttp',
  baseUrl: 'https://example.com/mcp',
  isActive: true
}

describe('fetchAssistantMcpTools', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetMcpServer.mockResolvedValue(server)
    mockGetMcpTools.mockResolvedValue([
      {
        id: 'mcp:server-1:search',
        serverId: server.id,
        serverName: server.name,
        name: 'search',
        type: 'mcp'
      }
    ])
  })

  it('resolves bound servers by assistant ID instead of the global active-server snapshot', async () => {
    await expect(fetchAssistantMcpTools(assistant)).resolves.toEqual([
      expect.objectContaining({ serverId: server.id, name: 'search' })
    ])

    expect(mockGetMcpServer).toHaveBeenCalledWith(server.id)
    expect(mockGetMcpTools).toHaveBeenCalledWith(server.id)
  })

  it('does not let one stalled MCP server block Agent startup indefinitely', async () => {
    mockGetMcpTools.mockImplementationOnce(() => new Promise(() => undefined))

    const startedAt = Date.now()
    await expect(fetchAssistantMcpTools(assistant, { perServerTimeoutMs: 5 })).resolves.toEqual([])

    expect(Date.now() - startedAt).toBeLessThan(250)
  })
})
