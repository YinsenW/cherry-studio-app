import { messageDatabase } from '@database'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Tool } from 'ai'

import { getActualProvider } from '@/aiCore/provider/providerConfig'
import { BUILTIN_TOOLS, type BuiltinMcpId } from '@/config/mcp'
import { isFunctionCallingModel } from '@/config/models'
import { fetchTopicNaming } from '@/services/ApiService'
import { assistantService, getAssistantModel, getAssistantSettings } from '@/services/AssistantService'
import { ConversationService } from '@/services/ConversationService'
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
import { AssistantMessageStatus, MessageBlockType } from '@/types/message'
import { addAbortController, removeAbortController } from '@/utils/abortController'
import { isAbortError, serializeError } from '@/utils/error'
import { createAssistantMessage, createErrorBlock, resetAssistantMessage } from '@/utils/messageUtils/create'
import { findAllBlocks } from '@/utils/messageUtils/find'

import { AgentService } from './AgentService'
import { createAgentEventToChunk } from './agentToChunk'
import { messagesToPiContext, messageToPiUserMessage } from './messagesToPiContext'
import { aiSdkToolToAgentTool } from './toolAdapter'
import { buildAgentSystemPrompt } from './workspace/agentPrompt'
import type { AgentRuntimeSession } from './workspace/AgentRuntimeService'
import { agentRuntimeService } from './workspace/AgentRuntimeService'
import { createMobileWorkspaceTools } from './workspace/mobileWorkspaceTools'
import { ToolApprovalCoordinator } from './workspace/ToolApprovalCoordinator'
import type { WorkspaceBackend } from './workspace/types'
import { workspaceService } from './workspace/WorkspaceService'

const logger = loggerService.withContext('sendAgentMessage')

const AGENT_TIMEOUT_MS = 120_000
const AGENT_PROTOCOL_ERROR_MESSAGE = 'The agent session ended without a terminal event.'

async function persistFallbackAgentError(assistantMessage: Message, topicId: Topic['id'], error: Error): Promise<void> {
  const existingMessage = await messageDatabase.getMessageById(assistantMessage.id)
  if (!existingMessage) {
    throw new Error(`Unable to persist agent error because assistant message ${assistantMessage.id} was not found.`, {
      cause: error
    })
  }

  const existingBlocks = await findAllBlocks(existingMessage)
  const hasErrorBlock = existingBlocks.some(block => block.type === MessageBlockType.ERROR)
  const errorBlock = hasErrorBlock ? null : createErrorBlock(assistantMessage.id, serializeError(error as never))
  const status = isAbortError(error) ? AssistantMessageStatus.PAUSED : AssistantMessageStatus.ERROR
  const updatedMessage: Message = {
    ...existingMessage,
    status,
    updatedAt: Date.now(),
    blocks: errorBlock ? [...existingMessage.blocks, errorBlock.id] : existingMessage.blocks
  }

  await saveMessageAndBlocksToDB(updatedMessage, errorBlock ? [errorBlock] : [])
}

/**
 * Normal chat requests fall back to the app default model when an assistant
 * has not selected one yet. Keep the agent path aligned so a freshly seeded
 * default assistant can send its first message.
 */
function resolveAgentAssistant(assistant: Assistant): Assistant {
  const model = getAssistantModel(assistant)
  if (assistant.model === model) {
    return assistant
  }

  return {
    ...assistant,
    model
  }
}

/**
 * Navigation and React rendering can briefly retain the Assistant snapshot
 * from before a marketplace install completed. Re-read the service cache at
 * session start so a just-attached MCP server is never lost because the send
 * button still holds an older object.
 */
async function resolveLatestAgentAssistant(assistant: Assistant): Promise<Assistant> {
  try {
    const latestAssistant = await assistantService.getAssistant(assistant.id)
    return resolveAgentAssistant(latestAssistant ?? assistant)
  } catch (error) {
    logger.warn(`Unable to refresh assistant ${assistant.id}; using the supplied snapshot:`, error as Error)
    return resolveAgentAssistant(assistant)
  }
}

