import { messageBlockDatabase, messageDatabase } from '@database'
import { useCallback } from 'react'

import { topicService } from '@/services/TopicService'
import type { Topic } from '@/types/assistant'
import { AssistantMessageStatus, MessageBlockStatus } from '@/types/message'
import { abortCompletion } from '@/utils/abortController'

import { useTopic } from './useTopic'

/**
 * Hook 提供针对特定主题的消息操作方法。 / Hook providing various operations for messages within a specific topic.
 * @param topic 当前主题对象。 / The current topic object.
 * @returns 包含消息操作函数的对象。 / An object containing message operation functions.
 */
export function useMessageOperations(topic: Topic) {
  /**
   * todo: 暂停当前主题正在进行的消息生成。 / Pauses ongoing message generation for the current topic.
   */
  const pauseMessages = useCallback(async () => {
    try {
      const topicMessages = await messageDatabase.getMessagesByTopicId(topic.id)
      if (!topicMessages) return

      const streamingMessages = topicMessages.filter(
        message =>
          message.status === AssistantMessageStatus.PROCESSING ||
          message.status === AssistantMessageStatus.PENDING ||
          message.status === AssistantMessageStatus.SEARCHING
      )
      const askIds = [...new Set(streamingMessages?.map(m => m.askId).filter(id => !!id) as string[])]

      for (const askId of askIds) {
        abortCompletion(askId)
      }

      // Abort callbacks are normally responsible for finalising blocks. Keep a
      // durable fallback here as well because native suspension or a provider
      // that closes without a terminal event can prevent that callback from
      // running. A stopped response is paused, never successfully completed.
      if (streamingMessages.length > 0) {
        const now = Date.now()
        const activeBlockStatuses = new Set([
          MessageBlockStatus.PENDING,
          MessageBlockStatus.PROCESSING,
          MessageBlockStatus.STREAMING
        ])
        await Promise.allSettled(
          streamingMessages.flatMap(message =>
            message.blocks.map(async blockId => {
              const block = await messageBlockDatabase.getBlockById(blockId)
              if (block && activeBlockStatuses.has(block.status)) {
                await messageBlockDatabase.updateOneBlock({
                  id: block.id,
                  changes: { status: MessageBlockStatus.PAUSED, updatedAt: now }
                })
              }
            })
          )
        )
        const messagesToUpdate = streamingMessages.map(msg => ({
          ...msg,
          status: AssistantMessageStatus.PAUSED,
          updatedAt: now
        }))
        await messageDatabase.upsertMessages(messagesToUpdate)
      }
    } finally {
      // The stop button must always release the topic-level spinner, even if
      // one historical block is malformed or a database write fails.
      await topicService.updateTopic(topic.id, { isLoading: false })
    }
  }, [topic])

  return {
    pauseMessages
  }
}

export const useTopicLoading = (topicId: string) => {
  const { topic, isLoading: isTopicQueryLoading } = useTopic(topicId)

  // 如果 topic 查询还在加载中，返回 false 作为默认值
  if (isTopicQueryLoading || !topic) {
    return false
  }

  return topic.isLoading || false
}
