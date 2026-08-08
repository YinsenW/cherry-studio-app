import { messageBlockDatabase, messageDatabase } from '@database'

import ModernAiProvider from '@/aiCore/index_new'
import type { AiSdkMiddlewareConfig } from '@/aiCore/middleware/AiSdkMiddlewareBuilder'
import { buildStreamTextParams, convertMessagesToSdkMessages } from '@/aiCore/prepareParams'
import { loggerService } from '@/services/LoggerService'
import type { Assistant, Model, Topic, Usage } from '@/types/assistant'
import { ChunkType } from '@/types/chunk'
import type { FileMetadata } from '@/types/file'
import { FileTypes } from '@/types/file'
import type { MainTextMessageBlock, Message, MessageBlock } from '@/types/message'
import { MessageBlockStatus, MessageBlockType } from '@/types/message'
import { uuid } from '@/utils'
import {
  createAssistantMessage,
  createFileBlock,
  createImageBlock,
  createMainTextBlock,
  createMessage,
  createTranslationBlock
} from '@/utils/messageUtils/create'
import { findMainTextBlocks } from '@/utils/messageUtils/find'

import { assistantService, getAssistantModel, getDefaultModel } from './AssistantService'
import { BlockManager, createCallbacks } from './messageStreaming'
import { getAssistantProvider } from './ProviderService'
import type { StreamProcessorCallbacks } from './StreamProcessingService'
import { createStreamProcessor } from './StreamProcessingService'
import { topicService } from './TopicService'

const logger = loggerService.withContext('Messages Service')

const finishTopicLoading = async (topicId: string) => {
  await topicService.updateTopic(topicId, { isLoading: false })
}

/**
 * Creates a user message object and associated blocks based on input.
 * This is a pure function and does not dispatch to the store.
 *
 * @param params - The parameters for creating the message.
 * @returns An object containing the created message and its blocks.
 */
export function getUserMessage({
  assistant,
  topic,
  type,
  content,
  files,
  // Keep other potential params if needed by createMessage
  mentions,
  usage
}: {
  assistant: Assistant
  topic: Topic
  type?: Message['type']
  content?: string
  files?: FileMetadata[]
  mentions?: Model[]
  usage?: Usage
}): { message: Message; blocks: MessageBlock[] } {
  const model = getAssistantModel(assistant)
  const messageId = uuid() // Generate ID here
  const blocks: MessageBlock[] = []
  const blockIds: string[] = []

  if (files?.length) {
    files.forEach(file => {
      if (file.type === FileTypes.IMAGE) {
        const imgBlock = createImageBlock(messageId, { file, status: MessageBlockStatus.SUCCESS })
        blocks.push(imgBlock)
        blockIds.push(imgBlock.id)
      } else {
        const fileBlock = createFileBlock(messageId, file, { status: MessageBlockStatus.SUCCESS })
        blocks.push(fileBlock)
        blockIds.push(fileBlock.id)
      }
    })
  }

  // 内容为空也应该创建空文本块
  if (content !== undefined) {
    // Pass messageId when creating blocks
    const textBlock = createMainTextBlock(messageId, content, {
      status: MessageBlockStatus.SUCCESS
    })
    blocks.push(textBlock)
    blockIds.push(textBlock.id)
  }

  // 直接在createMessage中传入id
  const message = createMessage(
    'user',
    topic.id, // topic.id已经是string类型
    assistant.id,
    {
      id: messageId, // 直接传入ID，避免冲突
      modelId: model?.id,
      model: model,
      blocks: blockIds,
      mentions,
      type,
      usage
    }
  )

  // 不再需要手动合并ID
  return { message, blocks }
}

/**
 * Regenerate all assistant responses linked to a user message.
 * This finds all assistant messages with askId matching the user message id
 * and regenerates each of them.
 */
