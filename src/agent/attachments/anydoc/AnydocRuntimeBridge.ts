const REQUEST_CHUNK_CHARACTERS = 256 * 1024
const REQUEST_TIMEOUT_MS = 90_000

type Transport = (message: string) => void

type PendingRequest = {
  chunks: string[]
  characters: number
  resolve: (markdown: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type RuntimeMessage =
  | { type: 'ready'; version: string }
  | { type: 'result-start'; id: string }
  | { type: 'result-chunk'; id: string; chunk: string }
  | { type: 'result-end'; id: string }
  | { type: 'error'; id?: string; code?: string; message: string }

type ReadyWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

function requestId(): string {
  return `anydoc-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export class AnydocRuntimeBridge {
  private transport: Transport | null = null
  private activate: (() => void) | null = null
  private ready = false
  private readonly pending = new Map<string, PendingRequest>()
  private readonly readyWaiters = new Set<ReadyWaiter>()

  attach(transport: Transport, activate: () => void): () => void {
    this.transport = transport
    this.activate = activate
    this.ready = false
    return () => {
      if (this.transport !== transport) return
      this.transport = null
      this.activate = null
      this.ready = false
      const error = new Error('The local anydoc runtime was detached.')
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout)
        request.reject(error)
      }
      this.pending.clear()
      for (const waiter of this.readyWaiters) {
        clearTimeout(waiter.timeout)
        waiter.reject(error)
      }
      this.readyWaiters.clear()
    }
  }

  initialize(wasmBase64: string): void {
    this.send({ type: 'wasm-start' })
    for (let offset = 0; offset < wasmBase64.length; offset += REQUEST_CHUNK_CHARACTERS) {
      this.send({ type: 'wasm-chunk', chunk: wasmBase64.slice(offset, offset + REQUEST_CHUNK_CHARACTERS) })
    }
    this.send({ type: 'wasm-end' })
  }

  failInitialization(error: unknown): void {
    this.handleMessage(
      JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    )
  }

  prepare(): Promise<void> {
    return this.waitUntilReady()
  }

  async convert(input: { base64: string; extension: string }): Promise<string> {
    await this.waitUntilReady()
    const id = requestId()
    const result = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Local anydoc conversion timed out after 90 seconds.'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { chunks: [], characters: 0, resolve, reject, timeout })
    })

    this.send({ type: 'request-start', id, extension: input.extension })
    for (let offset = 0; offset < input.base64.length; offset += REQUEST_CHUNK_CHARACTERS) {
      this.send({
        type: 'request-chunk',
        id,
        chunk: input.base64.slice(offset, offset + REQUEST_CHUNK_CHARACTERS)
      })
    }
    this.send({ type: 'request-end', id })
    return result
  }

  handleMessage(raw: string): void {
    let message: RuntimeMessage
    try {
      message = JSON.parse(raw) as RuntimeMessage
    } catch {
      return
    }

    if (message.type === 'ready') {
      this.ready = true
      for (const waiter of this.readyWaiters) {
        clearTimeout(waiter.timeout)
        waiter.resolve()
      }
      this.readyWaiters.clear()
      return
    }

    if (message.type === 'error' && !message.id) {
      const error = new Error(`Local anydoc runtime failed to initialize: ${message.message}`)
      for (const waiter of this.readyWaiters) {
        clearTimeout(waiter.timeout)
        waiter.reject(error)
      }
      this.readyWaiters.clear()
      return
    }

    if (!message.id) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (message.type === 'result-start') {
      pending.chunks = []
      pending.characters = 0
    } else if (message.type === 'result-chunk') {
      pending.characters += message.chunk.length
      if (pending.characters > 16 * 1024 * 1024) {
        clearTimeout(pending.timeout)
        this.pending.delete(message.id)
        pending.reject(new Error('anydoc output exceeded the local bridge safety limit.'))
        return
      }
      pending.chunks.push(message.chunk)
    } else if (message.type === 'result-end') {
      clearTimeout(pending.timeout)
      this.pending.delete(message.id)
      pending.resolve(pending.chunks.join(''))
    } else if (message.type === 'error') {
      clearTimeout(pending.timeout)
      this.pending.delete(message.id)
      const error = new Error(message.message) as Error & { code?: string }
      error.code = message.code
      pending.reject(error)
    }
  }

  private waitUntilReady(): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (!this.transport) return Promise.reject(new Error('The local anydoc runtime is not mounted.'))
    this.activate?.()
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject } as ReadyWaiter
      waiter.timeout = setTimeout(() => {
        if (!this.readyWaiters.delete(waiter)) return
        reject(new Error('The local anydoc runtime did not become ready within 15 seconds.'))
      }, 15_000)
      this.readyWaiters.add(waiter)
    })
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.transport) throw new Error('The local anydoc runtime is not mounted.')
    this.transport(JSON.stringify(payload))
  }
}

export const anydocRuntimeBridge = new AnydocRuntimeBridge()
