import { messageDatabase } from '@database'

import { SystemTool } from '@/aiCore/tools/SystemTools'
import { AndroidTool } from '@/aiCore/tools/SystemTools/AndroidTools'
import { ApiTool } from '@/aiCore/tools/SystemTools/ApiTools'
import { ComputeTool } from '@/aiCore/tools/SystemTools/ComputeTools'
import { FeishuTool } from '@/aiCore/tools/SystemTools/FeishuTools'
import { GithubTool } from '@/aiCore/tools/SystemTools/GithubTools'
import { createLlmTools } from '@/aiCore/tools/SystemTools/LlmTools'
import { createMcpTools } from '@/aiCore/tools/SystemTools/McpTools'
import { fetchTopicNaming } from '@/services/ApiService'
import { loggerService } from '@/services/LoggerService'
import {
  cancelThrottledBlockUpdate,
  cleanupMultipleBlocks,
  saveMessageAndBlocksToDB,
  saveUpdatedBlockToDB,
  saveUpdatesToDB,
  throttledBlockUpdate
} from '@/services/MessagesService'
import { BlockManager, createCallbacks } from '@/services/messageStreaming'
import { getAssistantProvider } from '@/services/ProviderService'
import { createStreamProcessor } from '@/services/StreamProcessingService'
import { topicService } from '@/services/TopicService'
import type { Assistant, Topic } from '@/types/assistant'
import { ChunkType } from '@/types/chunk'
import type { Message, MessageBlock } from '@/types/message'
import { AssistantMessageStatus } from '@/types/message'
import { addAbortController } from '@/utils/abortController'
import { createAssistantMessage, resetAssistantMessage } from '@/utils/messageUtils/create'
import { getMainTextContent } from '@/utils/messageUtils/find'

import { AgentService } from './AgentService'
import { createAgentEventToChunk } from './agentToChunk'
import { messagesToPiContext } from './messagesToPiContext'
import { aiSdkToolToAgentTool } from './toolAdapter'

const logger = loggerService.withContext('sendAgentMessage')

const AGENT_TIMEOUT_MS = 120_000

/**
 * 执行一次 agent 会话，把 pi 事件流转换为现有块流并落库。
 *
 * 被 sendAgentMessage（新消息）和 regenerateAgentMessage（重新生成）共用。
 * 前提：assistant 消息与用户消息都已存在于数据库（assistant 消息无块）。
 *
 * @param userMessage 触发这次 agent 的用户消息（已在 DB）
 * @param assistantMessage 本次要填充内容的 assistant 消息（已在 DB，空块）
 */
export async function runAgentSession(
  userMessage: Message,
  assistantMessage: Message,
  assistant: Assistant,
  topicId: Topic['id']
) {
  let streamProcessor: ReturnType<typeof createStreamProcessor> | null = null
  try {
    await topicService.updateTopic(topicId, { isLoading: true })

    // 1. 复用现有块流回调（文本块 / 工具块 / 错误块渲染与落库）
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
      saveUpdatesToDB,
      assistant,
      startTime: Date.now()
    })
    streamProcessor = createStreamProcessor(callbacks)
    const processChunk = (chunk: Parameters<ReturnType<typeof createStreamProcessor>>[0]) =>
      streamProcessor?.(chunk)

    // 2. 读取历史并转换为 pi 上下文（排除本次 assistant 消息）
    const allMessages = await messageDatabase.getMessagesByTopicId(topicId)
    const contextMessages = await messagesToPiContext(
      allMessages.filter(m => m.id !== assistantMessage.id),
      assistant.model?.id ?? '',
      assistant.model?.provider ?? ''
    )

    // 3. 构造 agent 工具集：系统 + Android + 计算 + LLM 子任务 + 免费 API + 飞书 + GitHub + 用户 MCP 服务器
    const provider = await getAssistantProvider(assistant)
    const mcpTools = await createMcpTools(assistant)
    const tools = [
      ...Object.entries(SystemTool).map(([name, tool]) => aiSdkToolToAgentTool(name, tool)),
      ...Object.entries(AndroidTool).map(([name, tool]) => aiSdkToolToAgentTool(name, tool)),
      ...Object.entries(ComputeTool).map(([name, tool]) => aiSdkToolToAgentTool(name, tool)),
      ...Object.entries(ApiTool).map(([name, tool]) => aiSdkToolToAgentTool(name, tool)),
      ...Object.entries(FeishuTool).map(([name, tool]) => aiSdkToolToAgentTool(name, tool)),
      ...Object.entries(GithubTool).map(([name, tool]) => aiSdkToolToAgentTool(name, tool)),
      ...Object.entries(createLlmTools(assistant)).map(([name, tool]) => aiSdkToolToAgentTool(name, tool)),
      ...mcpTools
    ]
    const agentService = new AgentService(assistant.model!, provider, tools, undefined, contextMessages as never[])

    // 4. 事件 → chunk → 现有块流
    agentService.subscribe(createAgentEventToChunk(chunk => processChunk(chunk)))

    // 5. 中止：绑定到现有「暂停/停止」机制
    addAbortController(userMessage.id, () => agentService.abort())

    const userText = await getMainTextContent(userMessage)

    // 6. 超时兜底：普通聊天路径有 timeout:30000，agent 可能多轮，给 120s。
    // 否则网络卡住时 prompt 永不返回 → 一直转圈。
    await Promise.race([
      agentService.prompt(userText || ''),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          agentService.abort()
          reject(new Error('Agent 响应超时（120s），已自动停止。请检查网络或重试。'))
        }, AGENT_TIMEOUT_MS)
      })
    ])
  } catch (error) {
    logger.error('Error in agent session:', error as Error)
    // 让错误在聊天 UI 可见（不再静默无响应）
    streamProcessor?.({
      type: ChunkType.ERROR,
      error: {
        code: 'AGENT_ERROR',
        message: error instanceof Error ? error.message : String(error)
      }
    })
    streamProcessor?.({ type: ChunkType.BLOCK_COMPLETE })
  } finally {
    // 收尾：与普通聊天路径一致，必须复位 loading 并触发话题命名
    try {
      await topicService.updateTopic(topicId, { isLoading: false })
    } catch {
      // 忽略收尾错误
    }
    try {
      await fetchTopicNaming(topicId)
    } catch {
      // 忽略命名错误
    }
  }
}

