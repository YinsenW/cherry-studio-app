import type { Message as PiMessage, UserMessage } from '@earendil-works/pi-ai'

const MAX_AGENT_HISTORY_TEXT_BYTES = 512 * 1024
const MAX_AGENT_USER_TEXT_BYTES = 256 * 1024
export const MAX_AGENT_TOOL_HISTORY_BYTES = 24 * 1024

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function messageTextBytes(message: PiMessage): number {
  if (!Array.isArray(message.content)) return typeof message.content === 'string' ? byteLength(message.content) : 0
  return message.content.reduce((total, part) => {
    if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part) {
      return total + byteLength(String(part.text))
    }
    return total
  }, 0)
}

export function truncateAgentText(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return value
  const suffix = '\n[Earlier tool output was truncated by the Agent context budget.]'
  const suffixBytes = byteLength(suffix)
  const prefixBudget = Math.max(0, maxBytes - suffixBytes)
  let prefix = new TextDecoder().decode(bytes.slice(0, prefixBudget))
  while (byteLength(prefix) > prefixBudget) prefix = prefix.slice(0, -1)
  return prefix + suffix
}

/**
 * Newest complete conversation turns are prioritized until the hard byte
 * ceiling is reached, while retained messages stay chronological.
 * This is a safety ceiling for unknown/custom model context windows; provider
 * token accounting remains authoritative.
 */
export function compactAgentContext(messages: PiMessage[]): {
  messages: PiMessage[]
  dropped: number
  textBytes: number
} {
  const groups: PiMessage[][] = []
  let current: PiMessage[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      if (current.length > 0) groups.push(current)
      current = [message]
    } else if (current.length > 0) {
      current.push(message)
    }
  }
  if (current.length > 0) groups.push(current)

  const retainedGroups: PiMessage[][] = []
  let textBytes = 0

  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]
    const size = group.reduce((total, message) => total + messageTextBytes(message), 0)
    if (size > MAX_AGENT_HISTORY_TEXT_BYTES - textBytes) continue
    retainedGroups.unshift(group)
    textBytes += size
  }

  const retained = retainedGroups.flat()
  return { messages: retained, dropped: messages.length - retained.length, textBytes }
}

export function assertAgentUserMessageBudget(message: UserMessage): void {
  const textBytes = messageTextBytes(message)
  if (textBytes > MAX_AGENT_USER_TEXT_BYTES) {
    throw new Error(
      'The message text exceeds the Agent safety budget. Attach large content as a file so the Agent can inspect it incrementally.'
    )
  }
}
