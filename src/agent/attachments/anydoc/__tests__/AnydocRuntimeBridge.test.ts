import { AnydocRuntimeBridge } from '../AnydocRuntimeBridge'

describe('AnydocRuntimeBridge', () => {
  it('activates lazily, chunks requests and reassembles bounded results', async () => {
    const bridge = new AnydocRuntimeBridge()
    const messages: Record<string, unknown>[] = []
    const activate = jest.fn()
    const detach = bridge.attach(raw => messages.push(JSON.parse(raw)), activate)

    const conversion = bridge.convert({ base64: 'a'.repeat(300 * 1024), extension: 'docx' })
    expect(activate).toHaveBeenCalledTimes(1)
    bridge.handleMessage(JSON.stringify({ type: 'ready', version: '0.1.7' }))
    await Promise.resolve()

    const start = messages.find(message => message.type === 'request-start')!
    const requestChunks = messages.filter(message => message.type === 'request-chunk')
    expect(requestChunks).toHaveLength(2)
    bridge.handleMessage(JSON.stringify({ type: 'result-start', id: start.id }))
    bridge.handleMessage(JSON.stringify({ type: 'result-chunk', id: start.id, chunk: '# Heading\n' }))
    bridge.handleMessage(JSON.stringify({ type: 'result-chunk', id: start.id, chunk: 'Body' }))
    bridge.handleMessage(JSON.stringify({ type: 'result-end', id: start.id }))

    await expect(conversion).resolves.toBe('# Heading\nBody')
    detach()
  })

  it('propagates structured anydoc conversion errors', async () => {
    const bridge = new AnydocRuntimeBridge()
    const messages: Record<string, unknown>[] = []
    const detach = bridge.attach(raw => messages.push(JSON.parse(raw)), jest.fn())
    bridge.handleMessage(JSON.stringify({ type: 'ready', version: '0.1.7' }))

    const conversion = bridge.convert({ base64: 'eA==', extension: 'pdf' })
    await Promise.resolve()
    const start = messages.find(message => message.type === 'request-start')!
    bridge.handleMessage(
      JSON.stringify({ type: 'error', id: start.id, code: 'encrypted', message: 'Document is encrypted' })
    )

    await expect(conversion).rejects.toMatchObject({ message: 'Document is encrypted', code: 'encrypted' })
    detach()
  })
})
