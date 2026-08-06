import { messageDatabase } from '@database'

import { SystemTool } from '@/aiCore/tools/SystemTools'
import { loggerService } from '@/services/LoggerService'
import {
  cancelThrottledBlockUpdate,
  saveMessageAndBlocksToDB,
  saveUpdatedBlockToDB,
  saveUpdatesToDB,
  throttledBlockUpdate
} from '@/services/MessagesService'
import { BlockManager,createCallbacks } from '@/services/messageStreaming'
import { getAssistantProvider } from '@/services/ProviderService'
import { createStreamProcessor } from '@/services/StreamProcessingService'
import { topicService } from '@/services/TopicService'
import type { Assistant, Topic } from '@/types/assistant'
import type { Message, MessageBlock } from '@/types/message'
import { addAbortController } from '@/utils/abortController'
import { createAssistantMessage } from '@/utils/messageUtils/create'
import { getMainTextContent } from '@/utils/messageUtils/find'

import { AgentService } from './AgentService'
import { createAgentEventToChunk } from './agentToChunk'
import { messagesToPiContext } from './messagesToPiContext'
import { aiSdkToolToAgentTool } from './toolAdapter'

const logger = loggerService.withContext('sendAgentMessage')

/**
 * Agent 模式的发送入口（对应普通聊天的 sendMessage）。
 *
 * 与现有 fetchAndProcessAssistantResponseImpl 结构对齐：
 * 1. 保存用户消息 + 创建 assistant 消息
 * 2. createCallbacks + BlockManager（复用现有块流渲染与落库）
 * 3. 读 topic 历史 → 转 pi 上下文
 * 4. 构造 Agent（pi-agent-core）+ streamFn + 全量 SystemTool
 * 5. agent 事件 → chunk → streamProcessor（复用现有文本块 / 工具块渲染）
 * 6. 收尾（loading 结束 + 话题命名）
 */
export async function sendAgentMessage(
  userMessage: Message,
  userMessageBlocks: MessageBlock[],
  assistant: Assistant,
  topicId: Topic['id']
) {
  try {
    if (userMessage.blocks.length === 0) {
      logger.warn('sendAgentMessage: No blocks in the provided message.')
      return
    }

    // 1. 落库：用户消息 + assistant 占位消息
    await saveMessageAndBlocksToDB(userMessage, userMessageBlocks)

    const assistantMessage = createAssistantMessage(assistant.id, topicId, {
      askId: userMessage.id,
      model: assistant.model
    })
    await saveMessageAndBlocksToDB(assistantMessage, [])

    await topicService.updateTopic(topicId, { isLoading: true })

    // 2. 复用现有块流回调（文本块 / 工具块 / 错误块渲染与落库）
    const blockManager = new BlockManager({
      saveUpdatedBlockToDB,
      saveUpdatesToDB,
      assistantMsgId: assistantMessage.id,
      topicId,
      throttledBlockUpdate,
      cancelThrottledBlockUpdate
    })
    const callbacks = await createCallbacks({
      blockManager,
      topicId,
      assistantMsgId: assistantMessage.id,
      saveUpdatesToDB: saveMessageAndBlocksToDB,
      assistant,
      startTime: Date.now()
    })
    const streamProcessor = createStreamProcessor(callbacks)

    // 3. 读取历史并转换为 pi 上下文
    const allMessages = await messageDatabase.getMessagesByTopicId(topicId)
    const contextMessages = await messagesToPiContext(
      allMessages.filter(m => m.id !== assistantMessage.id),
      assistant.model?.id ?? '',
      assistant.model?.provider ?? ''
    )

    // 4. 构造 agent
    const provider = await getAssistantProvider(assistant)
    const tools = Object.entries(SystemTool).map(([name, tool]) => aiSdkToolToAgentTool(name, tool))
    const agentService = new AgentService(assistant.model!, provider, tools, undefined, contextMessages as never[])

    // 5. 事件 → chunk → 现有块流
    agentService.subscribe(createAgentEventToChunk(chunk => streamProcessor(chunk)))

    // 中止：绑定到现有「暂停/停止」机制
    addAbortController(userMessage.id, () => agentService.abort())

    const userText = await getMainTextContent(userMessage)
    await agentService.prompt(userText || '')
  } catch (error) {
    logger.error('Error in sendAgentMessage:', error as Error)
    try {
      await topicService.updateTopic(topicId, { isLoading: false })
    } catch {
      // 忽略收尾错误
    }
  }
}
