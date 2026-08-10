import { RNStreamableHTTPClientTransport } from '@cherrystudio/react-native-streamable-http'
import { Client } from '@modelcontextprotocol/client'

// Jest's CommonJS resolver cannot select pkce-challenge's nested `node`
// export condition, while the MCP client only needs it for OAuth paths. The
// protocol tests exercise transport negotiation and keep OAuth out of scope.
jest.mock(
  'pkce-challenge',
  () => ({
    __esModule: true,
    default: jest.fn(),
    generateChallenge: jest.fn(),
    verifyChallenge: jest.fn()
  }),
  { virtual: true }
)

type RecordedRequest = {
  body: Record<string, any>
  headers: Record<string, string>
}

function recordRequest(
  input: unknown,
  init?: { body?: unknown; headers?: ConstructorParameters<typeof Headers>[0] }
): RecordedRequest {
  if (typeof input !== 'string') {
    throw new Error(`[start] Cannot convert '${String(input)}' to a Kotlin type.`)
  }
  const body = JSON.parse(String(init?.body)) as Record<string, any>
  return {
    body,
    headers: Object.fromEntries(new Headers(init?.headers).entries())
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function reactNativeSseResponse(body: unknown): Response {
  const payload = `event: message\ndata: ${JSON.stringify(body)}\n\n`
  const bytes = new TextEncoder().encode(payload)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // One-byte chunks deliberately split the UTF-8 fixture below inside a
      // multi-byte code point, matching native fetch's arbitrary chunking.
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    }
  })

  Object.defineProperty(stream, 'pipeThrough', {
    value: () => {
      throw new Error('React Native fixture does not support browser pipeThrough decoding')
    }
  })

  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: stream,
    text: async () => payload,
    json: async () => body
  } as Response
}

