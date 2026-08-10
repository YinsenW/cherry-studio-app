import { messageBlockDatabase, messageDatabase, topicDatabase } from '@database'

import type { Topic } from '@/types/assistant'
import type { SerializedError } from '@/types/error'
import type { Message, MessageBlock } from '@/types/message'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@/types/message'
import { createErrorBlock } from '@/utils/messageUtils/create'

type ConversationRecoveryDependencies = {
  getInterruptedMessages: () => Promise<Message[]>
  upsertMessages: (messages: Message[]) => Promise<unknown>
  getBlockById: (blockId: string) => Promise<MessageBlock | null>
  updateOneBlock: (update: { id: string; changes: Partial<MessageBlock> }) => Promise<unknown>
  upsertBlocks: (blocks: MessageBlock[]) => Promise<unknown>
  getTopicById: (topicId: string) => Promise<Topic | null | undefined>
  upsertTopics: (topics: Topic[]) => Promise<unknown>
}

const defaultDependencies: ConversationRecoveryDependencies = {
  getInterruptedMessages: () =>
    messageDatabase.getAssistantMessagesByStatuses([
      AssistantMessageStatus.PENDING,
      AssistantMessageStatus.PROCESSING,
      AssistantMessageStatus.SEARCHING
    ]),
  upsertMessages: messages => messageDatabase.upsertMessages(messages),
  getBlockById: blockId => messageBlockDatabase.getBlockById(blockId),
  updateOneBlock: update => messageBlockDatabase.updateOneBlock(update),
  upsertBlocks: blocks => messageBlockDatabase.upsertBlocks(blocks),
  getTopicById: topicId => topicDatabase.getTopicById(topicId),
  upsertTopics: topics => topicDatabase.upsertTopics(topics)
}

const interruptedMessageStatuses = new Set<AssistantMessageStatus>([
  AssistantMessageStatus.PENDING,
  AssistantMessageStatus.PROCESSING,
  AssistantMessageStatus.SEARCHING
])

const interruptedBlockStatuses = new Set<MessageBlockStatus>([
  MessageBlockStatus.PENDING,
  MessageBlockStatus.PROCESSING,
  MessageBlockStatus.STREAMING
])

export type ConversationRecoveryResult = {
  messages: number
  blocks: number
  topics: number
}

/**
 * A native process restart destroys every in-memory stream and AbortController.
 * Reconcile their durable rows once at app startup so the UI never restores an
 * immortal spinner with no live task behind it. Partial content is preserved
 * and marked paused; a placeholder-only response becomes a visible error that
 * can be retried.
 */
export async function recoverInterruptedConversations(
  dependencies: ConversationRecoveryDependencies = defaultDependencies
): Promise<ConversationRecoveryResult> {
  const interruptedMessages = (await dependencies.getInterruptedMessages()).filter(
    message => message.role === 'assistant' && interruptedMessageStatuses.has(message.status as AssistantMessageStatus)
  )

  if (interruptedMessages.length === 0) {
    return { messages: 0, blocks: 0, topics: 0 }
  }

  const now = Date.now()
  const interruptedError: SerializedError = {
    name: 'AgentSessionInterrupted',
    message: 'The previous response was interrupted when the app stopped. Please retry to continue.',
    stack: null,
    code: 'AGENT_SESSION_INTERRUPTED'
  }
  const blockIds = Array.from(new Set(interruptedMessages.flatMap(message => message.blocks)))
  const blocks = (await Promise.all(blockIds.map(blockId => dependencies.getBlockById(blockId)))).filter(
    (block): block is MessageBlock => block !== null
  )
  const interruptedBlocks = blocks.filter(
    block => block.type === MessageBlockType.UNKNOWN || interruptedBlockStatuses.has(block.status)
  )
  const loadedBlockMessageIds = new Set(blocks.map(block => block.messageId))
  const recoveryErrorBlocks = interruptedMessages
    .filter(message => !loadedBlockMessageIds.has(message.id))
    .map(message => createErrorBlock(message.id, interruptedError, { status: MessageBlockStatus.SUCCESS }))
  const recoveryErrorBlocksByMessageId = new Map(recoveryErrorBlocks.map(block => [block.messageId, block]))

  await Promise.all(
    interruptedBlocks.map(block =>
      dependencies.updateOneBlock({
        id: block.id,
        changes:
          block.type === MessageBlockType.UNKNOWN
            ? {
                type: MessageBlockType.ERROR,
                status: MessageBlockStatus.SUCCESS,
                error: interruptedError,
                updatedAt: now
              }
            : { status: MessageBlockStatus.PAUSED, updatedAt: now }
      })
    )
  )
  if (recoveryErrorBlocks.length > 0) {
    await dependencies.upsertBlocks(recoveryErrorBlocks)
  }

  const topicIds = Array.from(new Set(interruptedMessages.map(message => message.topicId)))
  const topics = (await Promise.all(topicIds.map(topicId => dependencies.getTopicById(topicId)))).filter(
    (topic): topic is Topic => topic != null
  )
  if (topics.length > 0) {
    await dependencies.upsertTopics(topics.map(topic => ({ ...topic, isLoading: false, updatedAt: now })))
  }

  // Persist message terminal states last. If the process is killed midway
  // through recovery, the still-active rows make the whole repair retryable
  // at the next launch; a topic can never be stranded in loading=true after
  // its message has already fallen out of the recovery query.
  await dependencies.upsertMessages(
    interruptedMessages.map(message => {
      const recoveryErrorBlock = recoveryErrorBlocksByMessageId.get(message.id)
      return {
        ...message,
        status: AssistantMessageStatus.PAUSED,
        updatedAt: now,
        // A process can die between creating the assistant row and storing its
        // initial placeholder. Attach the recovery block explicitly so it is
        // renderable instead of becoming an unreachable database row.
        blocks: recoveryErrorBlock ? [...message.blocks, recoveryErrorBlock.id] : message.blocks
      }
    })
  )

  return {
    messages: interruptedMessages.length,
    blocks: interruptedBlocks.length + recoveryErrorBlocks.length,
    topics: topics.length
  }
}
