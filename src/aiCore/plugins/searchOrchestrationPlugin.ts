/**
 * 搜索编排插件
 *
 * 功能：
 * 1. onRequestStart: 智能意图识别 - 分析是否需要网络搜索、知识库搜索、记忆搜索
 * 2. transformParams: 根据意图分析结果动态添加对应的工具
 * 3. onRequestEnd: 自动记忆存储
 */
import { type AiRequestContext, definePlugin } from '@cherrystudio/ai-core'
// import { generateObject } from '@cherrystudio/ai-core'
import { generateText, type LanguageModel, type ModelMessage } from 'ai'

import {
  SEARCH_SUMMARY_PROMPT,
  SEARCH_SUMMARY_PROMPT_KNOWLEDGE_ONLY,
  SEARCH_SUMMARY_PROMPT_WEB_ONLY
} from '@/config/prompts'
import { getAssistantModel } from '@/services/AssistantService'
import { loggerService } from '@/services/LoggerService'
import { getProviderByModel } from '@/services/ProviderService'
import type { Assistant } from '@/types/assistant'
import type { ExtractResults } from '@/types/extract'
import { extractInfoFromXML } from '@/utils/extract'
import { hasApiKey } from '@/utils/providerUtils'

import { webSearchToolWithPreExtractedKeywords } from '../tools/WebSearchTool'

const logger = loggerService.withContext('SearchOrchestrationPlugin')

const getMessageContent = (message: ModelMessage) => {
  if (typeof message.content === 'string') return message.content
  return message.content.reduce((acc, part) => {
    if (part.type === 'text') {
      return acc + part.text + '\n'
    }

    return acc
  }, '')
}

// === Schema Definitions ===

// const WebSearchSchema = z.object({
//   question: z
//     .array(z.string())
//     .describe('Search queries for web search. Use "not_needed" if no web search is required.'),
//   links: z.array(z.string()).optional().describe('Specific URLs to search or summarize if mentioned in the query.')
// })

// const KnowledgeSearchSchema = z.object({
//   question: z
//     .array(z.string())
//     .describe('Search queries for knowledge base. Use "not_needed" if no knowledge search is required.'),
//   rewrite: z
//     .string()
//     .describe('Rewritten query with alternative phrasing while preserving original intent and meaning.')
// })

// const SearchIntentAnalysisSchema = z.object({
//   websearch: WebSearchSchema.optional().describe('Web search intent analysis results.'),
//   knowledge: KnowledgeSearchSchema.optional().describe('Knowledge base search intent analysis results.')
// })

// type SearchIntentResult = z.infer<typeof SearchIntentAnalysisSchema>

// let isAnalyzing = false
/**
 * 🧠 意图分析函数 - 使用 XML 解析
 */
async function analyzeSearchIntent(
  lastUserMessage: ModelMessage,
  assistant: Assistant,
  options: {
    shouldWebSearch?: boolean
    shouldKnowledgeSearch?: boolean
    shouldMemorySearch?: boolean
    lastAnswer?: ModelMessage
    context: AiRequestContext
    topicId: string
  }
): Promise<ExtractResults | undefined> {
  const { shouldWebSearch = false, shouldKnowledgeSearch = false, lastAnswer, context } = options

  if (!lastUserMessage) return undefined

  // 根据配置决定是否需要提取
  const needWebExtract = shouldWebSearch
  const needKnowledgeExtract = shouldKnowledgeSearch

  if (!needWebExtract && !needKnowledgeExtract) return undefined

  // 选择合适的提示词
  let prompt: string
  // let schema: z.Schema

  if (needWebExtract && !needKnowledgeExtract) {
    prompt = SEARCH_SUMMARY_PROMPT_WEB_ONLY
    // schema = z.object({ websearch: WebSearchSchema })
  } else if (!needWebExtract && needKnowledgeExtract) {
    prompt = SEARCH_SUMMARY_PROMPT_KNOWLEDGE_ONLY
    // schema = z.object({ knowledge: KnowledgeSearchSchema })
  } else {
    prompt = SEARCH_SUMMARY_PROMPT
    // schema = SearchIntentAnalysisSchema
  }

  // 构建消息上下文 - 简化逻辑
  const chatHistory = lastAnswer ? `assistant: ${getMessageContent(lastAnswer)}` : ''
  const question = getMessageContent(lastUserMessage) || ''

  // 使用模板替换变量
  const formattedPrompt = prompt.replace('{chat_history}', chatHistory).replace('{question}', question)

  // 获取模型和provider信息
  const model = getAssistantModel(assistant)
  const provider = getProviderByModel(model)

  if (!provider) {
    logger.error('Provider not found for model', {
      modelId: model.id,
      modelName: model.name,
      providerId: model.provider,
      assistantId: assistant.id,
      assistantName: assistant.name
    })
    return getFallbackResult()
  }

  if (!hasApiKey(provider)) {
    logger.error('Provider API key is missing', {
      modelId: model.id,
      modelName: model.name,
      providerId: provider.id,
      providerName: provider.name,
      assistantId: assistant.id,
      assistantName: assistant.name
    })
    return getFallbackResult()
  }

  // console.log('formattedPrompt', schema)
  try {
    context.isAnalyzing = true
    logger.info('Starting intent analysis generateText call', {
      modelId: model.id,
      topicId: options.topicId,
      requestId: context.requestId,
      hasWebSearch: needWebExtract,
      hasKnowledgeSearch: needKnowledgeExtract
    })

    const { text: result } = await generateText({
      model: context.model as LanguageModel,
      prompt: formattedPrompt
    }).finally(() => {
      logger.info('Intent analysis generateText call completed', {
        modelId: model.id,
        topicId: options.topicId,
        requestId: context.requestId
      })
    })
    const parsedResult = extractInfoFromXML(result)
    logger.debug('Intent analysis result', { parsedResult })

    // 根据需求过滤结果
    return {
      websearch: needWebExtract ? parsedResult?.websearch : undefined,
      knowledge: needKnowledgeExtract ? parsedResult?.knowledge : undefined
    }
  } catch (e: any) {
    logger.error('Intent analysis failed', e as Error)
    return getFallbackResult()
  }

  function getFallbackResult(): ExtractResults {
    const fallbackContent = getMessageContent(lastUserMessage)
    return {
      websearch: shouldWebSearch ? { question: [fallbackContent || 'search'] } : undefined,
      knowledge: shouldKnowledgeSearch
        ? {
            question: [fallbackContent || 'search'],
            rewrite: fallbackContent || 'search'
          }
        : undefined
    }
  }
}