describe('MCP v2 protocol negotiation', () => {
  it('uses the workspace transport source instead of its ignored dist artifact', () => {
    expect(require.resolve('@cherrystudio/react-native-streamable-http')).toMatch(
      /packages\/react-native-streamable-http\/src\/index\.ts$/
    )
  })

  it('discovers and calls tools from SSE responses without browser stream transforms', async () => {
    const fetchMock = jest.fn(
      async (_input: unknown, init?: { body?: unknown; headers?: ConstructorParameters<typeof Headers>[0] }) => {
        const request = recordRequest(_input, init)

        if (request.body.method === 'notifications/initialized') {
          return new Response(null, { status: 202 })
        }

        const result =
          request.body.method === 'server/discover'
            ? undefined
            : request.body.method === 'initialize'
              ? {
                  protocolVersion: '2025-11-25',
                  capabilities: { tools: {} },
                  serverInfo: { name: '移动端-fixture', version: '1.0.0' }
                }
              : request.body.method === 'tools/list'
                ? {
                    tools: [
                      {
                        name: 'mobile_sse_tool',
                        description: '跨原生分块发现工具',
                        inputSchema: { type: 'object', properties: {} }
                      }
                    ]
                  }
                : { content: [{ type: 'text', text: '移动端调用成功' }] }

        return reactNativeSseResponse(
          request.body.method === 'server/discover'
            ? {
                jsonrpc: '2.0',
                id: request.body.id,
                error: { code: -32601, message: 'Method not found' }
              }
            : { jsonrpc: '2.0', id: request.body.id, result }
        )
      }
    )

    const transport = new RNStreamableHTTPClientTransport('https://fixture.invalid/mcp', { fetch: fetchMock })
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })

    await client.connect(transport)
    await expect(client.listTools()).resolves.toEqual(
      expect.objectContaining({ tools: [expect.objectContaining({ name: 'mobile_sse_tool' })] })
    )
    await expect(client.callTool({ name: 'mobile_sse_tool', arguments: {} })).resolves.toEqual({
      content: [{ type: 'text', text: '移动端调用成功' }]
    })

    await client.close()
  })

  it('uses modern 2026-07-28 headers and envelopes for a modern server', async () => {
    const requests: RecordedRequest[] = []
    let toolsListPage = 0
    const fetchMock = jest.fn(
      async (input: unknown, init?: { body?: unknown; headers?: ConstructorParameters<typeof Headers>[0] }) => {
        const request = recordRequest(input, init)
        requests.push(request)

        const result =
          request.body.method === 'server/discover'
            ? {
                supportedVersions: ['2026-07-28'],
                capabilities: { tools: { listChanged: true } },
                _meta: {
                  'io.modelcontextprotocol/serverInfo': { name: 'modern-fixture', version: '1.0.0' }
                }
              }
            : request.body.method === 'tools/list'
              ? toolsListPage++ === 0
                ? {
                    resultType: 'complete',
                    tools: [
                      {
                        name: 'fixture_tool',
                        description: 'Fixture tool',
                        inputSchema: { type: 'object', properties: {} }
                      }
                    ],
                    nextCursor: 'page-2',
                    ttlMs: 1000,
                    cacheScope: 'private'
                  }
                : {
                    resultType: 'complete',
                    tools: [
                      {
                        name: 'fixture_tool_2',
                        description: 'Second page tool',
                        inputSchema: { type: 'object', properties: {} }
                      }
                    ],
                    ttlMs: 1000,
                    cacheScope: 'private'
                  }
              : { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] }

        return jsonResponse({ jsonrpc: '2.0', id: request.body.id, result })
      }
    )

    const transport = new RNStreamableHTTPClientTransport('https://fixture.invalid/mcp', {
      fetch: fetchMock
    })
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })

    await client.connect(transport)
    expect(client.getProtocolEra()).toBe('modern')
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')

    await expect(client.listTools()).resolves.toEqual(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: 'fixture_tool' }), expect.objectContaining({ name: 'fixture_tool_2' })]
      })
    )
    await expect(client.callTool({ name: 'fixture_tool', arguments: {} })).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }]
    })

    const discover = requests[0]
    expect(discover.headers).toMatchObject({
      'mcp-method': 'server/discover',
      'mcp-protocol-version': '2026-07-28'
    })
    expect(discover.body.params._meta).toEqual(
      expect.objectContaining({
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' }
      })
    )

    const call = requests.find(request => request.body.method === 'tools/call')
    expect(call?.headers).toMatchObject({
      'mcp-method': 'tools/call',
      'mcp-name': 'fixture_tool',
      'mcp-protocol-version': '2026-07-28'
    })
    expect(call?.body.params._meta).toEqual(
      expect.objectContaining({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28' })
    )

    await client.close()
  })

  it('falls back to the legacy initialize handshake when modern discovery is unavailable', async () => {
    const requests: RecordedRequest[] = []
    const fetchMock = jest.fn(
      async (input: unknown, init?: { body?: unknown; headers?: ConstructorParameters<typeof Headers>[0] }) => {
        const request = recordRequest(input, init)
        requests.push(request)

        if (request.body.method === 'server/discover') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: request.body.id,
            error: { code: -32601, message: 'Method not found' }
          })
        }

        const result =
          request.body.method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'legacy-fixture', version: '1.0.0' }
              }
            : request.body.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'legacy_tool',
                      description: 'Legacy fixture tool',
                      inputSchema: { type: 'object', properties: {} }
                    }
                  ]
                }
              : {}

        if (request.body.method === 'notifications/initialized') {
          return new Response(null, { status: 202 })
        }

        return jsonResponse({ jsonrpc: '2.0', id: request.body.id, result })
      }
    )

    const transport = new RNStreamableHTTPClientTransport('https://fixture.invalid/mcp', {
      fetch: fetchMock
    })
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })

    await client.connect(transport)
    expect(client.getProtocolEra()).toBe('legacy')
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25')
    await expect(client.listTools()).resolves.toEqual(
      expect.objectContaining({ tools: [expect.objectContaining({ name: 'legacy_tool' })] })
    )

    const initialize = requests.find(request => request.body.method === 'initialize')
    expect(initialize?.headers['mcp-method']).toBeUndefined()
    expect(initialize?.headers['mcp-protocol-version']).toBeUndefined()

    await client.close()
  })
})
