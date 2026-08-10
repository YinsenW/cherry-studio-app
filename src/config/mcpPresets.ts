import type { MCPServer } from '@/types/mcp'

type PublicMcpPreset = Omit<MCPServer, 'isActive' | 'tags'> & {
  tags?: readonly string[]
}

/**
 * Curated public MCP endpoints for discovery and end-to-end testing.
 *
 * Inclusion requirements:
 * - public HTTPS Streamable HTTP endpoint;
 * - no API key, OAuth flow, or custom header required for basic usage;
 * - maintained by the product/project owner;
 * - initialize, tools/list, and a read-only tools/call verified with the MCP
 *   v2 client before release.
 *
 * These are marketplace presets, not silently enabled integrations. Public
 * services can rate-limit or change independently, so the install flow always
 * performs fresh tool discovery before reporting success.
 */
export const PUBLIC_MCP_PRESETS = [
  {
    id: '@public/exa',
    name: 'Exa Web Search',
    type: 'streamableHttp',
    baseUrl: 'https://mcp.exa.ai/mcp',
    description: 'Keyless public web search and webpage reading. Shared usage limits may apply.',
    provider: 'Exa',
    providerUrl: 'https://github.com/exa-labs/exa-mcp-server',
    tags: ['Search', 'Web', 'No Auth']
  },
  {
    id: '@public/context7',
    name: 'Context7 Documentation',
    type: 'streamableHttp',
    baseUrl: 'https://mcp.context7.com/mcp',
    description: 'Current library documentation and code examples with keyless basic access.',
    provider: 'Upstash',
    providerUrl: 'https://github.com/upstash/context7',
    tags: ['Documentation', 'Developer Tools', 'No Auth']
  },
  {
    id: '@public/microsoft-learn',
    name: 'Microsoft Learn',
    type: 'streamableHttp',
    baseUrl: 'https://learn.microsoft.com/api/mcp',
    description: 'Search and read official Microsoft documentation and code samples.',
    provider: 'Microsoft',
    providerUrl: 'https://learn.microsoft.com/en-us/training/support/mcp',
    tags: ['Documentation', 'Microsoft', 'No Auth']
  },
  {
    id: '@public/deepwiki',
    name: 'DeepWiki',
    type: 'streamableHttp',
    baseUrl: 'https://mcp.deepwiki.com/mcp',
    description: 'Explore generated documentation and structure for public GitHub repositories.',
    provider: 'Cognition',
    providerUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    tags: ['Documentation', 'GitHub', 'No Auth']
  },
  {
    id: '@public/cloudflare-docs',
    name: 'Cloudflare Documentation',
    type: 'streamableHttp',
    baseUrl: 'https://docs.mcp.cloudflare.com/mcp',
    description: 'Search current official documentation for Cloudflare products.',
    provider: 'Cloudflare',
    providerUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
    tags: ['Documentation', 'Cloudflare', 'No Auth']
  },
  {
    id: '@public/gitmcp',
    name: 'GitMCP Public Repositories',
    type: 'streamableHttp',
    baseUrl: 'https://gitmcp.io/docs',
    description: 'Search documentation and source code in public GitHub repositories.',
    provider: 'GitMCP',
    providerUrl: 'https://github.com/idosal/git-mcp',
    tags: ['Documentation', 'GitHub', 'No Auth']
  },
  {
    id: '@public/mcp-docs',
    name: 'MCP Official Documentation',
    type: 'streamableHttp',
    baseUrl: 'https://modelcontextprotocol.io/mcp',
    description: 'Search the official Model Context Protocol specification and documentation.',
    provider: 'Model Context Protocol',
    providerUrl: 'https://modelcontextprotocol.io/',
    tags: ['Documentation', 'MCP', 'No Auth'],
    // Keep the public preset read-only. Users can explicitly re-enable the
    // feedback tool from server details if they intend to submit feedback.
    disabledTools: ['submit_feedback']
  },
  {
    id: '@public/coingecko',
    name: 'CoinGecko Public Data',
    type: 'streamableHttp',
    baseUrl: 'https://mcp.api.coingecko.com/mcp',
    description: 'Keyless public cryptocurrency market data for light testing and prototyping.',
    provider: 'CoinGecko',
    providerUrl: 'https://mcp.api.coingecko.com/',
    tags: ['Market Data', 'Crypto', 'No Auth']
  }
] as const satisfies readonly PublicMcpPreset[]

export function initPublicMcpPresets(): MCPServer[] {
  return PUBLIC_MCP_PRESETS.map(preset => ({
    ...preset,
    tags: preset.tags ? [...preset.tags] : undefined,
    disabledTools: 'disabledTools' in preset ? [...preset.disabledTools] : undefined,
    isActive: false,
    isTrusted: false
  }))
}
