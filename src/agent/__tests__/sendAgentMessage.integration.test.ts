import type { Assistant, Model } from '@/types/assistant'
import type { Message, MessageBlock } from '@/types/message'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType, UserMessageStatus } from '@/types/message'
import { abortMap } from '@/utils/abortController'

import { regenerateAgentMessage, sendAgentMessage } from '../sendAgentMessage'

const mockMessages = new Map<string, Message>()
const mockBlocks = new Map<string, MessageBlock>()
const mockPromptTexts: string[] = []
const mockAgentConstruction = jest.fn()
const mockUpdateTopic = jest.fn()
const mockFetchTopicNaming = jest.fn()
const mockMessagesToPiContext = jest.fn(async (_messages: Message[], _model: Model) => [])
const mockCreateMcpTools = jest.fn(async (_assistant: Assistant): Promise<unknown[]> => [])
let mockAgentScenario: 'success' | 'error' | 'missing-terminal' = 'success'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const mockMessageDatabase = {
  upsertMessages: jest.fn(async (input: Message | Message[]) => {
    const messages = Array.isArray(input) ? input : [input]
    const saved = messages.map(message => {
      const stored = clone(message)
      mockMessages.set(stored.id, stored)
      return clone(stored)
    })
    return saved
  }),
  getMessageById: jest.fn(async (id: string) => {
    const message = mockMessages.get(id)
    return message ? clone(message) : undefined
  }),
  getMessagesByTopicId: jest.fn(async (topicId: string) =>
    Array.from(mockMessages.values())
      .filter(message => message.topicId === topicId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone)
  ),
  updateMessageById: jest.fn(async (id: string, changes: Partial<Message>) => {
    const existing = mockMessages.get(id)
    if (!existing) return undefined

    const updated = { ...existing, ...clone(changes) }
    mockMessages.set(id, updated)
    return clone(updated)
  })
}

const mockMessageBlockDatabase = {
  upsertBlocks: jest.fn(async (input: MessageBlock | MessageBlock[]) => {
    const blocks = Array.isArray(input) ? input : [input]
    for (const block of blocks) {
      const stored = clone(block)
      mockBlocks.set(stored.id, stored)

      const message = mockMessages.get(stored.messageId)
      if (message && !message.blocks.includes(stored.id)) {
        mockMessages.set(stored.messageId, { ...message, blocks: [...message.blocks, stored.id] })
      }
    }
  }),
  updateOneBlock: jest.fn(async ({ id, changes }: { id: string; changes: Partial<MessageBlock> }) => {
    const existing = mockBlocks.get(id)
    if (!existing) return null

    const updated = { ...existing, ...clone(changes) } as MessageBlock
    mockBlocks.set(id, updated)
    return clone(updated)
  }),
  getBlockById: jest.fn(async (id: string) => {
    const block = mockBlocks.get(id)
    return block ? clone(block) : null
  }),
  removeManyBlocks: jest.fn(async (ids: string[]) => {
    for (const id of ids) mockBlocks.delete(id)
  })
}

const mockSaveMessageAndBlocksToDB = jest.fn(async (message: Message, blocks: MessageBlock[]) => {
  await mockMessageDatabase.upsertMessages(message)
  if (blocks.length > 0) {
    await mockMessageBlockDatabase.upsertBlocks(blocks)
  }
})
const mockSaveUpdatesToDB = jest.fn(async (messageId: string, _topicId: string, updates: Partial<Message>) => {
  await mockMessageDatabase.updateMessageById(messageId, updates)
})

class MockAgentService {
  private listeners = new Set<(event: unknown) => void | Promise<void>>()

  constructor(
    model: Model,
    provider: unknown,
    tools: unknown[],
    _systemPrompt?: string,
    _historyMessages?: unknown[],
    _requestAssistant?: Assistant
  ) {
    mockAgentConstruction(model, provider, tools)
  }

