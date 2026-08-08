import { ChunkType } from '@/types/chunk'

import { createStreamProcessor } from '../StreamProcessingService'

describe('createStreamProcessor', () => {
  it('serializes asynchronous callbacks in source chunk order', async () => {
    const events: string[] = []
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>(resolve => {
      releaseStart = resolve
    })
    const processor = createStreamProcessor({
      onTextStart: async () => {
        events.push('start')
        await startGate
        events.push('start-complete')
      },
      onTextChunk: async text => {
        events.push(`chunk:${text}`)
      }
    })

    const start = processor({ type: ChunkType.TEXT_START })
    const chunk = processor({ type: ChunkType.TEXT_DELTA, text: 'hello' })

    await Promise.resolve()
    expect(events).toEqual(['start'])

    releaseStart?.()
    await Promise.all([start, chunk, processor.drain()])

    expect(events).toEqual(['start', 'start-complete', 'chunk:hello'])
  })

  it('reports callback failures and continues processing later chunks', async () => {
    const events: string[] = []
    const processor = createStreamProcessor({
      onTextChunk: () => {
        throw new Error('write failed')
      },
      onError: async () => {
        events.push('error')
      },
      onComplete: async () => {
        events.push('complete')
      }
    })

    await processor({ type: ChunkType.TEXT_DELTA, text: 'hello' })
    await processor({ type: ChunkType.BLOCK_COMPLETE })

    expect(events).toEqual(['error', 'complete'])
  })
})
