import type { AssistantMessage, Message as PiMessage } from '@earendil-works/pi-ai'

import type { Message, ToolMessageBlock } from '@/types/message'
import { AssistantMessageStatus, MessageBlockType } from '@/types/message'
import { findAllBlocks, getMainTextContent } from '@/utils/messageUtils/find'

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

export async function messagesToPiContext(
  messages: Message[],
  modelId: string,
  providerId: string
): Promise<PiMessage[]> {
  const pi: PiMessage[] = []

  for (const msg of messages) {
    if (!msg.blocks?.length) continue

    if (msg.role === 'user') {
      const text = await getMainTextContent(msg)
      if (text) {
        pi.push({ role: 'user', content: text, timestamp: msg.createdAt } as PiMessage)
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
        provider: providerId,
        model: modelId,
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
