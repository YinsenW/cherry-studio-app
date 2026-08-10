import type { Model } from '@/types/assistant'
import { FileTypes } from '@/types/file'
import type { Message, MessageBlock } from '@/types/message'
import { MessageBlockStatus, MessageBlockType, UserMessageStatus } from '@/types/message'

import { messagesToPiContext, messageToPiUserMessage } from '../messagesToPiContext'

const mockBlocks = new Map<string, MessageBlock>()
const mockIsVisionModel = jest.fn()

jest.mock('@database', () => ({
  messageBlockDatabase: {
    getBlockById: async (id: string) => mockBlocks.get(id)
  }
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
        path: 'file:///private/notes.txt',
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
  })

  it('uses a bounded attachment manifest instead of inlining file contents', async () => {
    mockIsVisionModel.mockReturnValue(true)

    const result = await messageToPiUserMessage(message, model)

    expect(result.role).toBe('user')
    expect(result.timestamp).toBe(1)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    const manifestText = (result.content[0] as { type: 'text'; text: string }).text
    expect(manifestText).toContain('Question')
    expect(manifestText).toContain('"type": "agent_attachment_manifest"')
    expect(manifestText).toContain('"path": "inputs/current/notes.txt"')
    expect(manifestText).toContain('"bytes": 5')
    expect(manifestText).not.toContain('file:///private')
    expect(result.content[1]).toEqual({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' })
  })

  it('makes omitted images visible to the model instead of silently dropping them', async () => {
    mockIsVisionModel.mockReturnValue(false)

    const result = await messageToPiUserMessage(message, model)

    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('agent_attachment_manifest') }),
      {
        type: 'text',
        text: '[1 attached image(s) were not included because the selected model does not support image input.]'
      }
    ])
  })

  it('does not resend historical images and points at the history mount', async () => {
    mockIsVisionModel.mockReturnValue(true)

    const result = await messagesToPiContext([message], model, { attachmentToolsAvailable: true })
    const user = result[0]

    expect(user.role).toBe('user')
    expect(JSON.stringify(user.content)).toContain('inputs/history/user-1/notes.txt')
    expect(user.content).not.toContainEqual(expect.objectContaining({ type: 'image' }))
  })
})