export async function regenerateResponsesForUserMessage(userMessage: Message, assistant: Assistant) {
  const topicId = userMessage.topicId

  try {
    // Find all assistant messages linked to this user message
    const allMessages = await messageDatabase.getMessagesByTopicId(topicId)
    const linkedAssistantMessages = allMessages.filter(m => m.role === 'assistant' && m.askId === userMessage.id)

    if (linkedAssistantMessages.length === 0) {
      logger.warn(`No linked assistant messages found for user message ${userMessage.id}`)
      return
    }

    // Regenerate all linked assistant messages in parallel（agent 是唯一模式）
    const { regenerateAgentMessage } = await import('@/agent/sendAgentMessage')
    const results = await Promise.allSettled(
      linkedAssistantMessages.map(assistantMsg => regenerateAgentMessage(assistantMsg, assistant))
    )

    // Check for failures and log them
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failures.length > 0) {
      logger.error(`${failures.length}/${results.length} regenerations failed:`, {
        errors: failures.map(f => f.reason)
      })
      // Throw error if all regenerations failed
      if (failures.length === results.length) {
        throw new Error(`All ${failures.length} regeneration(s) failed`)
      }
    }
  } catch (error) {
    logger.error('Error in regenerateResponsesForUserMessage:', error)
    throw error // Propagate error to caller
  } finally {
    // Always reset loading state when all regenerations complete (success or failure)
    await finishTopicLoading(topicId)
  }
}

/**
 * Edit a user message and regenerate the assistant response.
 * This function:
 * 1. Updates the user message content
 * 2. Handles new files if provided
 * 3. Deletes all linked assistant responses
 * 4. Creates a new assistant message and triggers regeneration
 */
export async function editUserMessageAndRegenerate(
  userMessageId: string,
  newContent: string,
  newFiles: FileMetadata[],
  assistant: Assistant,
  topicId: string
) {
  try {
    // 1. Get and validate user message
    const userMessage = await messageDatabase.getMessageById(userMessageId)
    if (!userMessage || userMessage.role !== 'user') {
      logger.error(`[editUserMessageAndRegenerate] Invalid user message: ${userMessageId}`)
      throw new Error('Invalid user message')
    }

    // 2. Find and update MainTextMessageBlock
    const mainTextBlocks = await findMainTextBlocks(userMessage)
    if (mainTextBlocks.length > 0) {
      const mainTextBlock = mainTextBlocks[0] as MainTextMessageBlock
      await messageBlockDatabase.updateOneBlock({
        id: mainTextBlock.id,
        changes: {
          content: newContent,
          status: MessageBlockStatus.SUCCESS,
          updatedAt: Date.now()
        }
      })
    } else {
      // If no main text block exists, create one
      const newTextBlock = createMainTextBlock(userMessageId, newContent, {
        status: MessageBlockStatus.SUCCESS
      })
      await messageBlockDatabase.upsertBlocks([newTextBlock])
      userMessage.blocks = [...userMessage.blocks, newTextBlock.id]
    }

    // 3. Handle file blocks - remove old file/image blocks
    const oldBlocks = await Promise.all(userMessage.blocks.map(id => messageBlockDatabase.getBlockById(id)))
    const fileBlockIds = oldBlocks
      .filter(
        (block): block is MessageBlock =>
          block !== null && (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE)
      )
      .map(block => block.id)

    if (fileBlockIds.length > 0) {
      await cleanupMultipleBlocks(fileBlockIds)
    }

    // 4. Add new file blocks if provided
    const newBlockIds: string[] = []
    if (newFiles.length > 0) {
      for (const file of newFiles) {
        if (file.type === FileTypes.IMAGE) {
          const imgBlock = createImageBlock(userMessageId, { file, status: MessageBlockStatus.SUCCESS })
          await messageBlockDatabase.upsertBlocks([imgBlock])
          newBlockIds.push(imgBlock.id)
        } else {
          const fileBlock = createFileBlock(userMessageId, file, { status: MessageBlockStatus.SUCCESS })
          await messageBlockDatabase.upsertBlocks([fileBlock])
          newBlockIds.push(fileBlock.id)
        }
      }
    }

    // 5. Update user message blocks array
    const remainingBlockIds = userMessage.blocks.filter(id => !fileBlockIds.includes(id))
    const updatedBlockIds = [...newBlockIds, ...remainingBlockIds]

    await messageDatabase.updateMessageById(userMessageId, {
      blocks: updatedBlockIds,
      updatedAt: Date.now()
    })

    // 6. Find and delete all linked assistant messages
    const allMessages = await messageDatabase.getMessagesByTopicId(topicId)
    const linkedAssistantMessages = allMessages.filter(m => m.role === 'assistant' && m.askId === userMessageId)

    for (const assistantMsg of linkedAssistantMessages) {
      // Delete blocks first
      if (assistantMsg.blocks.length > 0) {
        await cleanupMultipleBlocks(assistantMsg.blocks)
      }
      // Delete message
      await messageDatabase.deleteMessageById(assistantMsg.id)
    }

    // 7. Create new assistant message and trigger regeneration
    const newAssistantMessage = createAssistantMessage(assistant.id, topicId, {
      askId: userMessageId,
      model: getAssistantModel(assistant)
    })
    await saveMessageAndBlocksToDB(newAssistantMessage, [])

    // 8. Fetch and process assistant response（agent 是唯一模式，走 agent 通道）
    const { runAgentSession } = await import('@/agent/sendAgentMessage')
    await runAgentSession(userMessage, newAssistantMessage, assistant, topicId)
  } catch (error) {
    logger.error('Error in editUserMessageAndRegenerate:', error)
    await finishTopicLoading(topicId)
    throw error
  }
}

