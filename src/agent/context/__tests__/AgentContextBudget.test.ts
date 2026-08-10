import type { Message as PiMessage, UserMessage } from '@earendil-works/pi-ai'

import { assertAgentUserMessageBudget, compactAgentContext, truncateAgentText } from '../AgentContextBudget'

const user = (text: string): PiMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 })
const assistant = (text: string): PiMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 }) as PiMessage

describe('AgentContextBudget', () => {
  it('drops oldest history and never leaves a dangling assistant prefix', () => {
    const oversized = 'x'.repeat(400 * 1024)
    const recent = 'y'.repeat(200 * 1024)
    const result = compactAgentContext([user(oversized), assistant('old reply'), user(recent)])

    expect(result.messages).toEqual([user(recent)])
    expect(result.dropped).toBe(2)
  })

  it('rejects giant inline prompt text and points users toward attachments', () => {
    const message = user('x'.repeat(300 * 1024)) as UserMessage
    expect(() => assertAgentUserMessageBudget(message)).toThrow('Attach large content as a file')
  })

  it('truncates historical tool output by UTF-8 bytes', () => {
    const result = truncateAgentText('数'.repeat(20_000), 1_000)
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(1_000)
    expect(result).toContain('truncated')
  })
})