  subscribe(listener: (event: unknown) => void | Promise<void>) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async prompt(input: string | { content: { type: string; text?: string }[] }) {
    mockPromptTexts.push(
      typeof input === 'string'
        ? input
        : input.content
            .filter(part => part.type === 'text')
            .map(part => part.text ?? '')
            .join('')
    )

    const events =
      mockAgentScenario === 'success'
        ? [
            { type: 'agent_start' },
            {
              type: 'message_update',
              assistantMessageEvent: {
                type: 'text_delta',
                partial: { content: [{ type: 'text', text: '模拟响应' }] }
              }
            },
            {
              type: 'message_end',
              message: { role: 'assistant', content: [{ type: 'text', text: '模拟响应' }] }
            },
            { type: 'agent_end', messages: [] }
          ]
        : mockAgentScenario === 'error'
          ? [
              { type: 'agent_start' },
              {
                type: 'agent_end',
                messages: [{ stopReason: 'error', errorMessage: '模拟 Provider 请求失败' }]
              }
            ]
          : [
              { type: 'agent_start' },
              {
                type: 'message_update',
                assistantMessageEvent: {
                  type: 'text_delta',
                  partial: { content: [{ type: 'text', text: '未正确结束的响应' }] }
                }
              },
              {
                type: 'message_end',
                message: { role: 'assistant', content: [{ type: 'text', text: '未正确结束的响应' }] }
              }
            ]

    for (const event of events) {
      for (const listener of this.listeners) {
        await listener(event)
      }
    }
  }

  abort() {}
}

jest.mock('@database', () => ({
  messageDatabase: {
    upsertMessages: (...args: Parameters<typeof mockMessageDatabase.upsertMessages>) =>
      mockMessageDatabase.upsertMessages(...args),
    getMessageById: (...args: Parameters<typeof mockMessageDatabase.getMessageById>) =>
      mockMessageDatabase.getMessageById(...args),
    getMessagesByTopicId: (...args: Parameters<typeof mockMessageDatabase.getMessagesByTopicId>) =>
      mockMessageDatabase.getMessagesByTopicId(...args),
    updateMessageById: (...args: Parameters<typeof mockMessageDatabase.updateMessageById>) =>
      mockMessageDatabase.updateMessageById(...args)
  },
  messageBlockDatabase: {
    upsertBlocks: (...args: Parameters<typeof mockMessageBlockDatabase.upsertBlocks>) =>
      mockMessageBlockDatabase.upsertBlocks(...args),
    updateOneBlock: (...args: Parameters<typeof mockMessageBlockDatabase.updateOneBlock>) =>
      mockMessageBlockDatabase.updateOneBlock(...args),
    getBlockById: (...args: Parameters<typeof mockMessageBlockDatabase.getBlockById>) =>
      mockMessageBlockDatabase.getBlockById(...args),
    removeManyBlocks: (...args: Parameters<typeof mockMessageBlockDatabase.removeManyBlocks>) =>
      mockMessageBlockDatabase.removeManyBlocks(...args)
  }
}))