/**
 * Edit an assistant message content without triggering regeneration.
 * Updates only the MAIN_TEXT blocks, preserving other block types.
 */
export async function editAssistantMessage(assistantMessageId: string, newContent: string): Promise<void> {
  try {
    // 1. Get and validate assistant message
    const assistantMessage = await messageDatabase.getMessageById(assistantMessageId)
    if (!assistantMessage || assistantMessage.role !== 'assistant') {
      logger.error(`[editAssistantMessage] Invalid assistant message: ${assistantMessageId}`)
      throw new Error('Invalid assistant message')
    }

    // 2. Find all MAIN_TEXT blocks
    const mainTextBlocks = await findMainTextBlocks(assistantMessage)

    if (mainTextBlocks.length > 0) {
      // Update the first MAIN_TEXT block with new content
      const firstBlock = mainTextBlocks[0]
      await messageBlockDatabase.updateOneBlock({
        id: firstBlock.id,
        changes: {
          content: newContent,
          status: MessageBlockStatus.SUCCESS,
          updatedAt: Date.now()
        }
      })

      // Remove additional MAIN_TEXT blocks if any
      if (mainTextBlocks.length > 1) {
        const additionalBlockIds = mainTextBlocks.slice(1).map(b => b.id)
        await cleanupMultipleBlocks(additionalBlockIds)

        // Update message blocks array to remove deleted blocks
        const updatedBlockIds = assistantMessage.blocks.filter(id => !additionalBlockIds.includes(id))
        await messageDatabase.updateMessageById(assistantMessageId, {
          blocks: updatedBlockIds,
          updatedAt: Date.now()
        })
      } else {
        // Just update timestamp
        await messageDatabase.updateMessageById(assistantMessageId, {
          updatedAt: Date.now()
        })
      }
    } else {
      // No MAIN_TEXT block exists - create one
      const newTextBlock = createMainTextBlock(assistantMessageId, newContent, {
        status: MessageBlockStatus.SUCCESS
      })
      await messageBlockDatabase.upsertBlocks([newTextBlock])
      await messageDatabase.updateMessageById(assistantMessageId, {
        blocks: [...assistantMessage.blocks, newTextBlock.id],
        updatedAt: Date.now()
      })
    }

    logger.info(`Assistant message ${assistantMessageId} edited successfully`)
  } catch (error) {
    logger.error('Error in editAssistantMessage:', error)
    throw error
  }
}

