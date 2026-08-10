import { messageDatabase } from '@database'
import { t } from 'i18next'
import { isEmpty, takeRight } from 'lodash'

import LegacyAiProvider from '@/aiCore'
import type { CompletionsParams } from '@/aiCore/legacy/middleware/schemas'
import type { AiSdkMiddlewareConfig } from '@/aiCore/middleware/AiSdkMiddlewareBuilder'
import { buildStreamTextParams } from '@/aiCore/prepareParams'
import { isDedicatedImageGenerationModel, isEmbeddingModel } from '@/config/models'
import i18n from '@/i18n'
import { loggerService } from '@/services/LoggerService'
import type { Assistant, FetchChatCompletionParams, Model, Provider } from '@/types/assistant'
import { ChunkType } from '@/types/chunk'
import type { MCPServer } from '@/types/mcp'
import type { SdkModel } from '@/types/sdk'
import type { MCPTool } from '@/types/tool'
import { isPromptToolUse, isSupportedToolUse } from '@/utils/mcpTool'
import { findFileBlocks, getMainTextContent } from '@/utils/messageUtils/find'
import { hasApiKey } from '@/utils/providerUtils'

import AiProviderNew from '../aiCore/index_new'
import { assistantService, getAssistantModel, getDefaultModel } from './AssistantService'
import { mcpService } from './McpService'
import { getAssistantProvider } from './ProviderService'
import type { StreamProcessorCallbacks } from './StreamProcessingService'
import { createStreamProcessor } from './StreamProcessingService'
import { topicService } from './TopicService'

const logger = loggerService.withContext('fetchChatCompletion')
const ASSISTANT_MCP_DISCOVERY_TIMEOUT_MS = 8_000

export type AssistantMcpDiscoveryOptions = {
  perServerTimeoutMs?: number
}