jest.mock('@/agent/AgentService', () => ({
  AgentService: function (...args: ConstructorParameters<typeof MockAgentService>) {
    return new MockAgentService(...args)
  }
}))
jest.mock('@/agent/messagesToPiContext', () => ({
  messagesToPiContext: (messages: Message[], model: Model) => mockMessagesToPiContext(messages, model),
  messageToPiUserMessage: async (message: Message) => ({
    role: 'user',
    content: message.blocks
      .map(blockId => mockBlocks.get(blockId))
      .filter((block): block is MessageBlock => block?.type === 'main_text')
      .map(block => ({ type: 'text', text: 'content' in block ? String(block.content) : '' })),
    timestamp: message.createdAt
  })
}))
jest.mock('@/agent/oauth/oauthTools', () => ({ OAuthTool: {} }))
jest.mock('@/agent/toolAdapter', () => ({ aiSdkToolToAgentTool: jest.fn() }))
jest.mock('@/aiCore/tools/SystemTools', () => ({ SystemTool: {} }))
jest.mock('@/aiCore/tools/SystemTools/AndroidTools', () => ({ AndroidTool: {} }))
jest.mock('@/aiCore/tools/SystemTools/ApiTools', () => ({ ApiTool: {} }))
jest.mock('@/aiCore/tools/SystemTools/ComputeTools', () => ({ ComputeTool: {} }))
jest.mock('@/aiCore/tools/SystemTools/FeishuTools', () => ({ FeishuTool: {} }))
jest.mock('@/aiCore/tools/SystemTools/GithubTools', () => ({ GithubTool: {} }))
jest.mock('@/aiCore/tools/SystemTools/LlmTools', () => ({ createLlmTools: jest.fn(() => ({})) }))
jest.mock('@/aiCore/tools/SystemTools/McpTools', () => ({
  createMcpTools: (assistant: Assistant) => mockCreateMcpTools(assistant)
}))
jest.mock('@/aiCore/provider/providerConfig', () => ({
  getActualProvider: (_model: Model, provider: { apiHost: string }) => ({
    ...provider,
    apiHost: provider.apiHost.endsWith('/') ? provider.apiHost : `${provider.apiHost}/v1/`
  })
}))
// Simulate a custom provider/model name that the built-in capability table
// cannot recognize. Explicit function mode must still enable its tools.
jest.mock('@/config/models', () => ({ isFunctionCallingModel: () => false }))
jest.mock('@/services/ApiService', () => ({
  fetchTopicNaming: (...args: Parameters<typeof mockFetchTopicNaming>) => mockFetchTopicNaming(...args)
}))
jest.mock('@/services/AssistantService', () => ({
  getAssistantModel: (assistant: Pick<Assistant, 'model' | 'defaultModel'>) =>
    assistant.model ?? assistant.defaultModel,
  getAssistantSettings: (assistant: Assistant) => ({ contextCount: 20, ...assistant.settings })
}))
jest.mock('@/services/ConversationService', () => ({
  ConversationService: {
    filterMessagesPipeline: (messages: Message[]) => messages
  }
}))
jest.mock('@/services/MessagesService', () => ({
  saveMessageAndBlocksToDB: (...args: Parameters<typeof mockSaveMessageAndBlocksToDB>) =>
    mockSaveMessageAndBlocksToDB(...args),
  saveUpdatedBlockToDB: jest.fn(async () => undefined),
  saveUpdatesToDB: (...args: Parameters<typeof mockSaveUpdatesToDB>) => mockSaveUpdatesToDB(...args),
  throttledBlockUpdate: jest.fn(async (id: string, changes: Partial<MessageBlock>) => {
    await mockMessageBlockDatabase.updateOneBlock({ id, changes })
  }),
  cancelThrottledBlockUpdate: jest.fn(async () => undefined),
  cleanupMultipleBlocks: jest.fn(async () => undefined)
}))
jest.mock('@/services/ProviderService', () => ({
  getAssistantProvider: jest.fn(async () => ({ id: 'mock-provider', apiHost: 'https://mock.invalid' }))
}))
jest.mock('@/services/TokenService', () => ({ estimateMessagesUsage: jest.fn(async () => undefined) }))
jest.mock('@/services/TopicService', () => ({
  topicService: {
    updateTopic: (...args: Parameters<typeof mockUpdateTopic>) => mockUpdateTopic(...args)
  }
}))
jest.mock('@/services/FileService', () => ({ writeBase64File: jest.fn() }))
jest.mock('ai', () => ({ NoObjectGeneratedError: { isInstance: () => false } }))

const model: Model = {
  id: 'mock-model',
  name: 'Mock Model',
  provider: 'mock-provider',
  group: 'default'
}

const assistant: Assistant = {
  id: 'assistant-1',
  name: 'Default assistant',
  prompt: 'You are helpful.',
  topics: [],
  type: 'system',
  // Deliberately leave model empty: the production default assistant relies
  // on defaultModel, which is the path that originally could fail silently.
  defaultModel: model
}

