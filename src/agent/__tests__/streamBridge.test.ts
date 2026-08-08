import { fetch as mockedExpoFetch } from 'expo/fetch'

import type { Model, Provider } from '@/types/assistant'

import { createStreamFn } from '../streamBridge'

const mockPush = jest.fn()
const mockEnd = jest.fn()
const mockStreamText = jest.fn()
const mockCreateExecutor = jest.fn()
const mockLanguageModel = { id: 'local-language-model' }
const mockEventStream = {
  push: (...args: unknown[]) => mockPush(...args),
  end: (...args: unknown[]) => mockEnd(...args)
}
const mockExpoFetch = jest.fn()

jest.mock('@cherrystudio/ai-core', () => ({
  createExecutor: (...args: unknown[]) => mockCreateExecutor(...args)
}))
jest.mock(
  '@earendil-works/pi-ai',
  () => ({
    createAssistantMessageEventStream: () => mockEventStream
  }),
  { virtual: true }
)
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockExpoFetch(...args) }))
jest.mock('@/aiCore/provider/factory', () => ({
  createAiSdkProvider: async () => ({ languageModel: () => mockLanguageModel })
}))
jest.mock('@/aiCore/provider/providerConfig', () => ({
  providerToAiSdkConfig: () => ({ providerId: 'openai-compatible', options: {} }),
  prepareSpecialProviderConfig: async (_provider: unknown, config: unknown) => config
}))

const model: Model = {
  id: 'mock-model',
  name: 'Mock model',
  provider: 'mock-provider',
  group: 'default'
}

const provider: Provider = {
  id: 'mock-provider',
  name: 'Mock provider',
  type: 'openai',
  apiKey: 'mock-key',
  apiHost: 'https://mock.invalid',
  models: [model]
}

const waitForEnd = async () => {
  await new Promise<void>(resolve => {
    mockEnd.mockImplementationOnce(() => resolve())
  })
}

describe('createStreamFn simulated provider stream', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateExecutor.mockReturnValue({
      streamText: (...args: unknown[]) => mockStreamText(...args)
    })
  })

  it('adapts a simulated streaming provider response and injects Expo fetch for React Native', async () => {
    async function* simulatedFullStream() {
      yield { type: 'text-delta', text: '模拟 ' }
      yield { type: 'text-delta', text: 'Provider 响应' }
    }
    mockStreamText.mockResolvedValue({ fullStream: simulatedFullStream() })

    const streamFn = createStreamFn(model, provider)
    streamFn({} as never, { systemPrompt: 'system', messages: [], tools: [] }, {})
    await waitForEnd()

    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockLanguageModel,
        system: 'system',
        messages: []
      })
    )
    expect(mockCreateExecutor).toHaveBeenCalledWith(
      'openai-compatible',
      expect.objectContaining({ fetch: mockedExpoFetch })
    )
    expect(mockPush.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ type: 'start' }),
      expect.objectContaining({ type: 'text_delta', delta: '模拟 ' }),
      expect.objectContaining({ type: 'text_delta', delta: 'Provider 响应' }),
      expect.objectContaining({
        type: 'done',
        reason: 'stop',
        message: expect.objectContaining({
          content: [{ type: 'text', text: '模拟 Provider 响应' }]
        })
      })
    ])
  })

  it('converts a simulated provider failure into a terminal error event', async () => {
    mockStreamText.mockRejectedValue(new Error('模拟网络失败'))

    const streamFn = createStreamFn(model, provider)
    streamFn({} as never, { systemPrompt: 'system', messages: [], tools: [] }, {})
    await waitForEnd()

    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        reason: 'error',
        error: expect.objectContaining({ errorMessage: '模拟网络失败', stopReason: 'error' })
      })
    )
  })

  it('converts an error emitted inside fullStream into a terminal error event', async () => {
    async function* failingFullStream() {
      yield { type: 'error', error: new Error('模拟流错误') }
    }
    mockStreamText.mockResolvedValue({ fullStream: failingFullStream() })

    const streamFn = createStreamFn(model, provider)
    streamFn({} as never, { systemPrompt: 'system', messages: [], tools: [] }, {})
    await waitForEnd()

    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        reason: 'error',
        error: expect.objectContaining({ errorMessage: '模拟流错误', stopReason: 'error' })
      })
    )
    expect(mockPush).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }))
  })

  it('recovers final text when a compatible provider omits text delta events', async () => {
    async function* emptyFullStream() {
      // A few OpenAI-compatible providers expose the final result only.
    }
    mockStreamText.mockResolvedValue({
      fullStream: emptyFullStream(),
      text: Promise.resolve('最终文本'),
      toolCalls: Promise.resolve([])
    })

    const streamFn = createStreamFn(model, provider)
    streamFn({} as never, { systemPrompt: 'system', messages: [], tools: [] }, {})
    await waitForEnd()

    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'done',
        message: expect.objectContaining({ content: [{ type: 'text', text: '最终文本' }] })
      })
    )
  })

  it('reports an empty provider response instead of completing with no visible message', async () => {
    async function* emptyFullStream() {
      // Intentionally empty.
    }
    mockStreamText.mockResolvedValue({
      fullStream: emptyFullStream(),
      text: Promise.resolve(''),
      toolCalls: Promise.resolve([])
    })

    const streamFn = createStreamFn(model, provider)
    streamFn({} as never, { systemPrompt: 'system', messages: [], tools: [] }, {})
    await waitForEnd()

    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        reason: 'error',
        error: expect.objectContaining({
          errorMessage: 'The model provider returned an empty response.',
          stopReason: 'error'
        })
      })
    )
    expect(mockPush).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }))
  })
})