/**
 * 🎯 搜索编排插件
 */
export const searchOrchestrationPlugin = (assistant: Assistant, topicId: string) => {
  // 存储意图分析结果
  const intentAnalysisResults: { [requestId: string]: ExtractResults } = {}
  const userMessages: { [requestId: string]: ModelMessage } = {}

  return definePlugin({
    name: 'search-orchestration',
    enforce: 'pre', // 确保在其他插件之前执行

    /**
     * 🔍 Step 1: 意图识别阶段
     */
    onRequestStart: async (context: AiRequestContext) => {
      // 没开启任何搜索则不进行意图分析
      if (!assistant.webSearchProviderId) return

      try {
        const messages = context.originalParams.messages

        if (!messages || messages.length === 0) {
          return
        }

        const lastUserMessage = messages[messages.length - 1]
        const lastAssistantMessage = messages.length >= 2 ? messages[messages.length - 2] : undefined

        // 存储用户消息用于后续记忆存储
        userMessages[context.requestId] = lastUserMessage

        const shouldWebSearch = !!assistant.webSearchProviderId

        // 执行意图分析
        if (shouldWebSearch) {
          const analysisResult = await analyzeSearchIntent(lastUserMessage, assistant, {
            shouldWebSearch,
            shouldKnowledgeSearch: false,
            shouldMemorySearch: false,
            lastAnswer: lastAssistantMessage,
            context,
            topicId
          })

          if (analysisResult) {
            intentAnalysisResults[context.requestId] = analysisResult
            // logger.info('🧠 Intent analysis completed:', analysisResult)
          }
        }
      } catch (error) {
        logger.error('🧠 Intent analysis failed:', error as Error)
        // 不抛出错误，让流程继续
      }
    },

    /**
     * 🔧 Step 2: 工具配置阶段
     */
    transformParams: async (params: any, context: AiRequestContext) => {
      // logger.info('🔧 Configuring tools based on intent...', context.requestId)

      try {
        const analysisResult = intentAnalysisResults[context.requestId]
        // if (!analysisResult || !assistant) {
        //   logger.info('🔧 No analysis result or assistant, skipping tool configuration')
        //   return params
        // }

        // 确保 tools 对象存在
        if (!params.tools) {
          params.tools = {}
        }

        // 🌐 网络搜索工具配置 (排除 builtin，builtin 使用模型原生搜索能力)
        if (analysisResult?.websearch && assistant.webSearchProviderId && assistant.webSearchProviderId !== 'builtin') {
          const needsSearch = analysisResult.websearch.question && analysisResult.websearch.question[0] !== 'not_needed'

          if (needsSearch) {
            // onChunk({ type: ChunkType.EXTERNEL_TOOL_IN_PROGRESS })
            // logger.info('🌐 Adding web search tool with pre-extracted keywords')
            params.tools['builtin_web_search'] = webSearchToolWithPreExtractedKeywords(
              assistant.webSearchProviderId,
              analysisResult.websearch,
              context.requestId
            )
          }
        }

        // logger.info('🔧 Tools configured:', Object.keys(params.tools))
        return params
      } catch (error) {
        logger.error('🔧 Tool configuration failed:', error as Error)
        return params
      }
    },

    /**
     * 💾 Step 3: 记忆存储阶段
     */

    onRequestEnd: async (context: AiRequestContext) => {
      // context.isAnalyzing = false
      // logger.info('context.isAnalyzing', context, result)
      // logger.info('💾 Starting memory storage...', context.requestId)

      try {
        // 清理缓存
        delete intentAnalysisResults[context.requestId]
        delete userMessages[context.requestId]
      } catch (error) {
        logger.error('💾 Memory storage failed:', error as Error)
        // 不抛出错误，避免影响主流程
      }
    }
  })
}

export default searchOrchestrationPlugin
