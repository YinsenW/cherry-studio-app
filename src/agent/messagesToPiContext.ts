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
import type { ImageMessageBlock, Message, MessageBlock, ToolMessageBlock } from '@/types/message'
import { AssistantMessageStatus, MessageBlockType } from '@/types/message'
import { findAllBlocks } from '@/utils/messageUtils/find'

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
  return messageBlocksToPiUserMessage(message, model, await findAllBlocks(message), options)
}

async function messageBlocksToPiUserMessage(
  message: Message,
  model: Model,
  blocks: MessageBlock[],
  options: AgentMessageConversionOptions
): Promise<UserMessage> {
  const textParts: string[] = []
  const content: (TextContent | ImageContent)[] = []
  const mainText = blocks
    .filter(block => block.type === MessageBlockType.MAIN_TEXT)
    .map(block => block.content)
    .join('\n\n')
  if (mainText.trim()) {
    textParts.push(mainText)
  }

  const files = [
    ...new Map(
      blocks.flatMap(block => {
        if (block.type === MessageBlockType.FILE) return [[block.file.id, block.file] as const]
        if (block.type === MessageBlockType.IMAGE && block.file) return [[block.file.id, block.file] as const]
        return []
      })
    ).values()
  ]
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

  const imageBlocks = blocks.filter((block): block is ImageMessageBlock => block.type === MessageBlockType.IMAGE)
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
function getToolSummary(blocks: MessageBlock[]): string[] {
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
  const converted = await Promise.all(
    messages.map(async (msg): Promise<PiMessage | null> => {
      if (!msg.blocks?.length) return null
      const blocks = await findAllBlocks(msg)
      if (blocks.length === 0) return null

      if (msg.role === 'user') {
        const userMessage = await messageBlocksToPiUserMessage(msg, model, blocks, {
          attachmentGroupPath: attachmentHistoryGroupPath(msg.id),
          attachmentScope: 'history',
          attachmentToolsAvailable: options.attachmentToolsAvailable,
          includeImages: false
        })
        return userMessage.content.length > 0 ? userMessage : null
      }

      if (
        msg.role === 'assistant' &&
        (msg.status === AssistantMessageStatus.SUCCESS || msg.status === AssistantMessageStatus.PAUSED)
      ) {
        const text = blocks
          .filter(block => block.type === MessageBlockType.MAIN_TEXT)
          .map(block => block.content)
          .join('\n\n')
        const toolParts = getToolSummary(blocks)
        const content = [
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...toolParts.map(t => ({ type: 'text' as const, text: t }))
        ]
        if (content.length === 0) return null

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
        return assistantMsg
      }

      return null
    })
  )

  return converted.filter((message): message is PiMessage => message !== null)
}
