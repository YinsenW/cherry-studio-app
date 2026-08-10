import type {
  AssistantMessage,
  ImageContent,
  Message as PiMessage,
  TextContent,
  UserMessage
} from '@earendil-works/pi-ai'
import { File } from 'expo-file-system'

import { isVisionModel } from '@/config/models'
import { loggerService } from '@/services/LoggerService'
import type { Model } from '@/types/assistant'
import type { Message, ToolMessageBlock } from '@/types/message'
import { AssistantMessageStatus, MessageBlockType } from '@/types/message'
import { findAllBlocks, findImageBlocks, getFileContent, getMainTextContent } from '@/utils/messageUtils/find'

import {
  attachmentHistoryGroupPath,
  buildAttachmentManifest,
  buildMountedAttachments
} from './attachments/AttachmentManifest'
import { MAX_AGENT_TOOL_HISTORY_BYTES, truncateAgentText } from './context/AgentContextBudget'

const logger = loggerService.withContext('messagesToPiContext')
const MAX_AGENT_IMAGES = 10
const MAX_AGENT_IMAGE_BYTES = 20 * 1024 * 1024

export type AgentMessageConversionOptions = {
  attachmentGroupPath?: string
  attachmentScope?: 'current' | 'history'
  attachmentToolsAvailable?: boolean
  includeImages?: boolean
}

export async function messageToPiUserMessage(
  message: Message,
  model: Model,
  options: AgentMessageConversionOptions = {}
): Promise<UserMessage> {
  const textParts: string[] = []
  const content: (TextContent | ImageContent)[] = []
  const mainText = await getMainTextContent(message)
  if (mainText.trim()) {
    textParts.push(mainText)
  }

  const files = [...new Map((await getFileContent(message)).map(file => [file.id, file])).values()]
  if (files.length > 0) {
    const attachments = buildMountedAttachments(options.attachmentGroupPath ?? 'current', files, message.id)
    textParts.push(
      buildAttachmentManifest(attachments, {
        scope: options.attachmentScope ?? 'current',
        toolsAvailable: options.attachmentToolsAvailable ?? true
      })
    )
  }

  if (textParts.length > 0) {
    content.push({ type: 'text', text: textParts.join('\n\n') })
  }

  const imageBlocks = await findImageBlocks(message)
  const includeImages = options.includeImages ?? true
  if (imageBlocks.length > 0 && !includeImages) {
    const unmountedImages = imageBlocks.filter(block => !block.file).length
    if (unmountedImages > 0) {
      content.push({
        type: 'text',
        text: `[${unmountedImages} historical image(s) without a local file were omitted from this Agent turn.]`
      })
    }
  } else if (imageBlocks.length > 0 && !isVisionModel(model)) {
    content.push({
      type: 'text',
      text: `[${imageBlocks.length} attached image(s) were not included because the selected model does not support image input.]`
    })
  } else {
    let includedImages = 0
    let includedImageBytes = 0
    let omittedImages = 0
    for (const imageBlock of imageBlocks) {
      try {
        if (imageBlock.file) {
          const image = new File(imageBlock.file.path)
          if (includedImages >= MAX_AGENT_IMAGES || includedImageBytes + image.size > MAX_AGENT_IMAGE_BYTES) {
            omittedImages++
            continue
          }
          content.push({
            type: 'image',
            data: await image.base64(),
            mimeType: image.type || 'image/jpeg'
          })
          includedImages++
          includedImageBytes += image.size
        } else if (imageBlock.url) {
          const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(imageBlock.url)
          const estimatedBytes = dataUrlMatch ? Math.ceil((dataUrlMatch[2].length * 3) / 4) : 0
          if (
            includedImages >= MAX_AGENT_IMAGES ||
            (estimatedBytes > 0 && includedImageBytes + estimatedBytes > MAX_AGENT_IMAGE_BYTES)
          ) {
            omittedImages++
            continue
          }
          content.push({
            type: 'image',
            data: dataUrlMatch?.[2] ?? imageBlock.url,
            mimeType: dataUrlMatch?.[1] ?? 'image/jpeg'
          })
          includedImages++
          includedImageBytes += estimatedBytes
        }
      } catch (error) {
        logger.warn('Failed to load an image for the agent prompt:', error as Error)
        content.push({ type: 'text', text: '[An attached image could not be read on this device.]' })
      }
    }
    if (omittedImages > 0) {
      content.push({
        type: 'text',
        text: `[${omittedImages} image(s) were omitted because Agent image input is limited to ${MAX_AGENT_IMAGES} images and 20 MiB per turn.]`
      })
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
 * - 用户消息 → 主文本 + 有界附件 manifest
 * - assistant 消息（成功/暂停）→ 主文本 + 工具调用摘要（"[tool name(args) → result]"）
 * - 历史图片不重复编码；历史附件只保留只读挂载路径
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
      parts.push(
        truncateAgentText(
          `[tool ${toolBlock.toolName}${args}${content ? ` → ${content}` : ''}]`,
          MAX_AGENT_TOOL_HISTORY_BYTES
        )
      )
    }
  }
  return parts
}

export async function messagesToPiContext(
  messages: Message[],
  model: Model,
  options: Pick<AgentMessageConversionOptions, 'attachmentToolsAvailable'> = {}
): Promise<PiMessage[]> {
  const pi: PiMessage[] = []

  for (const msg of messages) {
    if (!msg.blocks?.length) continue

    if (msg.role === 'user') {
      const userMessage = await messageToPiUserMessage(msg, model, {
        attachmentGroupPath: attachmentHistoryGroupPath(msg.id),
        attachmentScope: 'history',
        attachmentToolsAvailable: options.attachmentToolsAvailable,
        includeImages: false
      })
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