async function getMcpToolsWithinStartupBudget(server: MCPServer, timeoutMs: number): Promise<MCPTool[]> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutResult = new Promise<MCPTool[]>(resolve => {
    timeoutId = setTimeout(() => {
      logger.warn(`MCP tool discovery exceeded the Agent startup budget for ${server.name}`, {
        serverId: server.id,
        timeoutMs
      })
      resolve([])
    }, timeoutMs)
  })

  try {
    // Do not abort the underlying discovery when the startup budget expires.
    // It can still finish in the background and warm McpService's cache for
    // the next turn, while this Agent request continues with the fast servers.
    return await Promise.race([mcpService.getMcpTools(server.id), timeoutResult])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export async function fetchChatCompletion({
  messages,
  prompt,
  assistant,
  options,
  onChunkReceived,
  topicId,
  uiMessages
}: FetchChatCompletionParams) {
  const assistantModel = getAssistantModel(assistant)
  const assistantForRequest = assistant.model ? assistant : { ...assistant, model: assistantModel }
  const AI = new AiProviderNew(assistantModel)
  const provider = AI.getActualProvider()

  const mcpTools: MCPTool[] = []

  onChunkReceived({ type: ChunkType.LLM_RESPONSE_CREATED })

  if (isPromptToolUse(assistantForRequest) || isSupportedToolUse(assistantForRequest)) {
    mcpTools.push(...(await fetchAssistantMcpTools(assistantForRequest)))
  }

  if (prompt) {
    messages = [
      {
        role: 'user',
        content: prompt
      }
    ]
  }

  // 使用 transformParameters 模块构建参数
  const {
    params: aiSdkParams,
    modelId,
    capabilities,
    webSearchPluginConfig
  } = await buildStreamTextParams(messages, assistantForRequest, provider, {
    mcpTools: mcpTools,
    webSearchProviderId: assistant.webSearchProviderId,
    requestOptions: options
  })

  const middlewareConfig: AiSdkMiddlewareConfig = {
    streamOutput: assistant.settings?.streamOutput ?? true,
    onChunk: onChunkReceived,
    model: assistantModel,
    enableReasoning: capabilities.enableReasoning,
    isPromptToolUse: isPromptToolUse(assistantForRequest),
    isSupportedToolUse: isSupportedToolUse(assistantForRequest),
    isImageGenerationEndpoint: isDedicatedImageGenerationModel(assistantModel),
    enableWebSearch: capabilities.enableWebSearch,
    enableGenerateImage: capabilities.enableGenerateImage,
    enableUrlContext: capabilities.enableUrlContext,
    mcpTools,
    uiMessages,
    webSearchPluginConfig
  }

  // --- Call AI Completions ---
  try {
    await AI.completions(modelId, aiSdkParams, {
      ...middlewareConfig,
      assistant: assistantForRequest,
      topicId,
      callType: 'chat',
      uiMessages
    })
  } catch (error) {
    logger.error('fetchChatCompletion completions failed', error as Error)
    onChunkReceived({ type: ChunkType.ERROR, error: error as any })
    throw error
  }
}

export async function fetchModels(provider: Provider): Promise<SdkModel[]> {
  const AI = new AiProviderNew(provider)

  try {
    return await AI.models()
  } catch (error) {
    logger.error('fetchChatCompletion', error as Error)
    return []
  }
}

export function checkApiProvider(provider: Provider): void {
  if (!hasApiKey(provider)) {
    throw new Error(i18n.t('message.error.enter.api.key'))
  }

  if (!provider.apiHost && provider.type !== 'vertexai') {
    throw new Error(i18n.t('message.error.enter.api.host'))
  }

  if (isEmpty(provider.models)) {
    throw new Error(i18n.t('message.error.enter.model'))
  }
}

export async function checkApi(provider: Provider, model: Model): Promise<void> {
  checkApiProvider(provider)

  const ai = new LegacyAiProvider(provider)

  const assistant: Assistant = {
    id: 'checkApi',
    name: 'Check Api Assistant',
    prompt: '',
    topics: [],
    type: 'external',
    model: model
  }

  try {
    if (isEmbeddingModel(model)) {
      await ai.getEmbeddingDimensions(model)
    } else {
      const params: CompletionsParams = {
        callType: 'check',
        messages: 'hi',
        assistant,
        streamOutput: false,
        shouldThrow: true
      }

      // Try streaming check first
      const result = await ai.completions(params)

      if (!result.getText()) {
        throw new Error('No response received')
      }
    }
  } catch (error: any) {
    logger.error('Check Api Error', error)
    throw error
  }
}

export async function fetchTopicNaming(topicId: string, regenerate: boolean = false) {
  logger.info('Fetching topic naming...')
  const topic = await topicService.getTopic(topicId)
  const messages = await messageDatabase.getMessagesByTopicId(topicId)

  if (!topic) {
    logger.error(`[fetchTopicNaming] Topic with ID ${topicId} not found.`)
    return
  }

  if (topic.name !== t('topics.new_topic') && !regenerate) {
    return
  }

  let callbacks: StreamProcessorCallbacks = {}

  callbacks = {
    onTextComplete: async finalText => {
      await topicService.updateTopic(topicId, { name: finalText.trim() })
    }
  }
  const streamProcessorCallbacks = createStreamProcessor(callbacks)
  const quickAssistant = await assistantService.getAssistant('quick')

  if (!quickAssistant) {
    return
  }

  const quickAssistantModel = quickAssistant.defaultModel || getDefaultModel()
  const assistantForProvider = quickAssistant.model ? quickAssistant : { ...quickAssistant, model: quickAssistantModel }
  const assistantForRequest = quickAssistant.defaultModel
    ? assistantForProvider
    : { ...assistantForProvider, defaultModel: quickAssistantModel }
  const provider = await getAssistantProvider(assistantForProvider)

  // 总结上下文总是取最后5条消息
  const contextMessages = takeRight(messages, 5)

  // LLM对多条消息的总结有问题，用单条结构化的消息表示会话内容会更好
  // 构建结构化消息对象（只保留文本和文件名，不传完整文件内容）
  const structuredMessages = await Promise.all(
    contextMessages.map(async message => {
      const mainText = await getMainTextContent(message)
      const fileBlocks = await findFileBlocks(message)
      const fileList = fileBlocks.map(block => block.file.origin_name)

      return {
        role: message.role,
        mainText,
        files: fileList.length > 0 ? fileList : undefined
      }
    })
  )

  const conversation = JSON.stringify(structuredMessages)

  const AI = new AiProviderNew(quickAssistantModel, provider)

  // 使用 system + prompt 格式，而非多条消息格式
  const aiSdkParams = {
    system: quickAssistant.prompt,
    prompt: conversation
  }
  const modelId = quickAssistantModel.id

  const middlewareConfig: AiSdkMiddlewareConfig = {
    streamOutput: false,
    onChunk: streamProcessorCallbacks,
    model: quickAssistantModel,
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
    const completion = await AI.completions(modelId, aiSdkParams, {
      ...middlewareConfig,
      assistant: assistantForRequest,
      topicId,
      callType: 'summary'
    })
    await streamProcessorCallbacks.drain()
    return completion.getText() || t('topics.new_topic')
  } catch (error) {
    logger.error('Error during topic naming:', error)
    return ''
  }
}

/**
 * Fetch MCP tools for an assistant
 *
 * Refactored to use McpService for optimized caching and tool fetching.
 *
 * @param assistant - The assistant with MCP server configuration
 * @returns Array of enabled MCP tools
 */
export async function fetchAssistantMcpTools(assistant: Assistant, options: AssistantMcpDiscoveryOptions = {}) {
  let mcpTools: MCPTool[] = []
  const perServerTimeoutMs = options.perServerTimeoutMs ?? ASSISTANT_MCP_DISCOVERY_TIMEOUT_MS

  // Resolve exactly the server IDs persisted on this Assistant. Looking up
  // the global active-server list first can return a stale snapshot during
  // the install -> attach -> first-message window and silently drops the
  // newly attached server.
  const assistantMcpServerIds = Array.from(new Set((assistant.mcpServers ?? []).map(server => server.id)))
  const enabledMCPs = (
    await Promise.all(
      assistantMcpServerIds.map(async serverId => {
        try {
          const server = await mcpService.getMcpServer(serverId)
          return server?.isActive ? server : null
        } catch (error) {
          logger.warn(`Failed to load MCP server ${serverId} for assistant ${assistant.id}:`, error as Error)
          return null
        }
      })
    )
  ).filter((server): server is MCPServer => server !== null)

  if (enabledMCPs && enabledMCPs.length > 0) {
    try {
      // Fetch tools for each enabled MCP server using McpService
      // This automatically handles disabledTools filtering
      const toolPromises = enabledMCPs.map(async (mcpServer: MCPServer) => {
        try {
          // Use McpService.getMcpTools() which handles:
          // - Builtin tools fetching
          // - Future MCP protocol integration
          // - Automatic filtering of disabledTools
          return await getMcpToolsWithinStartupBudget(mcpServer, perServerTimeoutMs)
        } catch (error) {
          logger.error(`Error fetching tools from MCP server ${mcpServer.name}:`, error as Error)
          return []
        }
      })

      const results = await Promise.allSettled(toolPromises)
      mcpTools = results
        .filter((result): result is PromiseFulfilledResult<MCPTool[]> => result.status === 'fulfilled')
        .map(result => result.value)
        .flat()
    } catch (toolError) {
      logger.error('Error fetching MCP tools:', toolError as Error)
    }
  }

  return mcpTools
}
