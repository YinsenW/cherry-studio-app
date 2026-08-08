import type { Model } from '@/types/assistant'
import { FileTypes } from '@/types/file'
import type { Message, MessageBlock } from '@/types/message'
import { MessageBlockStatus, MessageBlockType, UserMessageStatus } from '@/types/message'

import { messageToPiUserMessage } from '../messagesToPiContext'

const mockBlocks = new Map<string, MessageBlock>()
const mockConvertFileBlockToTextPart = jest.fn()
const mockIsVisionModel = jest.fn()

jest.mock('@database', () => ({
  messageBlockDatabase: {
    getBlockById: async (id: string) => mockBlocks.get(id)
  }
}))
jest.mock('@/aiCore/prepareParams/fileProcessor', () => ({
  convertFileBlockToTextPart: (...args: unknown[]) => mockConvertFileBlockToTextPart(...args)
}))
jest.mock('@/config/models', () => ({
  isVisionModel: (...args: unknown[]) => mockIsVisionModel(...args)
}))

const model: Model = {
  id: 'vision-model',
  name: 'Vision model',
  provider: 'mock-provider',
  group: 'default'
}

const message: Message = {
  id: 'user-1',
  role: 'user',
  assistantId: 'assistant-1',
  topicId: 'topic-1',
  createdAt: 1,
  status: UserMessageStatus.SUCCESS,
  blocks: ['text-1', 'file-1', 'image-1']
}

describe('messageToPiUserMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockBlocks.clear()
    mockBlocks.set('text-1', {
      id: 'text-1',
      messageId: message.id,
      type: MessageBlockType.MAIN_TEXT,
      content: 'Question',
      createdAt: 1,
      status: MessageBlockStatus.SUCCESS
    })
    mockBlocks.set('file-1', {
      id: 'file-1',
      messageId: message.id,
      type: MessageBlockType.FILE,
      file: {
        id: 'file-1',
        name: 'notes.txt',
        origin_name: 'notes.txt',
        path: '/notes.txt',
        size: 5,
        ext: '.txt',
        type: FileTypes.TEXT,
        created_at: 1,
        count: 1
      },
      createdAt: 1,
      status: MessageBlockStatus.SUCCESS
    })
    mockBlocks.set('image-1', {
      id: 'image-1',
      messageId: message.id,
      type: MessageBlockType.IMAGE,
      url: 'data:image/png;base64,aW1hZ2U=',
      createdAt: 1,
      status: MessageBlockStatus.SUCCESS
    })
    mockConvertFileBlockToTextPart.mockResolvedValue({ type: 'text', text: 'File contents' })
  })

  it('includes extracted files and images for vision-capable models', async () => {
    mockIsVisionModel.mockReturnValue(true)

    await expect(messageToPiUserMessage(message, model)).resolves.toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Question\n\nFile contents' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }
      ],
      timestamp: 1
    })
  })

  it('makes omitted images visible to the model instead of silently dropping them', async () => {
    mockIsVisionModel.mockReturnValue(false)

    const result = await messageToPiUserMessage(message, model)

    expect(result.content).toEqual([
      { type: 'text', text: 'Question\n\nFile contents' },
      {
        type: 'text',
        text: '[1 attached image(s) were not included because the selected model does not support image input.]'
      }
    ])
  })
})