/**
 * Keep the core LLM path independent from the optional MCP runtime. In
 * particular, loading optional MCP integration must not prevent an assistant
 * with no MCP servers from replying.
 */
async function loadMcpAgentTools(assistant: Assistant): Promise<AgentTool[]> {
  if (!assistant.mcpServers?.length) {
    return []
  }

  try {
    // Keep this module lazy so an optional MCP-runtime initialization failure
    // cannot break the core reply path. A literal require is also resolved
    // deterministically by Metro and Jest in release/test CommonJS bundles.
    const { createMcpTools } = require('../aiCore/tools/SystemTools/McpTools') as {
      createMcpTools: (assistant: Assistant) => Promise<AgentTool[]>
    }
    return await createMcpTools(assistant)
  } catch (error) {
    logger.warn('Agent will continue without MCP tools because MCP initialization failed:', error as Error)
    return []
  }
}

type AiToolRecord = Partial<Record<string, Tool>>

async function loadAiToolRecord(label: string, loader: () => Promise<AiToolRecord>): Promise<AiToolRecord> {
  try {
    return await loader()
  } catch (error) {
    logger.warn(`Agent will continue without ${label} tools because their module failed to load:`, error as Error)
    return {}
  }
}

function validateAgentTools(tools: AgentTool[]): AgentTool[] {
  const accepted: AgentTool[] = []
  const names = new Set<string>()

  for (const tool of tools) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
      logger.warn(`Skipping agent tool with provider-incompatible name: ${tool.name}`)
      continue
    }
    if (names.has(tool.name)) {
      logger.warn(`Skipping duplicate agent tool name: ${tool.name}`)
      continue
    }
    names.add(tool.name)
    accepted.push(tool)
  }

  return accepted
}

/**
 * Model-name detection is necessarily incomplete for custom providers. An
 * explicit function tool-use selection is the user's authoritative signal
 * that the configured model accepts tools.
 */
function shouldLoadBuiltInAgentTools(assistant: Assistant): boolean {
  const model = getAssistantModel(assistant)
  return Boolean(model && (assistant.settings?.toolUseMode === 'function' || isFunctionCallingModel(model)))
}