const BLOCK_UPDATE_BATCH_INTERVAL = 180
type BlockUpdatePayload = Partial<MessageBlock>

const pendingBlockUpdates = new Map<string, BlockUpdatePayload>()
let blockFlushTimer: ReturnType<typeof setTimeout> | null = null
let blockFlushQueue: Promise<void> = Promise.resolve()

const mergeBlockUpdates = (
  existing: BlockUpdatePayload | undefined,
  incoming: BlockUpdatePayload
): BlockUpdatePayload => {
  if (!existing) {
    return { ...incoming } as BlockUpdatePayload
  }

  return { ...existing, ...incoming } as BlockUpdatePayload
}

const waitForCurrentBlockFlush = async () => {
  try {
    await blockFlushQueue
  } catch (error) {
    console.error('[BlockBatch] Pending flush failed:', error)
  }
}

const flushPendingBlockUpdates = async (ids?: string[]): Promise<void> => {
  const targetIds = ids?.length ? ids : Array.from(pendingBlockUpdates.keys())

  if (targetIds.length === 0) {
    return
  }

  const updates: { id: string; changes: BlockUpdatePayload }[] = []

  for (const id of targetIds) {
    const payload = pendingBlockUpdates.get(id)

    if (!payload) {
      continue
    }

    updates.push({ id, changes: payload })
    pendingBlockUpdates.delete(id)
  }

  if (updates.length === 0) {
    return
  }

  try {
    for (const { id, changes } of updates) {
      await messageBlockDatabase.updateOneBlock({ id, changes })
    }
  } catch (error) {
    for (const { id, changes } of updates) {
      const existing = pendingBlockUpdates.get(id)
      pendingBlockUpdates.set(id, mergeBlockUpdates(existing, changes))
    }

    console.error('[BlockBatch] Failed to persist block updates:', error)
    throw error
  }
}

const executeBlockFlush = async (ids?: string[]) => {
  const flushPromise = blockFlushQueue.then(() => flushPendingBlockUpdates(ids))
  // Keep later updates usable after a failed batch while preserving the error
  // for the caller that initiated this particular flush.
  blockFlushQueue = flushPromise.catch(() => undefined)
  await flushPromise
}

const scheduleBlockFlush = () => {
  if (blockFlushTimer) {
    return
  }

  blockFlushTimer = setTimeout(() => {
    blockFlushTimer = null
    void executeBlockFlush().catch(error => {
      logger.error('Failed to flush throttled block updates', error as Error)
    })
  }, BLOCK_UPDATE_BATCH_INTERVAL)
}

const flushSpecificBlocks = async (ids: string[]) => {
  if (!ids.length) {
    return
  }

  const hasPending = ids.some(id => pendingBlockUpdates.has(id))

  if (!hasPending) {
    await waitForCurrentBlockFlush()
    return
  }

  await executeBlockFlush(ids)
}

/**
 * 更新单个消息块，使用批量缓冲策略。
 */
export const throttledBlockUpdate = async (id: string, blockUpdate: BlockUpdatePayload) => {
  const merged = mergeBlockUpdates(pendingBlockUpdates.get(id), blockUpdate)
  pendingBlockUpdates.set(id, merged)
  scheduleBlockFlush()
}

/**
 * 取消单个块的批量更新，并等待当前写操作完成。
 */
export const cancelThrottledBlockUpdate = async (id: string) => {
  // A block may transition from streamed text to a tool/citation immediately.
  // Persist its final buffered value before the transition instead of dropping it.
  await flushSpecificBlocks([id])

  if (pendingBlockUpdates.size === 0 && blockFlushTimer) {
    clearTimeout(blockFlushTimer)
    blockFlushTimer = null
  }

  await waitForCurrentBlockFlush()
}

