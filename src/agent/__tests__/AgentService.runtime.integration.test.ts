import type { Model, Provider } from '@/types/assistant'

import { createStreamProcessor } from '../../services/StreamProcessingService'
import { AgentService } from '../AgentService'
import { createAgentEventToChunk } from '../agentToChunk'

const mockStreamText = jest.fn()
const mockCreateExecutor = jest.fn()
const mockLanguageModel = { id: 'runtime-language-model' }
const mockExpoFetch = jest.fn()

jest.mock(
  '@earendil-works/pi-agent-core',
  () => jest.requireActual('../../../node_modules/@earendil-works/pi-agent-core/dist/agent.js'),
  { virtual: true }
)

// Jest 29 cannot load pi-ai's ESM-only TypeBox dependency. Keep the real
// pi-agent-core Agent and provide its small event-stream boundary here.
jest.mock(
  '@earendil-works/pi-ai',
  () => {
    class EventStream<TEvent, TResult> {
      private queue: TEvent[] = []
      private waiting: ((result: IteratorResult<TEvent>) => void)[] = []
      private done = false
      private readonly finalResult: Promise<TResult>
      private resolveFinalResult!: (result: TResult) => void
      private readonly completionCheck: (event: TEvent) => boolean
      private readonly resultExtractor: (event: TEvent) => TResult

      constructor(mockCompletionCheck: (event: TEvent) => boolean, mockResultExtractor: (event: TEvent) => TResult) {
        this.completionCheck = mockCompletionCheck
        this.resultExtractor = mockResultExtractor
        this.finalResult = new Promise(resolve => {
          this.resolveFinalResult = resolve
        })
      }

      push(event: TEvent) {
        if (this.done) return
        if (this.completionCheck(event)) {
          this.done = true
          this.resolveFinalResult(this.resultExtractor(event))
        }
        const waiter = this.waiting.shift()
        if (waiter) waiter({ value: event, done: false })
        else this.queue.push(event)
      }

      end(result?: TResult) {
        this.done = true
        if (result !== undefined) this.resolveFinalResult(result)
        for (const waiter of this.waiting.splice(0)) {
          waiter({ value: undefined, done: true })
        }
      }

      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<TEvent>> => {
            const queued = this.queue.shift()
            if (queued !== undefined) {
              return Promise.resolve({ value: queued, done: false })
            }
            if (this.done) {
              return Promise.resolve({ value: undefined, done: true })
            }
            return new Promise(resolve => this.waiting.push(resolve))
          }
        }
      }

      result() {
        return this.finalResult
      }
    }

    class AssistantMessageEventStream extends EventStream<
      { type: string; message?: unknown; error?: unknown },
      unknown
    > {
      constructor() {
        super(
          event => event.type === 'done' || event.type === 'error',
          event => (event.type === 'done' ? event.message : event.error)
        )
      }
    }

    return {
      EventStream,
      createAssistantMessageEventStream: () => new AssistantMessageEventStream(),
      validateToolArguments: (_tool: unknown, toolCall: { arguments: unknown }) => toolCall.arguments
    }
  },
  { virtual: true }
)

jest.mock('@cherrystudio/ai-core', () => ({
  createExecutor: (...args: unknown[]) => mockCreateExecutor(...args)
}))
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockExpoFetch(...args) }))
jest.mock('@/aiCore/provider/factory', () => ({
  createAiSdkProvider: async () => ({ languageModel: () => mockLanguageModel })
}))
jest.mock('@/aiCore/provider/providerConfig', () => ({
  providerToAiSdkConfig: () => ({ providerId: 'openai-compatible', options: {} }),
  prepareSpecialProviderConfig: async (_provider: unknown, config: unknown) => config
}))

const model: Model = {
  id: 'runtime-model',
  name: 'Runtime model',
  provider: 'runtime-provider',
  group: 'default'
}

const provider: Provider = {
  id: 'runtime-provider',
  name: 'Runtime provider',
  type: 'openai',
  apiKey: 'runtime-key',
  apiHost: 'https://runtime.invalid/v1/',
  models: [model]
}

describe('AgentService runtime integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateExecutor.mockReturnValue({
      streamText: (...args: unknown[]) => mockStreamText(...args)
    })
  })

  it('carries a provider stream through the real Agent protocol and chunk processor', async () => {
    async function* fullStream() {
      yield { type: 'text-delta', text: '真实 Agent ' }
      yield { type: 'text-delta', text: '协议响应' }
      yield { type: 'finish', finishReason: 'stop' }
    }
    mockStreamText.mockResolvedValue({
      fullStream: fullStream(),
      text: Promise.resolve('真实 Agent 协议响应'),
      toolCalls: Promise.resolve([])
    })

    const lifecycle: string[] = []
    const processor = createStreamProcessor({
      onLLMResponseCreated: () => {
        lifecycle.push('created')
      },
      onTextStart: () => {
        lifecycle.push('text-start')
      },
      onTextChunk: text => {
        lifecycle.push(`delta:${text}`)
      },
      onTextComplete: text => {
        lifecycle.push(`complete:${text}`)
      },
      onComplete: status => {
        lifecycle.push(`complete-status:${status}`)
      },
      onError: error => {
        lifecycle.push(`error:${error.message}`)
      }
    })
    const agent = new AgentService(model, provider, [], 'You are helpful.')
    agent.subscribe(createAgentEventToChunk(processor))

    await agent.prompt('请回复')
    await processor.drain()

    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockLanguageModel,
        system: 'You are helpful.',
        messages: [
          expect.objectContaining({
            role: 'user',
            content: [{ type: 'text', text: '请回复' }]
          })
        ]
      })
    )
    expect(lifecycle).toEqual([
      'created',
      'text-start',
      'delta:真实 Agent ',
      'delta:真实 Agent 协议响应',
      'complete:真实 Agent 协议响应',
      'complete-status:success'
    ])
  })

  it('surfaces an empty provider result as an error instead of a successful blank turn', async () => {
    async function* fullStream() {
      yield { type: 'finish', finishReason: 'stop' }
    }
    mockStreamText.mockResolvedValue({
      fullStream: fullStream(),
      text: Promise.resolve(''),
      toolCalls: Promise.resolve([])
    })

    const lifecycle: string[] = []
    const processor = createStreamProcessor({
      onLLMResponseCreated: () => {
        lifecycle.push('created')
      },
      onComplete: status => {
        lifecycle.push(`complete-status:${status}`)
      },
      onError: error => {
        lifecycle.push(`error:${error.message}`)
      }
    })
    const agent = new AgentService(model, provider, [])
    agent.subscribe(createAgentEventToChunk(processor))

    await agent.prompt('请回复')
    await processor.drain()

    expect(lifecycle).toEqual(['created', 'error:The model provider returned an empty response.'])
    expect(lifecycle).not.toContain('complete-status:success')
  })
})
