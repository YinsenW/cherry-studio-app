import type { Topic } from '@/types/assistant'
import type { Message, MessageBlock } from '@/types/message'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType, UserMessageStatus } from '@/types/message'

jest.mock('@database', () => ({
  messageDatabase: { getAssistantMessagesByStatuses: jest.fn(), upsertMessages: jest.fn() },
  messageBlockDatabase: { getBlockById: jest.fn(), updateOneBlock: jest.fn(), upsertBlocks: jest.fn() },
  topicDatabase: { getTopicById: jest.fn(), upsertTopics: jest.fn() }
}))

// Keep the service import after the Expo SQLite stub in Jest's runtime.
// eslint-disable-next-line import/first
import { recoverInterruptedConversations } from '../ConversationRecoveryService'

const topic: Topic = {
  id: 'topic-1',
  assistantId: 'assistant-1',
  name: 'Interrupted run',
  createdAt: 1,
  updatedAt: 1,
  isLoading: true
}

const userMessage: Message = {
  id: 'user-1',
  role: 'user',
  assistantId: 'assistant-1',
  topicId: topic.id,
  createdAt: 1,
  status: UserMessageStatus.SUCCESS,
  blocks: []
}

describe('recoverInterruptedConversations', () => {
  it('pauses partial output, replaces an orphan placeholder, and clears topic loading', async () => {
    const messages: Message[] = [
      userMessage,
      {
        id: 'assistant-partial',
        role: 'assistant',
        assistantId: 'assistant-1',
        topicId: topic.id,
        createdAt: 2,
        status: AssistantMessageStatus.PROCESSING,
        blocks: ['partial-text']
      },
      {
        id: 'assistant-placeholder',
        role: 'assistant',
        assistantId: 'assistant-1',
        topicId: topic.id,
        createdAt: 3,
        status: AssistantMessageStatus.PENDING,
        blocks: ['placeholder']
      }
    ]
    const blocks = new Map<string, MessageBlock>([
      [
        'partial-text',
        {
          id: 'partial-text',
          messageId: 'assistant-partial',
          type: MessageBlockType.MAIN_TEXT,
          content: 'Already persisted',
          createdAt: 2,
          status: MessageBlockStatus.STREAMING
        }
      ],
      [
        'placeholder',
        {
          id: 'placeholder',
          messageId: 'assistant-placeholder',
          type: MessageBlockType.UNKNOWN,
          createdAt: 3,
          status: MessageBlockStatus.PROCESSING
        }
      ]
    ])
    const savedMessages: Message[][] = []
    const savedTopics: Topic[][] = []
    const dependencies = {
      getInterruptedMessages: jest.fn(async () => messages),
      upsertMessages: jest.fn(async (updates: Message[]) => savedMessages.push(updates)),
      getBlockById: jest.fn(async (id: string) => blocks.get(id) ?? null),
      updateOneBlock: jest.fn(async ({ id, changes }: { id: string; changes: Partial<MessageBlock> }) => {
        blocks.set(id, { ...blocks.get(id)!, ...changes } as MessageBlock)
      }),
      upsertBlocks: jest.fn(async (newBlocks: MessageBlock[]) => {
        for (const block of newBlocks) blocks.set(block.id, block)
      }),
      getTopicById: jest.fn(async () => topic),
      upsertTopics: jest.fn(async (updates: Topic[]) => savedTopics.push(updates))
    }

    await expect(recoverInterruptedConversations(dependencies)).resolves.toEqual({
      messages: 2,
      blocks: 2,
      topics: 1
    })

    expect(savedMessages[0].map(message => message.status)).toEqual([
      AssistantMessageStatus.PAUSED,
      AssistantMessageStatus.PAUSED
    ])
    expect(blocks.get('partial-text')).toMatchObject({
      content: 'Already persisted',
      status: MessageBlockStatus.PAUSED
    })
    expect(blocks.get('placeholder')).toMatchObject({
      type: MessageBlockType.ERROR,
      status: MessageBlockStatus.SUCCESS,
      error: expect.objectContaining({ code: 'AGENT_SESSION_INTERRUPTED' })
    })
    expect(savedTopics[0][0]).toMatchObject({ id: topic.id, isLoading: false })
  })

  it('does not mutate completed conversations', async () => {
    const dependencies = {
      getInterruptedMessages: jest.fn(async () => [
        userMessage,
        {
          ...userMessage,
          id: 'assistant-complete',
          role: 'assistant' as const,
          status: AssistantMessageStatus.SUCCESS
        }
      ]),
      upsertMessages: jest.fn(),
      getBlockById: jest.fn(),
      updateOneBlock: jest.fn(),
      upsertBlocks: jest.fn(),
      getTopicById: jest.fn(),
      upsertTopics: jest.fn()
    }

    await expect(recoverInterruptedConversations(dependencies)).resolves.toEqual({
      messages: 0,
      blocks: 0,
      topics: 0
    })
    expect(dependencies.upsertMessages).not.toHaveBeenCalled()
    expect(dependencies.updateOneBlock).not.toHaveBeenCalled()
    expect(dependencies.upsertBlocks).not.toHaveBeenCalled()
    expect(dependencies.upsertTopics).not.toHaveBeenCalled()
  })

  it('creates a visible recovery error if the process stopped before the placeholder was stored', async () => {
    const interrupted: Message = {
      id: 'assistant-no-block',
      role: 'assistant',
      assistantId: 'assistant-1',
      topicId: topic.id,
      createdAt: 2,
      status: AssistantMessageStatus.PENDING,
      blocks: []
    }
    const upsertBlocks = jest.fn(async (_blocks: MessageBlock[]) => undefined)
    const upsertMessages = jest.fn(async (_messages: Message[]) => undefined)
    const dependencies = {
      getInterruptedMessages: jest.fn(async () => [interrupted]),
      upsertMessages,
      getBlockById: jest.fn(async () => null),
      updateOneBlock: jest.fn(async () => undefined),
      upsertBlocks,
      getTopicById: jest.fn(async () => topic),
      upsertTopics: jest.fn(async (_topics: Topic[]) => undefined)
    }

    await expect(recoverInterruptedConversations(dependencies)).resolves.toEqual({
      messages: 1,
      blocks: 1,
      topics: 1
    })
    expect(upsertBlocks).toHaveBeenCalledWith([
      expect.objectContaining({
        messageId: interrupted.id,
        type: MessageBlockType.ERROR,
        error: expect.objectContaining({ code: 'AGENT_SESSION_INTERRUPTED' })
      })
    ])
    const recoveryBlockId = upsertBlocks.mock.calls[0][0][0].id
    expect(upsertMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        id: interrupted.id,
        status: AssistantMessageStatus.PAUSED,
        blocks: [recoveryBlockId]
      })
    ])
  })
})
