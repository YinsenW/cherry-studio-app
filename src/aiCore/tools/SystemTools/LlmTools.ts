import { generateText, tool } from 'ai'
import { z } from 'zod'

import { createAiSdkProvider } from '@/aiCore/provider/factory'
import { prepareSpecialProviderConfig, providerToAiSdkConfig } from '@/aiCore/provider/providerConfig'
import { loggerService } from '@/services/LoggerService'
import { getAssistantProvider } from '@/services/ProviderService'
import type { Assistant } from '@/types/assistant'

const logger = loggerService.withContext('LlmTools')

/**
 * LLM 子任务工具组。
 *
 * 给 agent 一个"再想一次"的能力：它可以把大任务拆成独立的小 LLM 调用
 * （总结、翻译、提取、审校），而不必把所有逻辑塞进主对话。
 * 复用用户自己的模型与 API key（BYOK，无额外成本）。
 */
export function createLlmTools(assistant: Assistant) {
  const model = assistant.model
  if (!model) {
    return {}
  }

  /** 用当前 assistant 的模型发一次独立请求，返回文本 */
  const ask = async (systemPrompt: string, userPrompt: string, maxTokens?: number): Promise<string> => {
    const provider = await getAssistantProvider(assistant)
    const config = providerToAiSdkConfig(provider, model)
    await prepareSpecialProviderConfig(provider, config)
    const localProvider = await createAiSdkProvider(config)
    if (!localProvider) {
      throw new Error('Failed to create provider instance')
    }
    const aiModel = localProvider.languageModel(model.id)
    const result = await generateText({
      model: aiModel,
      system: systemPrompt,
      prompt: userPrompt,
      ...(maxTokens ? { maxOutputTokens: maxTokens } : {})
    })
    return result.text
  }

  const summarize = tool({
    description:
      'Summarize a piece of text into a concise summary. Use when you need a shorter version of long content.',
    inputSchema: z.object({
      text: z.string().describe('The text to summarize'),
      maxWords: z.number().optional().describe('Approximate max words for the summary')
    }),
    execute: async ({ text, maxWords }) => {
      try {
        const summary = await ask(
          'You are a summarization assistant. Return only the summary, no preamble.',
          `Summarize the following text${maxWords ? ` in about ${maxWords} words` : ''}:\n\n${text}`
        )
        return { ok: true, summary }
      } catch (e) {
        logger.error('summarize failed', e as Error)
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  })

  const translate = tool({
    description:
      'Translate text into the target language. Useful when content is in another language than the user asked for.',
    inputSchema: z.object({
      text: z.string().describe('The text to translate'),
      targetLanguage: z.string().describe('Target language, e.g. "Simplified Chinese", "English", "Japanese"')
    }),
    execute: async ({ text, targetLanguage }) => {
      try {
        const translated = await ask(
          `You are a professional translator. Translate the user text into ${targetLanguage}. Return only the translation.`,
          text
        )
        return { ok: true, translation: translated }
      } catch (e) {
        logger.error('translate failed', e as Error)
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  })

  const extractJson = tool({
    description: 'Extract structured JSON from text or an unstructured description. Returns the extracted JSON object.',
    inputSchema: z.object({
      text: z.string().describe('The text to extract structured data from'),
      schema: z
        .string()
        .optional()
        .describe('Optional description of the JSON shape wanted, e.g. "an array of {title, date}"')
    }),
    execute: async ({ text, schema }) => {
      try {
        const json = await ask(
          'You are a data extraction assistant. Extract the requested structured data and return ONLY valid JSON (no markdown, no explanation).',
          `Extract structured JSON from this text${schema ? ` with this shape: ${schema}` : ''}:\n\n${text}`
        )
        // 去掉可能的 ```json 围栏
        const cleaned = json
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```\s*$/, '')
          .trim()
        const parsed = JSON.parse(cleaned)
        return { ok: true, result: JSON.stringify(parsed, null, 2) }
      } catch (e) {
        logger.error('extractJson failed', e as Error)
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  })

  const analyze = tool({
    description:
      'Ask the model to analyze or reason about content (critique, pros/cons, decision support, proofread). For deep reasoning beyond the main turn.',
    inputSchema: z.object({
      task: z
        .string()
        .describe('What to analyze, e.g. "critique this plan", "proofread this text", "pros and cons of X"'),
      content: z.string().describe('The content to analyze')
    }),
    execute: async ({ task, content }) => {
      try {
        const analysis = await ask(
          'You are a reasoning assistant. Do the requested analysis carefully and return your full analysis.',
          `${task}\n\nContent:\n${content}`
        )
        return { ok: true, analysis }
      } catch (e) {
        logger.error('analyze failed', e as Error)
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  })

  return {
    Summarize: summarize,
    Translate: translate,
    ExtractJson: extractJson,
    Analyze: analyze
  }
}

export type LlmToolKeys = ReturnType<typeof createLlmTools> extends infer T ? keyof T : never
