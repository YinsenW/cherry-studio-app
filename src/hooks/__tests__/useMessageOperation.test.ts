import { act, renderHook } from '@testing-library/react-native'

import type { Topic } from '@/types/assistant'
import type { Message, MessageBlock } from '@/types/message'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType, UserMessageStatus } from '@/types/message'

const mockGetMessagesByTopicId = jest.fn()
const mockUpsertMessages = jest.fn()
const mockGetBlockById = jest.fn()
const mockUpdateOneBlock = jest.fn()
const mockUpdateTopic = jest.fn()
const mockAbortCompletion = jest.fn()

jest.mock('@database', () => ({
  messageDatabase: {
    getMessagesByTopicId: (...args: unknown[]) => mockGetMessagesByTopicId(...args),
    upsertMessages: (...args: unknown[]) => mockUpsertMessages(...args)
  },
  messageBlockDatabase: {
    getBlockById: (...args: unknown[]) => mockGetBlockById(...args),
    updateOneBlock: (...args: unknown[]) => mockUpdateOneBlock(...args)
  }
}))

jest.mock('@/services/TopicService', () => ({
  topicService: { updateTopic: (...args: unknown[]) => mockUpdateTopic(...args) }
}))

jest.mock('@/utils/abortController', () => ({
  abortCompletion: (...args: unknown[]) => mockAbortCompletion(...args)
}))

jest.mock('../useTopic', () => ({ useTopic: jest.fn() }))

// Keep the module import after its native/database stubs in Jest's runtime.
// eslint-disable-next-line import/first
import { useMessageOperations } from '../useMessageOperation'

const topic = {
  id: 'topic-1',
  assistantId: 'assistant-1',
  name: 'Pause fallback',
  createdAt: 1,
  updatedAt: 1,
  isLoading: true
} as Topic

describe('useMessageOperations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpsertMessages.mockResolvedValue(undefined)
    mockUpdateOneBlock.mockResolvedValue(undefined)
    mockUpdateTopic.mockResolvedValue(undefined)
  })

  it('durably pauses active messages and blocks when the stream callback cannot finish', async () => {
    const activeMessage: Message = {
      id: 'assistant-active',
      role: 'assistant',
      assistantId: topic.assistantId,
      topicId: topic.id,
      askId: 'user-1',
      createdAt: 2,
      status: AssistantMessageStatus.SEARCHING,
      blocks: ['block-active']
    }
    const completedMessage: Message = {
      id: 'assistant-complete',
      role: 'assistant',
      assistantId: topic.assistantId,
      topicId: topic.id,
      createdAt: 1,
      status: AssistantMessageStatus.SUCCESS,
      blocks: []
    }
    const activeBlock: MessageBlock = {
      id: 'block-active',
      messageId: activeMessage.id,
      type: MessageBlockType.MAIN_TEXT,
      status: MessageBlockStatus.STREAMING,
      createdAt: 2,
      content: 'partial response'
    }

    mockGetMessagesByTopicId.mockResolvedValue([activeMessage, completedMessage])
    mockGetBlockById.mockResolvedValue(activeBlock)

    const { result } = renderHook(() => useMessageOperations(topic))
    await act(async () => result.current.pauseMessages())

    expect(mockAbortCompletion).toHaveBeenCalledWith('user-1')
    expect(mockUpdateOneBlock).toHaveBeenCalledWith({
      id: activeBlock.id,
      changes: expect.objectContaining({ status: MessageBlockStatus.PAUSED })
    })
    expect(mockUpsertMessages).toHaveBeenCalledWith([
      expect.objectContaining({ id: activeMessage.id, status: AssistantMessageStatus.PAUSED })
    ])
    expect(mockUpdateTopic).toHaveBeenCalledWith(topic.id, { isLoading: false })
  })

  it('does not rewrite completed messages', async () => {
    const completedMessage: Message = {
      id: 'user-complete',
      role: 'user',
      assistantId: topic.assistantId,
      topicId: topic.id,
      createdAt: 1,
      status: UserMessageStatus.SUCCESS,
      blocks: []
    }
    mockGetMessagesByTopicId.mockResolvedValue([completedMessage])

    const { result } = renderHook(() => useMessageOperations(topic))
    await act(async () => result.current.pauseMessages())

    expect(mockAbortCompletion).not.toHaveBeenCalled()
    expect(mockUpdateOneBlock).not.toHaveBeenCalled()
    expect(mockUpsertMessages).not.toHaveBeenCalled()
    expect(mockUpdateTopic).toHaveBeenCalledWith(topic.id, { isLoading: false })
  })

  it('releases the topic spinner even when the durable message update fails', async () => {
    const activeMessage: Message = {
      id: 'assistant-write-failure',
      role: 'assistant',
      assistantId: topic.assistantId,
      topicId: topic.id,
      askId: 'user-2',
      createdAt: 2,
      status: AssistantMessageStatus.PROCESSING,
      blocks: []
    }
    mockGetMessagesByTopicId.mockResolvedValue([activeMessage])
    mockUpsertMessages.mockRejectedValueOnce(new Error('database unavailable'))

    const { result } = renderHook(() => useMessageOperations(topic))
    await expect(result.current.pauseMessages()).rejects.toThrow('database unavailable')

    expect(mockUpdateTopic).toHaveBeenCalledWith(topic.id, { isLoading: false })
  })
})