export const saveUpdatesToDB = async (
  messageId: string,
  topicId: string,
  messageUpdates: Partial<Message>, // 需要更新的消息字段
  blocksToUpdate: MessageBlock[] // 需要更新/创建的块
) => {
  try {
    const messageDataToSave: Partial<Message> & Pick<Message, 'id' | 'topicId'> = {
      id: messageId,
      topicId,
      ...messageUpdates
    }
    await updateExistingMessageAndBlocksInDB(messageDataToSave, blocksToUpdate)
  } catch (error) {
    console.error(`[DB Save Updates] Failed for message ${messageId}:`, error)
  }
}

const updateExistingMessageAndBlocksInDB = async (
  updatedMessage: Partial<Message> & Pick<Message, 'id' | 'topicId'>,
  updatedBlocks: MessageBlock[]
) => {
  try {
    await messageDatabase.updateMessageById(updatedMessage.id, updatedMessage)
    await messageBlockDatabase.upsertBlocks(updatedBlocks)
  } catch (error) {
    console.error(`[updateExistingMsg] Failed to update message ${updatedMessage.id}:`, error)
  }
}

// 新增: 辅助函数，用于获取并保存单个更新后的 Block 到数据库
export const saveUpdatedBlockToDB = async (blockId: string | null, messageId: string, topicId: string) => {
  if (!blockId) {
    console.warn('[DB Save Single Block] Received null/undefined blockId. Skipping save.')
    return
  }

  await flushSpecificBlocks([blockId])

  const blockToSave = await messageBlockDatabase.getBlockById(blockId)

  if (blockToSave) {
    await saveUpdatesToDB(messageId, topicId, {}, [blockToSave]) // Pass messageId, topicId, empty message updates, and the block
  } else {
    console.warn(`[DB Save Single Block] Block ${blockId} not found in state. Cannot save.`)
  }
}

export async function saveMessageAndBlocksToDB(message: Message, blocks: MessageBlock[]) {
  try {
    await messageDatabase.upsertMessages(message)

    if (blocks.length > 0) {
      await messageBlockDatabase.upsertBlocks(blocks)
    }
  } catch (error) {
    logger.error('Error saving message blocks:', error)
    throw error
  }
}

// --- End Helper Function ---

/**
 * 批量清理多个消息块。
 */
export async function cleanupMultipleBlocks(blockIds: string[]) {
  // blockIds.forEach(id => {
  //   cancelThrottledBlockUpdate(id)
  // })

  // const getBlocksFiles = async (blockIds: string[]) => {
  //   const blocks = await Promise.all(blockIds.map(id => messageBlockDatabase.getBlockById(id)))

  //   const files = blocks
  //     .filter((block): block is MessageBlock => block !== null)
  //     .filter(block => block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE)
  //     .map(block => block.file)
  //     .filter((file): file is FileMetadata => file !== undefined)
  //   return isEmpty(files) ? [] : files
  // }

  // const cleanupFiles = async (files: FileMetadata[]) => {
  //   await Promise.all(files.map(file => FileManager.deleteFile(file.id, false)))
  // }

  // getBlocksFiles(blockIds).then(cleanupFiles)

  if (blockIds.length > 0) {
    await messageBlockDatabase.removeManyBlocks(blockIds)
  }
}

export async function deleteMessagesByTopicId(topicId: string): Promise<void> {
  try {
    return messageDatabase.deleteMessagesByTopicId(topicId)
  } catch (error) {
    logger.error('Error in deleteMessagesByTopicId:', error)
    throw error
  }
}

export async function deleteMessageById(messageId: string): Promise<void> {
  try {
    // await deleteBlocksByMessageId(messageId)
    return messageDatabase.deleteMessageById(messageId)
  } catch (error) {
    logger.error('Error in deleteMessageById:', error)
    throw error
  }
}

