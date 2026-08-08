import { ChunkType } from '@/types/chunk'

import { AiSdkToChunkAdapter } from '../AiSdkToChunkAdapter'

function makeStream(parts: unknown[]) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    }
  })
}

describe('AiSdkToChunkAdapter terminal state', () => {
  it('does not emit successful completion after an error stream part', async () => {
    const chunks: any[] = []
    const adapter = new AiSdkToChunkAdapter(chunk => chunks.push(chunk))

    await adapter.processStream({
      fullStream: makeStream([
        { type: 'error', error: new Error('provider failed') },
        { type: 'finish', finishReason: 'stop', totalUsage: {} }
      ]),
      text: Promise.resolve('')
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: ChunkType.ERROR })
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: ChunkType.BLOCK_COMPLETE }))
  })

  it('maps finishReason=error to an error terminal', async () => {
    const chunks: any[] = []
    const adapter = new AiSdkToChunkAdapter(chunk => chunks.push(chunk))

    await adapter.processStream({
      fullStream: makeStream([{ type: 'finish', finishReason: 'error', totalUsage: {} }]),
      text: Promise.resolve('')
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: ChunkType.ERROR,
      error: { message: 'The model provider ended the stream with an error.' }
    })
  })

  it('still emits both completion events for a successful stream', async () => {
    const chunks: any[] = []
    const adapter = new AiSdkToChunkAdapter(chunk => chunks.push(chunk))

    await adapter.processStream({
      fullStream: makeStream([{ type: 'finish', finishReason: 'stop', totalUsage: {} }]),
      text: Promise.resolve('ok')
    })

    expect(chunks.map(chunk => chunk.type)).toEqual([ChunkType.BLOCK_COMPLETE, ChunkType.LLM_RESPONSE_COMPLETE])
  })
})
