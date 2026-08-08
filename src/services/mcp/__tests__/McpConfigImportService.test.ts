import { parseMcpJsonConfig } from '../McpConfigImportService'

let idCounter = 0
const parserDependencies = {
  idFactory: jest.fn(() => `generated-id-${++idCounter}`),
  now: () => 123456
}

describe('parseMcpJsonConfig', () => {
  beforeEach(() => {
    idCounter = 0
    parserDependencies.idFactory.mockClear()
  })

  it('imports a standard mcpServers map as remote streamable HTTP servers', () => {
    const result = parseMcpJsonConfig(
      JSON.stringify({
        mcpServers: {
          weather: {
            url: 'https://mcp.example.com/weather',
            headers: { Authorization: 'Bearer token' },
            isActive: true
          },
          docs: {
            type: 'streamable-http',
            baseUrl: 'https://mcp.example.com/docs'
          }
        }
      }),
      parserDependencies
    )

    expect(result).toEqual({
      success: true,
      servers: [
        expect.objectContaining({
          id: 'generated-id-1',
          name: 'weather',
          type: 'streamableHttp',
          baseUrl: 'https://mcp.example.com/weather',
          headers: { Authorization: 'Bearer token' },
          isActive: true,
          installedAt: 123456
        }),
        expect.objectContaining({
          id: 'generated-id-2',
          name: 'docs',
          type: 'streamableHttp',
          baseUrl: 'https://mcp.example.com/docs',
          isActive: false,
          installedAt: 123456
        })
      ]
    })
  })

  it('accepts one direct server configuration and normalizes common remote aliases', () => {
    const result = parseMcpJsonConfig(
      JSON.stringify({
        id: 'untrusted-pasted-id',
        name: 'Remote tools',
        transport: 'STREAMABLE_HTTP',
        serverUrl: 'https://example.com/mcp'
      }),
      { idFactory: () => 'fresh-id', now: () => 42 }
    )

    expect(result).toEqual({
      success: true,
      servers: [
        expect.objectContaining({
          id: 'fresh-id',
          name: 'Remote tools',
          type: 'streamableHttp',
          baseUrl: 'https://example.com/mcp',
          installedAt: 42
        })
      ]
    })
  })

  it('accepts a bare array of remote server configurations', () => {
    const result = parseMcpJsonConfig(JSON.stringify([{ name: 'Array server', url: 'https://example.com/mcp' }]), {
      idFactory: () => 'array-id',
      now: () => 42
    })

    expect(result).toEqual({
      success: true,
      servers: [
        expect.objectContaining({
          id: 'array-id',
          name: 'Array server',
          type: 'streamableHttp',
          baseUrl: 'https://example.com/mcp'
        })
      ]
    })
  })

  it.each([
    ['invalid JSON', '{not-json', 'INVALID_JSON'],
    ['unknown root', JSON.stringify({ hello: 'world' }), 'INVALID_ROOT'],
    ['empty list', JSON.stringify({ mcpServers: {} }), 'NO_SERVERS'],
    [
      'invalid headers',
      JSON.stringify({ mcpServers: { bad: { url: 'https://example.com/mcp', headers: { Authorization: 42 } } } }),
      'INVALID_SERVER'
    ],
    ['invalid URL', JSON.stringify({ mcpServers: { bad: { url: 'ftp://example.com/mcp' } } }), 'INVALID_URL'],
    [
      'Claude Desktop local stdio configuration',
      JSON.stringify({ mcpServers: { local: { command: 'npx', args: ['-y', 'local-mcp'] } } }),
      'UNSUPPORTED_STDIO'
    ],
    [
      'SSE configuration',
      JSON.stringify({ mcpServers: { stream: { type: 'sse', url: 'https://example.com/sse' } } }),
      'UNSUPPORTED_TRANSPORT'
    ]
  ])('rejects %s', (_label, json, errorCode) => {
    const result = parseMcpJsonConfig(json, parserDependencies)

    expect(result).toEqual({
      success: false,
      errors: [expect.objectContaining({ code: errorCode })]
    })
  })

  it('rejects duplicate server names without producing a partial import', () => {
    const result = parseMcpJsonConfig(
      JSON.stringify({
        servers: [
          { name: 'Same', url: 'https://example.com/one' },
          { name: 'same', url: 'https://example.com/two' }
        ]
      }),
      parserDependencies
    )

    expect(result).toEqual({
      success: false,
      errors: [{ code: 'DUPLICATE_NAME', name: 'same' }]
    })
  })
})
