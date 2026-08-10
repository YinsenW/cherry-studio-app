import { Client } from '@modelcontextprotocol/client'

import { RNStreamableHTTPClientTransport } from '../packages/react-native-streamable-http/src/index'
import { PUBLIC_MCP_PRESETS } from '../src/config/mcpPresets'

const CALL_TIMEOUT_MS = 30_000

const READ_ONLY_PROBES: Record<string, { tool: string; arguments: Record<string, unknown> }> = {
  '@public/exa': {
    tool: 'web_search_exa',
    arguments: { query: 'Model Context Protocol official specification', numResults: 1 }
  },
  '@public/context7': {
    tool: 'resolve-library-id',
    arguments: { libraryName: 'React', query: 'React hooks documentation' }
  },
  '@public/microsoft-learn': {
    tool: 'microsoft_docs_search',
    arguments: { query: 'TypeScript overview' }
  },
  '@public/deepwiki': {
    tool: 'read_wiki_structure',
    arguments: { repoName: 'modelcontextprotocol/modelcontextprotocol' }
  },
  '@public/cloudflare-docs': {
    tool: 'search_cloudflare_documentation',
    arguments: { query: 'What is Workers KV?' }
  },
  '@public/gitmcp': {
    tool: 'match_common_libs_owner_repo_mapping',
    arguments: { library: 'React' }
  },
  '@public/mcp-docs': {
    tool: 'search_model_context_protocol',
    arguments: { query: 'Streamable HTTP transport' }
  },
  '@public/coingecko': {
    tool: 'search_docs',
    arguments: { query: 'simple price endpoint', language: 'http', detail: 'default' }
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${CALL_TIMEOUT_MS} ms`)), CALL_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function verifyPreset(preset: (typeof PUBLIC_MCP_PRESETS)[number]) {
  const startedAt = Date.now()
  const client = new Client(
    { name: 'cherry-studio-public-mcp-verifier', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } }
  )

  try {
    await withTimeout(client.connect(new RNStreamableHTTPClientTransport(preset.baseUrl)), `${preset.name} initialize`)
    const listed = await withTimeout(client.listTools(), `${preset.name} tools/list`)
    const probe = READ_ONLY_PROBES[preset.id]
    if (!probe) throw new Error(`Missing read-only verification probe for ${preset.id}`)
    if (!listed.tools.some(tool => tool.name === probe.tool)) {
      throw new Error(`Expected tool ${probe.tool} was not advertised`)
    }

    const result = await withTimeout(
      client.callTool({ name: probe.tool, arguments: probe.arguments }),
      `${preset.name} tools/call`
    )
    if (result.isError) throw new Error(`${probe.tool} returned an MCP error result`)
    if (!Array.isArray(result.content) || result.content.length === 0) {
      throw new Error(`${probe.tool} returned no content`)
    }

    return {
      id: preset.id,
      endpoint: preset.baseUrl,
      ok: true as const,
      toolCount: listed.tools.length,
      probe: probe.tool,
      durationMs: Date.now() - startedAt
    }
  } catch (error) {
    return {
      id: preset.id,
      endpoint: preset.baseUrl,
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    }
  } finally {
    try {
      await client.close()
    } catch {
      // The primary result above already describes the endpoint health.
    }
  }
}

async function main() {
  const results = await Promise.all(PUBLIC_MCP_PRESETS.map(verifyPreset))
  for (const result of results) {
    console.log(JSON.stringify(result))
  }

  const failures = results.filter(result => !result.ok)
  if (failures.length > 0) {
    process.exitCode = 1
  } else {
    console.log(`Verified ${results.length} public MCP presets through initialize, tools/list, and tools/call.`)
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
