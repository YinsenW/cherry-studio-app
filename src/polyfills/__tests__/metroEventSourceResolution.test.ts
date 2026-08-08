describe('Metro eventsource compatibility routing', () => {
  it('stubs eventsource without replacing the SSE parser used by AI providers', () => {
    const { createEventSourceResolver } = require('../../../scripts/metro/createEventSourceResolver')
    const polyfillPath = require.resolve('../eventsource')
    const resolveRequest = createEventSourceResolver(undefined, polyfillPath) as (
      context: Record<string, unknown>,
      moduleName: string,
      platform: string
    ) => { filePath: string; type: string }
    const fallbackResult = {
      filePath: require.resolve('eventsource-parser/stream'),
      type: 'sourceFile'
    }
    const context = {
      resolveRequest: jest.fn(() => fallbackResult)
    }

    const eventSourceResult = resolveRequest(context, 'eventsource', 'android')
    expect(eventSourceResult.filePath).toMatch(/src\/polyfills\/eventsource\.ts$/)
    expect(context.resolveRequest).not.toHaveBeenCalled()

    const parserResult = resolveRequest(context, 'eventsource-parser/stream', 'android')
    expect(context.resolveRequest).toHaveBeenCalledWith(context, 'eventsource-parser/stream', 'android')
    expect(parserResult).toEqual(fallbackResult)
    expect(parserResult.filePath).toMatch(/eventsource-parser\/dist\/stream\.(?:c?js)$/)
  })

  it('keeps the real parser able to turn fragmented SSE text into data events', async () => {
    const { EventSourceParserStream } = require('eventsource-parser/stream')
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('data: {"choices":')
        controller.enqueue('[]}\n\n')
        controller.close()
      }
    })
    const reader = source.pipeThrough(new EventSourceParserStream()).getReader()

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { data: '{"choices":[]}' }
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
  })
})
