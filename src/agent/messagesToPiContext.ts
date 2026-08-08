import type {
  AssistantMessage,
  ImageContent,
  Message as PiMessage,
  TextContent,
  UserMessage
} from '@earendil-works/pi-ai'
import { File } from 'expo-file-system'

import { convertFileBlockToTextPart } from '@/aiCore/prepareParams/fileProcessor'
import { isVisionModel } from '@/config/models'
import { loggerService } from '@/services/LoggerService'
import type { Model } from '@/types/assistant'
import type { Message, ToolMessageBlock } from '@/types/message'
import { AssistantMessageStatus, MessageBlockType } from '@/types/message'
import { findAllBlocks, findFileBlocks, findImageBlocks, getMainTextContent } from '@/utils/messageUtils/find'

const logger = loggerService.withContext('messagesToPiContext')

export async function messageToPiUserMessage(message: Message, model: Model): Promise<UserMessage> {
  const textParts: string[] = []
  const content: (TextContent | ImageContent)[] = []
  const mainText = await getMainTextContent(message)
  if (mainText.trim()) {
    textParts.push(mainText)
  }

  for (const fileBlock of await findFileBlocks(message)) {
    const textPart = await convertFileBlockToTextPart(fileBlock)
    if (textPart?.text.trim()) {
      textParts.push(textPart.text)
    } else {
      textParts.push(
        `[Attached file: ${fileBlock.file.origin_name}. Its contents could not be extracted on this device.]`
      )
    }
  }

  if (textParts.length > 0) {
    content.push({ type: 'text', text: textParts.join('\n\n') })
  }

  const imageBlocks = await findImageBlocks(message)
  if (imageBlocks.length > 0 && !isVisionModel(model)) {
    content.push({
      type: 'text',
      text: `[${imageBlocks.length} attached image(s) were not included because the selected model does not support image input.]`
    })
  } else {
    for (const imageBlock of imageBlocks) {
      try {
        if (imageBlock.file) {
          const image = new File(imageBlock.file.path)
          content.push({
            type: 'image',
            data: await image.base64(),
            mimeType: image.type || 'image/jpeg'
          })
        } else if (imageBlock.url) {
          const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(imageBlock.url)
          content.push({
            type: 'image',
            data: dataUrlMatch?.[2] ?? imageBlock.url,
            mimeType: dataUrlMatch?.[1] ?? 'image/jpeg'
          })
        }
      } catch (error) {
        logger.warn('Failed to load an image for the agent prompt:', error as Error)
        content.push({ type: 'text', text: '[An attached image could not be read on this device.]' })
      }
    }
  }

  return {
    role: 'user',
    content,
    timestamp: message.createdAt
  }
}

/**
 * 把当前 topic 的历史消息转换为 pi-agent 的上下文消息。
 *
 * 首版简化：
 * - 用户消息 → 主文本
 * - assistant 消息（成功/暂停）→ 主文本 + 工具调用摘要（"[tool name(args) → result]"）
 * - 图片/文件/引用等块降级为跳过（不进入 agent 上下文）
 * - 工具历史以文本摘要形式注入，让 agent 知道之前执行过什么
 */
async function getToolSummary(message: Message): Promise<string[]> {
  const blocks = await findAllBlocks(message)
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type !== MessageBlockType.TOOL) continue
    const toolBlock = block as ToolMessageBlock
    const args = toolBlock.arguments ? ` ${JSON.stringify(toolBlock.arguments)}` : ''
    const content =
      typeof toolBlock.content === 'string'
        ? toolBlock.content
        : toolBlock.content
          ? JSON.stringify(toolBlock.content)
          : ''
    if (toolBlock.toolName) {
      parts.push(`[tool ${toolBlock.toolName}${args}${content ? ` → ${content}` : ''}]`)
    }
  }
  return parts
}

export async function messagesToPiContext(messages: Message[], model: Model): Promise<PiMessage[]> {
  const pi: PiMessage[] = []

  for (const msg of messages) {
    if (!msg.blocks?.length) continue

    if (msg.role === 'user') {
      const userMessage = await messageToPiUserMessage(msg, model)
      if (userMessage.content.length > 0) {
        pi.push(userMessage)
      }
      continue
    }

    if (
      msg.role === 'assistant' &&
      (msg.status === AssistantMessageStatus.SUCCESS || msg.status === AssistantMessageStatus.PAUSED)
    ) {
      const text = await getMainTextContent(msg)
      const toolParts = await getToolSummary(msg)
      const content = [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...toolParts.map(t => ({ type: 'text' as const, text: t }))
      ]
      if (content.length === 0) continue

      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content,
        api: 'custom',
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp: msg.createdAt
      }
      pi.push(assistantMsg)
    }
  }

  return pi
}