/**
 * Agent 模式的新消息发送入口（对应普通聊天的 sendMessage）。
 *
 * 1. 落库用户消息 + 创建 assistant 占位消息
 * 2. 交给 runAgentSession 跑 agent 循环
 */
export async function sendAgentMessage(
  userMessage: Message,
  userMessageBlocks: MessageBlock[],
  assistant: Assistant,
  topicId: Topic['id']
) {
  if (userMessage.blocks.length === 0) {
    logger.warn('sendAgentMessage: No blocks in the provided message.')
    return
  }

  await saveMessageAndBlocksToDB(userMessage, userMessageBlocks)

  const assistantMessage = createAssistantMessage(assistant.id, topicId, {
    askId: userMessage.id,
    model: assistant.model
  })
  await saveMessageAndBlocksToDB(assistantMessage, [])

  await runAgentSession(userMessage, assistantMessage, assistant, topicId)
}

/**
 * Agent 模式的重新生成入口（对应普通聊天的 regenerateAssistantMessage）。
 *
 * 复用普通重新生成的「重置 assistant 消息 + 删除旧块」逻辑，
 * 但把最终的 fetchAndProcessAssistantResponseImpl（chat 路径）换成
 * runAgentSession（agent 路径）。
 */
export async function regenerateAgentMessage(assistantMessage: Message, assistant: Assistant) {
  const topicId = assistantMessage.topicId

  try {
    // 1. 找到原始用户消息
    const allMessagesForTopic = await messageDatabase.getMessagesByTopicId(topicId)
    const originalUserQuery = allMessagesForTopic.find(m => m.id === assistantMessage.askId)
    if (!originalUserQuery) {
      logger.error(`[regenerateAgentMessage] Original user query ${assistantMessage.askId} not found.`)
      return
    }

    // 2. 重置 assistant 消息（清空块 + 状态置 PENDING）
    const messageToReset = await messageDatabase.getMessageById(assistantMessage.id)
    if (!messageToReset) {
      logger.error(`[regenerateAgentMessage] Assistant message ${assistantMessage.id} not found.`)
      return
    }
    const blockIdsToDelete = [...(messageToReset.blocks || [])]
    const resetMsg = resetAssistantMessage(messageToReset, {
      status: AssistantMessageStatus.PENDING,
      updatedAt: Date.now(),
      model: assistant.model
    })
    await messageDatabase.upsertMessages(resetMsg)

    // 3. 删除旧块
    await cleanupMultipleBlocks(blockIdsToDelete)

    // 4. 走 agent 通道
    await runAgentSession(originalUserQuery, resetMsg, assistant, topicId)
  } catch (error) {
    logger.error('Error in regenerateAgentMessage:', error as Error)
    throw error
  }
}
