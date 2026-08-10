import { initPublicMcpPresets, PUBLIC_MCP_PRESETS } from '../mcpPresets'

describe('public MCP presets', () => {
  it('contains a substantial keyless Streamable HTTP test catalog', () => {
    const presets = initPublicMcpPresets()

    expect(presets.length).toBeGreaterThanOrEqual(8)
    expect(new Set(presets.map(server => server.id)).size).toBe(presets.length)
    expect(new Set(presets.map(server => server.baseUrl)).size).toBe(presets.length)

    for (const server of presets) {
      expect(server).toMatchObject({
        type: 'streamableHttp',
        isActive: false,
        isTrusted: false
      })
      expect(server.id).toMatch(/^@public\//)
      expect(server.baseUrl).toMatch(/^https:\/\//)
      expect(server.headers).toBeUndefined()
      expect(server.command).toBeUndefined()
      expect(server.args).toBeUndefined()
      expect(server.env).toBeUndefined()
    }
  })

  it('returns fresh mutable records without changing the curated source', () => {
    const first = initPublicMcpPresets()
    const second = initPublicMcpPresets()

    first[0].tags?.push('mutated')
    first[0].disabledTools?.push('mutated')

    expect(second[0].tags).not.toContain('mutated')
    expect(second[0].disabledTools ?? []).not.toContain('mutated')
    expect(PUBLIC_MCP_PRESETS[0].tags).not.toContain('mutated')
  })

  it('keeps the official documentation preset read-only by default', () => {
    expect(initPublicMcpPresets().find(server => server.id === '@public/mcp-docs')?.disabledTools).toContain(
      'submit_feedback'
    )
  })
})
