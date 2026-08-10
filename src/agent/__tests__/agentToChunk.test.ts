import { createAgentEventToChunk } from '../agentToChunk'
import { registerMcpAgentToolName } from '../mcpToolNames'

describe('createAgentEventToChunk', () => {
  it('does not emit a second placeholder when the response was created before slow setup', async () => {
    const chunks: any[] = []
    const adapter = createAgentEventToChunk(
      chunk => {
        chunks.push(chunk)
      },
      { responseAlreadyCreated: true }
    )

    await adapter({ type: 'agent_start' } as never)

    expect(chunks).toEqual([])
  })

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

  it('treats stopReason=error as terminal even when the provider omits errorMessage', async () => {
    const chunks: any[] = []
    const adapter = createAgentEventToChunk(chunk => {
      chunks.push(chunk)
    })

    await adapter({
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: '', content: [] }]
    } as never)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: 'error',
      error: { code: 'AGENT_ERROR', message: 'The agent request failed.' }
    })
    expect(adapter.getState().agentEnded).toBe(true)
  })

  it('reports an empty successful agent turn as a protocol error', async () => {
    const chunks: any[] = []
    const adapter = createAgentEventToChunk(chunk => {
      chunks.push(chunk)
    })

    await adapter({ type: 'agent_end', messages: [] } as never)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: 'error',
      error: {
        code: 'AGENT_PROTOCOL_INCOMPLETE',
        message: 'The agent completed without producing a visible response.'
      }
    })
  })

  it('closes pending tools as errors before terminating the agent turn', async () => {
    const chunks: any[] = []
    const adapter = createAgentEventToChunk(chunk => {
      chunks.push(chunk)
    })

    await adapter({
      type: 'tool_execution_start',
      toolName: 'lookup',
      toolCallId: 'call-pending',
      args: { query: 'weather' }
    } as never)
    await adapter({ type: 'agent_end', messages: [] } as never)

    expect(chunks[1]).toMatchObject({
      type: 'mcp_tool_complete',
      responses: [
        expect.objectContaining({
          toolCallId: 'call-pending',
          status: 'error',
          response: expect.objectContaining({ text: expect.stringContaining('did not complete') })
        })
      ]
    })
    expect(chunks[2]).toMatchObject({ type: 'error', error: { code: 'AGENT_ERROR' } })
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'block_complete' }))
  })

  it('restores MCP server metadata from a provider-compatible tool alias', async () => {
    const chunks: any[] = []
    const adapter = createAgentEventToChunk(chunk => {
      chunks.push(chunk)
    })
    const toolName = registerMcpAgentToolName({
      serverId: 'server:with:colon',
      serverName: 'Remote Search',
      toolName: 'search.web/v2'
    })

    expect(toolName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    await adapter({
      type: 'tool_execution_start',
      toolName,
      toolCallId: 'call-mcp',
      args: { query: 'Cherry' }
    } as never)

    expect(chunks[0]).toMatchObject({
      responses: [
        expect.objectContaining({
          tool: expect.objectContaining({
            serverId: 'server:with:colon',
            serverName: 'Remote Search',
            name: 'search.web/v2',
            isBuiltIn: false
          })
        })
      ]
    })
  })
})
