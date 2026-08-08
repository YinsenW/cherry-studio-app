import { createAgentEventToChunk } from '../agentToChunk'

describe('createAgentEventToChunk', () => {
  it('awaits and maps text and tool lifecycle events in order', async () => {
    const chunks: any[] = []
    const adapter = createAgentEventToChunk(async chunk => {
      chunks.push(chunk)
    })

    await adapter({ type: 'agent_start' } as never)
    await adapter({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        partial: { content: [{ type: 'text', text: 'Hello' }] }
      }
    } as never)
    await adapter({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
    } as never)
    await adapter({
      type: 'tool_execution_start',
      toolName: 'lookup',
      toolCallId: 'call-1',
      args: { query: 'weather' }
    } as never)
    await adapter({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      isError: false,
      result: { content: [{ type: 'text', text: 'sunny' }] }
    } as never)
    await adapter({ type: 'agent_end', messages: [] } as never)

    expect(chunks).toEqual([
      { type: 'llm_response_created' },
      { type: 'text.start' },
      { type: 'text.delta', text: 'Hello' },
      { type: 'text.complete', text: 'Hello' },
      expect.objectContaining({
        type: 'mcp_tool_pending',
        responses: [expect.objectContaining({ status: 'pending', toolCallId: 'call-1' })]
      }),
      expect.objectContaining({
        type: 'mcp_tool_complete',
        responses: [expect.objectContaining({ status: 'done', toolCallId: 'call-1' })]
      }),
      { type: 'block_complete' }
    ])
  })

  it('does not overwrite an agent error with a successful completion', async () => {
    const chunks: any[] = []
    const adapter = createAgentEventToChunk(chunk => {
      chunks.push(chunk)
    })

    await adapter({
      type: 'agent_end',
      messages: [{ errorMessage: 'provider request failed' }]
    } as never)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: 'error',
      error: {
        code: 'AGENT_ERROR',
        message: 'provider request failed'
      }
    })
    expect(chunks[0].error).toBeInstanceOf(Error)
  })

  it('retains an assistant stream error when agent_end omits the final message', async () => {
    const chunks: any[] = []
    const adapter = createAgentEventToChunk(chunk => {
      chunks.push(chunk)
    })

    await adapter({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'stream ended with an error'
      }
    } as never)
    await adapter({ type: 'agent_end', messages: [] } as never)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: 'error',
      error: { code: 'AGENT_ERROR', message: 'stream ended with an error' }
    })
  })

  it('renders a completed response when a provider does not emit text deltas', async () => {
    const chunks: any[] = []
    const adapter = createAgentEventToChunk(chunk => {
      chunks.push(chunk)
    })

    await adapter({ type: 'agent_start' } as never)
    await adapter({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Final-only response' }] }
    } as never)

    expect(chunks).toEqual([
      { type: 'llm_response_created' },
      { type: 'text.start' },
      { type: 'text.complete', text: 'Final-only response' }
    ])
  })

  it('keeps tool metadata paired correctly when parallel calls finish out of order', async () => {
    const chunks: any[] = []
    const adapter = createAgentEventToChunk(chunk => {
      chunks.push(chunk)
    })

    await adapter({
      type: 'tool_execution_start',
      toolName: 'first',
      toolCallId: 'call-1',
      args: { value: 1 }
    } as never)
    await adapter({
      type: 'tool_execution_start',
      toolName: 'second',
      toolCallId: 'call-2',
      args: { value: 2 }
    } as never)
    await adapter({
      type: 'tool_execution_end',
      toolCallId: 'call-2',
      isError: false,
      result: { content: [{ type: 'text', text: 'second result' }] }
    } as never)
    await adapter({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      isError: false,
      result: { content: [{ type: 'text', text: 'first result' }] }
    } as never)

    expect(chunks[2].responses[0]).toMatchObject({
      toolCallId: 'call-2',
      tool: { name: 'second' },
      arguments: { value: 2 }
    })
    expect(chunks[3].responses[0]).toMatchObject({
      toolCallId: 'call-1',
      tool: { name: 'first' },
      arguments: { value: 1 }
    })
  })

  it('maps an aborted agent turn to the existing paused-message error signal', async () => {
    const chunks: any[] = []
    const adapter = createAgentEventToChunk(chunk => {
      chunks.push(chunk)
    })

    await adapter({
      type: 'agent_end',
      messages: [{ stopReason: 'aborted', errorMessage: 'The operation was aborted' }]
    } as never)

    expect(chunks[0]).toMatchObject({
      type: 'error',
      error: { message: 'Request was aborted.' }
    })
  })
})