export async function fetchTranslateThunk(assistantMessageId: string, message: Message) {
  const startTime = Date.now()
  let callbacks: StreamProcessorCallbacks = {}
  const translateAssistant = await assistantService.getAssistant('translate')

  if (!translateAssistant) {
    throw new Error('Translate assistant not found')
  }

  const translateAssistantModel = translateAssistant.defaultModel || getDefaultModel()
  const assistantForProvider = translateAssistant.model
    ? translateAssistant
    : { ...translateAssistant, model: translateAssistantModel }
  const assistantForRequest = translateAssistant.defaultModel
    ? assistantForProvider
    : { ...assistantForProvider, defaultModel: translateAssistantModel }

  const newBlock = createTranslationBlock(assistantMessageId, '', {
    status: MessageBlockStatus.STREAMING
  })

  // 创建 BlockManager 实例
  const blockManager = new BlockManager({
    saveUpdatedBlockToDB,
    saveUpdatesToDB,
    assistantMsgId: assistantMessageId,
    topicId: message.topicId,
    throttledBlockUpdate,
    cancelThrottledBlockUpdate
  })

  callbacks = await createCallbacks({
    blockManager,
    topicId: message.topicId,
    assistantMsgId: assistantMessageId,
    saveUpdatesToDB,
    assistant: assistantForRequest,
    startTime
  })

  callbacks.onTextStart = async () => {
    if (blockManager.hasInitialPlaceholder) {
      logger.debug('onTextStart hasInitialPlaceholder')
      const changes = {
        type: MessageBlockType.TRANSLATION,
        content: '',
        status: MessageBlockStatus.STREAMING
      }
      newBlock.id = blockManager.initialPlaceholderBlockId!
      await blockManager.smartBlockUpdate(newBlock.id, changes, MessageBlockType.TRANSLATION, true)
      logger.debug('onTextStart', changes)
    }
  }

  callbacks.onTextChunk = async (text: string) => {
    if (text) {
      const blockChanges: Partial<MessageBlock> = {
        content: text,
        status: MessageBlockStatus.STREAMING
      }
      await blockManager.smartBlockUpdate(newBlock.id, blockChanges, MessageBlockType.TRANSLATION)
      logger.info('onTextChunk', blockChanges)
    }
  }

  callbacks.onTextComplete = async (finalText: string) => {
    console.log('onTextComplete', newBlock, finalText)

    if (newBlock.id) {
      const changes = {
        content: finalText,
        status: MessageBlockStatus.SUCCESS
      }
      await blockManager.smartBlockUpdate(newBlock.id, changes, MessageBlockType.TRANSLATION, true)
      logger.debug('onTextComplete', changes)
    } else {
      logger.warn(
        `[onTextComplete] Received text.complete but last block was not MAIN_TEXT (was ${blockManager.lastBlockType}) or lastBlockId is null.`
      )
    }
  }

  const streamProcessorCallbacks = createStreamProcessor(callbacks)

  const provider = await getAssistantProvider(assistantForProvider)
  message = {
    ...message,
    role: 'user'
  }
  const llmMessages = await convertMessagesToSdkMessages([message], translateAssistantModel)

  const AI = new ModernAiProvider(translateAssistantModel, provider)
  const { params: aiSdkParams, modelId } = await buildStreamTextParams(llmMessages, assistantForRequest, provider)

  const middlewareConfig: AiSdkMiddlewareConfig = {
    streamOutput: true,
    onChunk: streamProcessorCallbacks,
    model: translateAssistantModel,
    provider: provider,
    enableReasoning: false,
    isPromptToolUse: false,
    isSupportedToolUse: false,
    isImageGenerationEndpoint: false,
    enableWebSearch: false,
    enableGenerateImage: false,
    enableUrlContext: false,
    mcpTools: []
  }

  try {
    streamProcessorCallbacks({ type: ChunkType.LLM_RESPONSE_CREATED })
    const completion = await AI.completions(modelId, aiSdkParams, {
      ...middlewareConfig,
      assistant: assistantForRequest,
      topicId: message.topicId,
      callType: 'chat',
      uiMessages: [message]
    })
    await streamProcessorCallbacks.drain()
    return completion.getText() || ''
  } catch (error: any) {
    logger.error('Error during translation:', error)
    return ''
  }
}