const makeUserMessage = (): { message: Message; blocks: MessageBlock[] } => {
  const message: Message = {
    id: 'user-1',
    role: 'user',
    assistantId: assistant.id,
    topicId: 'topic-1',
    createdAt: 1,
    status: UserMessageStatus.SUCCESS,
    blocks: ['user-text-1']
  }
  const block: MessageBlock = {
    id: 'user-text-1',
    messageId: message.id,
    type: MessageBlockType.MAIN_TEXT,
    content: '请给我一句测试回复。',
    createdAt: 1,
    status: MessageBlockStatus.SUCCESS
  }

  return { message, blocks: [block] }
}

describe('sendAgentMessage simulated main flow', () => {
  beforeEach(() => {
    mockMessages.clear()
    mockBlocks.clear()
    mockPromptTexts.length = 0
    mockAgentScenario = 'success'
    abortMap.clear()
    jest.clearAllMocks()
    mockUpdateTopic.mockResolvedValue(undefined)
    mockFetchTopicNaming.mockResolvedValue(undefined)
  })

  it('persists a simulated streamed response, completes the assistant message, and cleans up the session', async () => {
    const { message, blocks } = makeUserMessage()

    await sendAgentMessage(message, blocks, assistant, message.topicId)

    const assistantMessage = Array.from(mockMessages.values()).find(candidate => candidate.role === 'assistant')
    const textBlock = Array.from(mockBlocks.values()).find(
      block => block.type === MessageBlockType.MAIN_TEXT && block.messageId === assistantMessage?.id
    )

    expect(mockPromptTexts).toEqual(['请给我一句测试回复。'])
    expect(mockMessagesToPiContext).toHaveBeenCalledWith([], model)
    expect(mockCreateMcpTools).not.toHaveBeenCalled()
    expect(mockAgentConstruction).toHaveBeenCalledWith(
      model,
      expect.objectContaining({ apiHost: 'https://mock.invalid/v1/' }),
      []
    )
    expect(assistantMessage).toMatchObject({
      askId: message.id,
      model,
      status: AssistantMessageStatus.SUCCESS
    })
    expect(textBlock).toMatchObject({
      messageId: assistantMessage?.id,
      content: '模拟响应',
      status: MessageBlockStatus.SUCCESS
    })
    expect(mockUpdateTopic).toHaveBeenNthCalledWith(1, message.topicId, { isLoading: true })
    expect(mockUpdateTopic).toHaveBeenLastCalledWith(message.topicId, { isLoading: false })
    expect(mockFetchTopicNaming).toHaveBeenCalledWith(message.topicId)
    expect(abortMap.has(message.id)).toBe(false)
  })

  it('injects discovered MCP tools while keeping the core Agent response working', async () => {
    const { message, blocks } = makeUserMessage()
    const assistantWithMcp: Assistant = {
      ...assistant,
      settings: { toolUseMode: 'function' },
      mcpServers: [{ id: 'mcp-1' } as NonNullable<Assistant['mcpServers']>[number]]
    }
    mockCreateMcpTools.mockResolvedValueOnce([
      {
        name: 'mcp_exa_web_search',
        label: 'Exa · web_search_exa',
        description: 'Search the web',
        parameters: { type: 'object', properties: {} },
        execute: jest.fn()
      }
    ])

    await sendAgentMessage(message, blocks, assistantWithMcp, message.topicId)

    const assistantMessage = Array.from(mockMessages.values()).find(candidate => candidate.role === 'assistant')
    const textBlock = Array.from(mockBlocks.values()).find(
      block => block.type === MessageBlockType.MAIN_TEXT && block.messageId === assistantMessage?.id
    )

    expect(mockCreateMcpTools).toHaveBeenCalledWith(
      expect.objectContaining({
        id: assistantWithMcp.id,
        model,
        mcpServers: assistantWithMcp.mcpServers,
        settings: assistantWithMcp.settings
      })
    )
    expect(mockAgentConstruction).toHaveBeenCalledWith(
      model,
      expect.any(Object),
      expect.arrayContaining([expect.objectContaining({ name: 'mcp_exa_web_search' })])
    )
    expect(assistantMessage?.status).toBe(AssistantMessageStatus.SUCCESS)
    expect(textBlock).toMatchObject({ content: '模拟响应', status: MessageBlockStatus.SUCCESS })
    expect(mockUpdateTopic).toHaveBeenLastCalledWith(message.topicId, { isLoading: false })
  })

  it('registers MCP tools for an unrecognised custom model without requiring toolUseMode', async () => {
    const { message, blocks } = makeUserMessage()
    const assistantWithMcp: Assistant = {
      ...assistant,
      // This intentionally has no settings.toolUseMode. The mocked model is
      // also absent from the built-in function-calling capability table.
      mcpServers: [{ id: 'mcp-1' } as NonNullable<Assistant['mcpServers']>[number]]
    }
    mockCreateMcpTools.mockResolvedValueOnce([
      {
        name: 'mcp_exa_web_search',
        label: 'Exa · web_search_exa',
        description: 'Search the web',
        parameters: { type: 'object', properties: {} },
        execute: jest.fn()
      }
    ])

    await sendAgentMessage(message, blocks, assistantWithMcp, message.topicId)

    expect(mockCreateMcpTools).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServers: assistantWithMcp.mcpServers })
    )
    expect(mockAgentConstruction).toHaveBeenCalledWith(
      model,
      expect.any(Object),
      expect.arrayContaining([expect.objectContaining({ name: 'mcp_exa_web_search' })])
    )
  })

  it('surfaces a simulated provider failure as an error block instead of leaving the conversation loading', async () => {
    mockAgentScenario = 'error'
    const { message, blocks } = makeUserMessage()

    await sendAgentMessage(message, blocks, assistant, message.topicId)

    const assistantMessage = Array.from(mockMessages.values()).find(candidate => candidate.role === 'assistant')
    const errorBlock = Array.from(mockBlocks.values()).find(block => block.type === MessageBlockType.ERROR)

    expect(assistantMessage?.status).toBe(AssistantMessageStatus.ERROR)
    expect(errorBlock).toMatchObject({
      messageId: assistantMessage?.id,
      error: expect.objectContaining({ message: '模拟 Provider 请求失败' })
    })
    expect(mockSaveUpdatesToDB).toHaveBeenCalledWith(
      assistantMessage?.id,
      message.topicId,
      { status: AssistantMessageStatus.ERROR },
      []
    )
    expect(mockUpdateTopic).toHaveBeenLastCalledWith(message.topicId, { isLoading: false })
    expect(abortMap.has(message.id)).toBe(false)
  })

  it('treats a missing agent_end event as a protocol error instead of synthesizing success', async () => {
    mockAgentScenario = 'missing-terminal'
    const { message, blocks } = makeUserMessage()

    await sendAgentMessage(message, blocks, assistant, message.topicId)

    const assistantMessage = Array.from(mockMessages.values()).find(candidate => candidate.role === 'assistant')
    const errorBlock = Array.from(mockBlocks.values()).find(block => block.type === MessageBlockType.ERROR)

    expect(assistantMessage?.status).toBe(AssistantMessageStatus.ERROR)
    expect(errorBlock).toMatchObject({
      messageId: assistantMessage?.id,
      error: expect.objectContaining({
        message: 'The agent session ended without a terminal event.'
      })
    })
    expect(mockUpdateTopic).toHaveBeenLastCalledWith(message.topicId, { isLoading: false })
    expect(abortMap.has(message.id)).toBe(false)
  })

  it('rejects regeneration when the original user message is missing', async () => {
    const missingSourceMessage: Message = {
      id: 'assistant-missing-source',
      role: 'assistant',
      assistantId: assistant.id,
      topicId: 'topic-1',
      askId: 'missing-user',
      createdAt: 2,
      status: AssistantMessageStatus.SUCCESS,
      blocks: []
    }
    mockMessages.set(missingSourceMessage.id, missingSourceMessage)

    await expect(regenerateAgentMessage(missingSourceMessage, assistant)).rejects.toThrow(
      'Original user query missing-user not found'
    )
  })
})
