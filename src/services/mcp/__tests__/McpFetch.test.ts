import { mcpExpoFetch } from '../McpFetch'

const mockExpoFetch = jest.fn()

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

jest.mock('expo/fetch', () => ({
  fetch: (...args: unknown[]) => mockExpoFetch(...args)
}))

describe('MCP Expo fetch bridge', () => {
  beforeEach(() => {
    mockExpoFetch.mockReset()
    mockExpoFetch.mockImplementation(async (url: unknown) => {
      if (typeof url !== 'string') {
        throw new Error(`[start] Cannot convert '${String(url)}' to a Kotlin type.`)
      }
      return { ok: true, status: 200 }
    })
  })

  it('converts MCP transport URL objects to strings before crossing the native bridge', async () => {
    const url = new URL('https://modelcontextprotocol.io/mcp')
    const init = { headers: { Accept: 'application/json, text/event-stream' } }

    await expect(mcpExpoFetch(url, init)).resolves.toMatchObject({ ok: true, status: 200 })
    expect(mockExpoFetch).toHaveBeenCalledWith(url.toString(), init)
  })

  it('converts OAuth well-known URL objects to strings without changing their path', async () => {
    const url = new URL('https://modelcontextprotocol.io/.well-known/oauth-authorization-server')

    await mcpExpoFetch(url)

    expect(mockExpoFetch).toHaveBeenCalledWith(
      'https://modelcontextprotocol.io/.well-known/oauth-authorization-server',
      undefined
    )
  })
})
