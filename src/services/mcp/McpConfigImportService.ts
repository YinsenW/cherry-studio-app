import type { MCPServer, McpServerConfig } from '@/types/mcp'
import { safeValidateMcpServerConfig } from '@/types/mcp'
import { uuid } from '@/utils'

export type McpJsonImportErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_ROOT'
  | 'NO_SERVERS'
  | 'INVALID_SERVER'
  | 'UNSUPPORTED_STDIO'
  | 'UNSUPPORTED_TRANSPORT'
  | 'MISSING_ENDPOINT'
  | 'INVALID_URL'
  | 'DUPLICATE_NAME'

export type McpJsonImportError = {
  code: McpJsonImportErrorCode
  name?: string
}

export type McpJsonImportResult =
  | {
      success: true
      servers: MCPServer[]
    }
  | {
      success: false
      errors: McpJsonImportError[]
    }

type ImportDependencies = {
  idFactory?: () => string
  now?: () => number
}

type ServerCandidate = {
  nameHint?: string
  config: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getCandidates(value: unknown): ServerCandidate[] | null {
  // A bare array is a convenient format for exporting/importing several
  // remote servers without adding an extra wrapper.
  if (Array.isArray(value)) {
    return value.map(config => ({ config }))
  }

  if (!isRecord(value)) {
    return null
  }

  const collection = value.mcpServers ?? value.servers
  if (Array.isArray(collection)) {
    return collection.map(config => ({ config }))
  }

  if (isRecord(collection)) {
    return Object.entries(collection).map(([nameHint, config]) => ({ nameHint, config }))
  }

  // A single remote server configuration can be pasted without a wrapper.
  if ('url' in value || 'baseUrl' in value || 'serverUrl' in value || 'command' in value || 'type' in value) {
    return [{ config: value }]
  }

  return null
}

/**
 * Accept a couple of common remote-MCP aliases before applying the strict
 * configuration schema. Remaining unknown keys are intentionally rejected.
 */
function normalizeConfigShape(config: unknown): unknown {
  if (!isRecord(config)) {
    return config
  }

  const normalized = { ...config }

  if (normalized.type === undefined && typeof normalized.transport === 'string') {
    normalized.type = normalized.transport
  }
  delete normalized.transport

  if (normalized.url === undefined && typeof normalized.serverUrl === 'string') {
    normalized.url = normalized.serverUrl
  }
  delete normalized.serverUrl

  return normalized
}

function makeError(code: McpJsonImportErrorCode, name?: string): McpJsonImportResult {
  return { success: false, errors: [{ code, name }] }
}

function toRemoteMcpServer(
  parsedConfig: McpServerConfig,
  nameHint: string | undefined,
  idFactory: () => string,
  now: () => number
): McpJsonImportResult {
  const name = (parsedConfig.name || nameHint || '').trim()
  if (!name) {
    return makeError('INVALID_SERVER')
  }

  const endpoint = (parsedConfig.baseUrl || parsedConfig.url || '').trim()
  const transport = parsedConfig.type ?? 'streamableHttp'

  // Claude Desktop and similar exports omit `type` for local command-based
  // MCPs, so identify both explicit and inferred stdio before the generic
  // unsupported-transport case.
  if (parsedConfig.command || transport === 'stdio') {
    return makeError('UNSUPPORTED_STDIO', name)
  }

  if (transport !== 'streamableHttp') {
    return makeError('UNSUPPORTED_TRANSPORT', name)
  }

  if (!endpoint) {
    return makeError('MISSING_ENDPOINT', name)
  }

  try {
    const endpointUrl = new URL(endpoint)
    if (endpointUrl.protocol !== 'http:' && endpointUrl.protocol !== 'https:') {
      return makeError('INVALID_URL', name)
    }
  } catch {
    return makeError('INVALID_URL', name)
  }

  return {
    success: true,
    servers: [
      {
        id: idFactory(),
        name,
        type: 'streamableHttp',
        baseUrl: endpoint,
        description: parsedConfig.description,
        headers: parsedConfig.headers,
        timeout: parsedConfig.timeout,
        provider: parsedConfig.provider,
        providerUrl: parsedConfig.providerUrl,
        logoUrl: parsedConfig.logoUrl,
        tags: parsedConfig.tags,
        reference: parsedConfig.reference,
        disabledTools: parsedConfig.disabledTools,
        disabledAutoApproveTools: parsedConfig.disabledAutoApproveTools,
        isActive: parsedConfig.isActive ?? false,
        installedAt: now()
      }
    ]
  }
}

/**
 * Parse a pasted MCP JSON configuration into remote MCP records that this
 * mobile app can actually connect to. Local stdio, SSE and in-memory configs
 * are rejected before any database write so imports are all-or-nothing.
 */
export function parseMcpJsonConfig(jsonText: string, dependencies: ImportDependencies = {}): McpJsonImportResult {
  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch {
    return makeError('INVALID_JSON')
  }

  const candidates = getCandidates(value)
  if (!candidates) {
    return makeError('INVALID_ROOT')
  }
  if (candidates.length === 0) {
    return makeError('NO_SERVERS')
  }

  const idFactory = dependencies.idFactory ?? uuid
  const now = dependencies.now ?? Date.now
  const servers: MCPServer[] = []
  const names = new Set<string>()

  for (const candidate of candidates) {
    const validation = safeValidateMcpServerConfig(normalizeConfigShape(candidate.config))
    if (!validation.success) {
      return makeError('INVALID_SERVER', candidate.nameHint)
    }

    const converted = toRemoteMcpServer(validation.data, candidate.nameHint, idFactory, now)
    if (!converted.success) {
      return converted
    }

    const server = converted.servers[0]
    const nameKey = server.name.trim().toLocaleLowerCase()
    if (names.has(nameKey)) {
      return makeError('DUPLICATE_NAME', server.name)
    }
    names.add(nameKey)
    servers.push(server)
  }

  return { success: true, servers }
}