async function loadAgentTools(
  assistant: Assistant,
  topicId?: Topic['id'],
  providedWorkspaceBackend?: WorkspaceBackend | null,
  runtimeSession?: AgentRuntimeSession | null
): Promise<AgentTool[]> {
  if (!shouldLoadBuiltInAgentTools(assistant)) {
    return []
  }

  const records = await Promise.all([
    loadAiToolRecord('system', async () => (await import('@/aiCore/tools/SystemTools')).SystemTool),
    loadAiToolRecord('Android', async () => (await import('@/aiCore/tools/SystemTools/AndroidTools')).AndroidTool),
    loadAiToolRecord('compute', async () => (await import('@/aiCore/tools/SystemTools/ComputeTools')).ComputeTool),
    loadAiToolRecord('API', async () => (await import('@/aiCore/tools/SystemTools/ApiTools')).ApiTool),
    loadAiToolRecord('Feishu', async () => (await import('@/aiCore/tools/SystemTools/FeishuTools')).FeishuTool),
    loadAiToolRecord('GitHub', async () => (await import('@/aiCore/tools/SystemTools/GithubTools')).GithubTool),
    loadAiToolRecord('OAuth', async () => (await import('@/agent/oauth/oauthTools')).OAuthTool),
    loadAiToolRecord('LLM subtask', async () =>
      (await import('@/aiCore/tools/SystemTools/LlmTools')).createLlmTools(assistant)
    )
  ])

  // Once an in-memory server is explicitly attached, its MCP configuration
  // (active state and disabledTools) becomes authoritative. Do not inject a
  // second unconditional SystemTool copy that would bypass those controls.
  const mcpManagedBuiltInToolNames = new Set(
    (assistant.mcpServers ?? []).flatMap(server =>
      (BUILTIN_TOOLS[server.id as BuiltinMcpId] ?? []).map(tool => tool.name)
    )
  )
  const builtInTools: AgentTool[] = []
  for (const [recordIndex, record] of records.entries()) {
    for (const [name, tool] of Object.entries(record)) {
      if (!tool) continue
      if (recordIndex === 0 && mcpManagedBuiltInToolNames.has(name)) continue
      try {
        builtInTools.push(aiSdkToolToAgentTool(name, tool))
      } catch (error) {
        logger.warn(`Skipping agent tool ${name} because its schema could not be converted:`, error as Error)
      }
    }
  }

  let mobileWorkspaceTools: AgentTool[] = []
  if (providedWorkspaceBackend) {
    mobileWorkspaceTools = createMobileWorkspaceTools(providedWorkspaceBackend, topicId ? { topicId } : undefined, {
      ...(runtimeSession ? { publishFile: runtimeSession.publishFile.bind(runtimeSession) } : {})
    })
  } else if (providedWorkspaceBackend === undefined && topicId) {
    try {
      const workspaceBackend = await workspaceService.getBackendForTopic(topicId)
      mobileWorkspaceTools = createMobileWorkspaceTools(workspaceBackend, topicId ? { topicId } : undefined)
    } catch (error) {
      logger.warn('Agent will continue without mobile workspace tools:', error as Error)
    }
  }

  return validateAgentTools([...mobileWorkspaceTools, ...builtInTools, ...(await loadMcpAgentTools(assistant))])
}

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
  let unsubscribeAgentEvents: (() => void) | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let abortAgent: (() => void) | null = null
  let runtimeSession: AgentRuntimeSession | null = null
  let runOutcome: 'success' | 'error' | 'aborted' = 'error'
  let runError: Error | null = null
  const resolvedAssistant = await resolveLatestAgentAssistant(assistant)
  // Keep "allow this session" scoped to one agent run. A global singleton
  // would accidentally carry a previous approval into a later conversation.
  const approvalCoordinator = new ToolApprovalCoordinator()

  try {
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
      assistant: resolvedAssistant,
      startTime: Date.now()
    })
    streamProcessor = createStreamProcessor(callbacks)
    const processChunk = (chunk: Parameters<ReturnType<typeof createStreamProcessor>>[0]) => streamProcessor!(chunk)
    await topicService.updateTopic(topicId, { isLoading: true })

    // 2. 读取历史并转换为 pi 上下文。本次用户消息会由 prompt()
    // 注入，所以和 assistant 占位消息一起排除，避免同一条问题发送两次。
    const allMessages = await messageDatabase.getMessagesByTopicId(topicId)
    const { contextCount } = getAssistantSettings(resolvedAssistant)
    const filteredMessages = ConversationService.filterMessagesPipeline(
      allMessages.filter(message => message.id !== assistantMessage.id),
      contextCount
    )
    const contextMessages = await messagesToPiContext(
      filteredMessages.filter(message => message.id !== userMessage.id),
      resolvedAssistant.model!
    )

    // 3. 构造 agent 工具集：系统 + Android + 计算 + LLM 子任务 + 免费 API + 飞书 + GitHub + 用户 MCP 服务器
    const configuredProvider = await getAssistantProvider(resolvedAssistant)
    const provider = getActualProvider(resolvedAssistant.model!, configuredProvider)
    // Built-in tools still respect the model capability gate. A configured
    // MCP server is different: its tools are an explicit user choice and
    // must be registered even when a custom model is absent from Cherry's
    // model-name capability table.
    const canUseBuiltInAgentTools = shouldLoadBuiltInAgentTools(resolvedAssistant)
    const hasConfiguredMcp = (resolvedAssistant.mcpServers?.length ?? 0) > 0
    let workspaceBackend: WorkspaceBackend | null = null
    if (canUseBuiltInAgentTools) {
      try {
        runtimeSession = await agentRuntimeService.startRun({
          topicId,
          userMessage,
          assistantMessageId: assistantMessage.id,
          historyMessages: filteredMessages
        })
        workspaceBackend = runtimeSession.backend
      } catch (error) {
        // A database migration, native file-system permission, or an older
        // test/runtime may temporarily make the workspace unavailable. The
        // core agent remains useful with its other tools; do not fail the
        // whole conversation just because the optional mobile filesystem is
        // unavailable.
        logger.warn('Agent will continue without private mobile runtime tools:', error as Error)
      }
    }
    const workspace =
      workspaceBackend?.descriptor ??
      ({
        id: 'default-mobile-workspace',
        name: '手机工作区',
        kind: 'app_sandbox',
        rootUri: '',
        readOnly: false,
        createdAt: 0,
        updatedAt: 0
      } as const)
    const tools = canUseBuiltInAgentTools
      ? await loadAgentTools(resolvedAssistant, topicId, workspaceBackend, runtimeSession)
      : hasConfiguredMcp
        ? validateAgentTools(await loadMcpAgentTools(resolvedAssistant))
        : []
    const agentService = new AgentService(
      resolvedAssistant.model!,
      provider,
      tools,
      buildAgentSystemPrompt(resolvedAssistant.prompt || undefined, workspace),
      contextMessages as never[],
      resolvedAssistant,
      {
        toolExecution: 'parallel',
        beforeToolCall: approvalCoordinator.beforeToolCall.bind(approvalCoordinator)
      }
    )

    // 4. 事件 → chunk → 现有块流
    const eventAdapter = createAgentEventToChunk(processChunk)
    unsubscribeAgentEvents = agentService.subscribe(eventAdapter)

    // 5. 中止：绑定到现有「暂停/停止」机制
    abortAgent = () => agentService.abort()
    addAbortController(userMessage.id, abortAgent)

    const userPrompt = await messageToPiUserMessage(userMessage, resolvedAssistant.model!)
    if (userPrompt.content.length === 0) {
      throw new Error('The message did not contain any text or supported attachment content.')
    }

    // 6. 超时兜底：普通聊天路径有 timeout:30000，agent 可能多轮，给 120s。
    // 否则网络卡住时 prompt 永不返回 → 一直转圈。
    await Promise.race([
      agentService.prompt(userPrompt),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          agentService.abort()
          reject(new Error('Agent 响应超时（120s），已自动停止。请检查网络或重试。'))
        }, AGENT_TIMEOUT_MS)
      })
    ])

    await streamProcessor.drain()

    // prompt() is expected to settle only after the awaited agent_end listener.
    // Treat a missing protocol terminal as an error; never synthesize success
    // from an absence of events.
    if (!eventAdapter.getState().agentEnded || streamProcessor.getTerminalStatus() === null) {
      const protocolError = new Error(AGENT_PROTOCOL_ERROR_MESSAGE) as Error & { code: string }
      protocolError.code = 'AGENT_PROTOCOL_INCOMPLETE'
      await streamProcessor({ type: ChunkType.ERROR, error: protocolError })
      await streamProcessor.drain()
    }

    if (
      runtimeSession &&
      eventAdapter.getState().agentEnded &&
      streamProcessor.getTerminalStatus() === AssistantMessageStatus.SUCCESS
    ) {
      try {
        await runtimeSession.publishPendingOutputs()
      } catch (error) {
        const publicationError = new Error('Agent completed, but one or more output files could not be published.', {
          cause: error
        })
        ;(publicationError as Error & { code: string }).code = 'AGENT_ARTIFACT_PUBLISH_FAILED'
        throw publicationError
      }
    }

    const persistedMessage = await messageDatabase.getMessageById(assistantMessage.id)
    if (
      !persistedMessage ||
      persistedMessage.status === AssistantMessageStatus.PENDING ||
      persistedMessage.status === AssistantMessageStatus.PROCESSING
    ) {
      await persistFallbackAgentError(
        assistantMessage,
        topicId,
        new Error('The agent session finished without persisting a terminal message state.')
      )
    }
    const finalMessage = await messageDatabase.getMessageById(assistantMessage.id)
    runOutcome = finalMessage?.status === AssistantMessageStatus.SUCCESS ? 'success' : 'error'
  } catch (error) {
    logger.error('Error in agent session:', error as Error)
    // 让错误在聊天 UI 可见（不再静默无响应）
    const sessionError = error instanceof Error ? error : new Error(String(error))
    runError = sessionError
    runOutcome = isAbortError(sessionError) ? 'aborted' : 'error'
    await streamProcessor?.({
      type: ChunkType.ERROR,
      error: sessionError
    })
    await streamProcessor?.drain()

    const persistedMessage = await messageDatabase.getMessageById(assistantMessage.id)
    if (
      !persistedMessage ||
      persistedMessage.status === AssistantMessageStatus.PENDING ||
      persistedMessage.status === AssistantMessageStatus.PROCESSING ||
      (sessionError as Error & { code?: string }).code === 'AGENT_ARTIFACT_PUBLISH_FAILED'
    ) {
      await persistFallbackAgentError(assistantMessage, topicId, sessionError)
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    if (abortAgent) {
      removeAbortController(userMessage.id, abortAgent)
    }
    unsubscribeAgentEvents?.()

    if (runtimeSession) {
      try {
        await runtimeSession.finish(runOutcome, runError?.message)
      } catch (error) {
        logger.warn('Unable to finalize private Agent runtime:', error as Error)
      }
    }

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
    throw new Error('Cannot send an agent message without text or attachment blocks.')
  }

  await saveMessageAndBlocksToDB(userMessage, userMessageBlocks)

  const resolvedAssistant = resolveAgentAssistant(assistant)
  const assistantMessage = createAssistantMessage(resolvedAssistant.id, topicId, {
    askId: userMessage.id,
    model: resolvedAssistant.model
  })
  await saveMessageAndBlocksToDB(assistantMessage, [])

  await runAgentSession(userMessage, assistantMessage, resolvedAssistant, topicId)
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
  const resolvedAssistant = resolveAgentAssistant(assistant)

  try {
    // 1. 找到原始用户消息
    const allMessagesForTopic = await messageDatabase.getMessagesByTopicId(topicId)
    const originalUserQuery = allMessagesForTopic.find(m => m.id === assistantMessage.askId)
    if (!originalUserQuery) {
      throw new Error(`[regenerateAgentMessage] Original user query ${assistantMessage.askId} not found.`)
    }

    // 2. 重置 assistant 消息（清空块 + 状态置 PENDING）
    const messageToReset = await messageDatabase.getMessageById(assistantMessage.id)
    if (!messageToReset) {
      throw new Error(`[regenerateAgentMessage] Assistant message ${assistantMessage.id} not found.`)
    }
    const blockIdsToDelete = [...(messageToReset.blocks || [])]
    const resetMsg = resetAssistantMessage(messageToReset, {
      status: AssistantMessageStatus.PENDING,
      updatedAt: Date.now(),
      model: resolvedAssistant.model
    })
    await messageDatabase.upsertMessages(resetMsg)

    // 3. 删除旧块
    await cleanupMultipleBlocks(blockIdsToDelete)

    // 4. 走 agent 通道
    await runAgentSession(originalUserQuery, resetMsg, resolvedAssistant, topicId)
  } catch (error) {
    logger.error('Error in regenerateAgentMessage:', error as Error)
    throw error
  }
}
