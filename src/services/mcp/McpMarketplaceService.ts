import type { MCPServer } from '@/types/mcp'
import { uuid } from '@/utils'

/**
 * Public MCP marketplaces supported by the mobile client.
 *
 * The app only installs remote Streamable HTTP endpoints. Registry entries
 * that only describe local stdio commands are deliberately left out of the
 * installation path because a mobile device cannot run them.
 */
export type McpMarketplaceId = 'modelscope' | 'registry'

export type McpMarketplaceErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'DEPLOYMENT_AUTH_REQUIRED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'CONFIGURATION_REQUIRED'
  | 'INVALID_RESPONSE'
  | 'NO_REMOTE_ENDPOINT'
  | 'NOT_MOBILE_COMPATIBLE'
  | 'REQUEST_ABORTED'
  | 'UNKNOWN'

export class McpMarketplaceError extends Error {
  constructor(
    public readonly code: McpMarketplaceErrorCode,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'McpMarketplaceError'
  }
}

export interface McpMarketplaceSearchOptions {
  query?: string
  page?: number
  pageSize?: number
  cursor?: string
  signal?: AbortSignal
}

export interface McpMarketplaceServer {
  marketplace: McpMarketplaceId
  id: string
  name: string
  description?: string
  logoUrl?: string
  tags: string[]
  providerUrl: string
  isVerified?: boolean
  popularity?: number
  /** Whether the registry summary already identifies this as a remote listing. */
  isRemoteReady?: boolean
}

export interface McpMarketplaceSearchResult {
  servers: McpMarketplaceServer[]
  totalCount: number
  page: number
  pageSize: number
  totalPages?: number
  /** Cursor returned by the official Registry, if another page is available. */
  nextCursor?: string
}

export interface McpMarketplaceConfigurationField {
  /** Stable internal key used to associate the UI field with a remote manifest input. */
  key: string
  /** Human-readable label. Kept separate from key for generated header fields. */
  label?: string
  description?: string
  placeholder?: string
  defaultValue?: string
  required: boolean
  sensitive: boolean
}

export interface McpMarketplaceServerDetail extends McpMarketplaceServer {
  /** An installable Streamable HTTP endpoint, when the registry provides one. */
  endpoint?: string
  /**
   * Official Registry remote metadata. It is resolved only after the user has
   * supplied any URL-template and header values required by the server.
   */
  remote?: McpMarketplaceRemoteTransport
  /** ModelScope can start an isolated remote deployment for the current user. */
  canDeploy: boolean
  configuration: McpMarketplaceConfigurationField[]
  securityScanPassed?: boolean
}

export interface McpMarketplaceRemoteHeader {
  name: string
  valueTemplate?: string
  /** Present when the header value itself is collected from the user. */
  configurationKey?: string
  defaultValue?: string
  description?: string
  required: boolean
  sensitive: boolean
  variables: McpMarketplaceRemoteVariable[]
}

export interface McpMarketplaceRemoteVariable {
  name: string
  /** The local configuration field used when this value is user-supplied. */
  configurationKey?: string
  /** A registry-provided fixed value (which may reference other variables). */
  valueTemplate?: string
  defaultValue?: string
}

export interface McpMarketplaceRemoteTransport {
  urlTemplate: string
  variables: McpMarketplaceRemoteVariable[]
  headers: McpMarketplaceRemoteHeader[]
}

export interface McpMarketplaceConnection {
  endpoint: string
  headers?: Record<string, string>
}

export interface McpMarketplaceDeployment {
  endpoint: string
  authRequired: boolean
}

export interface CreateMarketplaceMcpDependencies {
  idFactory?: () => string
  now?: () => number
}

export type MarketplaceFetchResponse = Pick<Response, 'ok' | 'status' | 'text'>
/** The subset of fetch options used by marketplace requests. */
export interface MarketplaceRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}
export type MarketplaceFetch = (input: string, init?: MarketplaceRequestOptions) => Promise<MarketplaceFetchResponse>

const MODELSCOPE_API_BASE = 'https://modelscope.cn/openapi/v1'
const OFFICIAL_REGISTRY_API_BASE = 'https://registry.modelcontextprotocol.io/v0.1'
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const REQUEST_TIMEOUT_MS = 20_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringTemplateValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const text = stringValue(item)
    return text ? [text] : []
  })
}

/**
 * Marketplace endpoints must be HTTPS and must not encode credentials in the
 * URL. This is stricter than manual MCP entry on purpose: registry data is
 * untrusted input and should not introduce a downgrade or secret-leak path.
 */
function safeHttpsUrl(value: unknown): string | undefined {
  const text = stringValue(value)
  if (!text) return undefined

  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      return undefined
    }
    return url.toString()
  } catch {
    return undefined
  }
}

function safeHttpsUrlTemplate(value: unknown): string | undefined {
  const template = stringValue(value)
  if (!template) return undefined

  // A concrete URL parser cannot accept `{variable}` in every URL position.
  // Replace only complete placeholders while validating the scheme, authority,
  // and embedded-credential restrictions. Any unmatched braces are rejected.
  const validated = template.replace(/\{[^{}]+\}/g, 'registry-value')
  if (/[{}]/.test(validated)) return undefined
  return safeHttpsUrl(validated) ? template : undefined
}

const TEMPLATE_VARIABLE_PATTERN = /\{([^{}]+)\}/g
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function templateVariables(template: string): string[] {
  const variables = new Set<string>()
  for (const match of template.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    const name = match[1]?.trim()
    if (name && name.length <= 128) variables.add(name)
  }
  return [...variables]
}

function isValidHeaderName(value: string): boolean {
  return HTTP_HEADER_NAME_PATTERN.test(value)
}

function safeHeaderValue(value: string | undefined): string | undefined {
  if (!value || value.length > 8_192 || /[\r\n]/.test(value)) return undefined
  return value
}

function modelscopeProviderUrl(serverId: string): string {
  return `https://modelscope.cn/mcp/servers/${encodeURIComponent(serverId)}`
}

function officialRegistryProviderUrl(serverName: string): string {
  return `${OFFICIAL_REGISTRY_API_BASE}/servers/${encodeURIComponent(serverName)}/versions/latest`
}

function marketplaceProviderName(marketplace: McpMarketplaceId): string {
  return marketplace === 'modelscope' ? 'ModelScope MCP Plaza' : 'Official MCP Registry'
}

function registryTags(server: Record<string, unknown>): string[] {
  const metadata = isRecord(server._meta) ? server._meta : undefined
  const publisherMetadata = metadata ? metadata['io.modelcontextprotocol.registry/publisher-provided'] : undefined
  const publisher = isRecord(publisherMetadata) ? publisherMetadata : undefined
  return mergeTags(publisher?.categories, publisher?.keywords)
}

function registryLogoUrl(server: Record<string, unknown>): string | undefined {
  if (!Array.isArray(server.icons)) return undefined
  for (const icon of server.icons) {
    if (!isRecord(icon)) continue
    const url = safeHttpsUrl(icon.src)
    if (url) return url
  }
  return undefined
}

function unwrapModelScopeEnvelope(value: unknown): unknown {
  if (!isRecord(value)) return value

  if (value.success === false) {
    throw new McpMarketplaceError('INVALID_RESPONSE')
  }

  return 'data' in value ? value.data : value
}

function parseConfiguration(value: unknown): McpMarketplaceConfigurationField[] {
  if (!isRecord(value) || !isRecord(value.properties)) return []

  const required = new Set(stringList(value.required))
  return Object.entries(value.properties).flatMap(([key, rawField]) => {
    if (!key.trim()) return []
    const field = isRecord(rawField) ? rawField : {}
    return [
      {
        key,
        description: stringValue(field.description),
        required: required.has(key),
        sensitive: /(?:api[_-]?key|token|secret|password|credential|authorization)/i.test(key)
      }
    ]
  })
}

function mergeTags(...values: unknown[]): string[] {
  return Array.from(new Set(values.flatMap(stringList))).slice(0, 12)
}

function clampPage(value: number | undefined): number {
  return Math.max(1, Math.floor(value ?? 1))
}

function clampPageSize(value: number | undefined): number {
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(value ?? DEFAULT_PAGE_SIZE)))
}

function configurationValue(
  field: Pick<McpMarketplaceConfigurationField, 'key' | 'defaultValue'>,
  configuration: Record<string, string>
): string | undefined {
  const rawValue = configuration[field.key] ?? field.defaultValue
  return typeof rawValue === 'string' && rawValue.trim() ? rawValue.trim() : undefined
}

export function isMarketplaceConfigurationSatisfied(
  field: McpMarketplaceConfigurationField,
  configuration: Record<string, string>
): boolean {
  return Boolean(configurationValue(field, configuration))
}

function addConfigurationField(
  fields: Map<string, McpMarketplaceConfigurationField>,
  field: McpMarketplaceConfigurationField
): void {
  const existing = fields.get(field.key)
  if (existing) {
    existing.required ||= field.required
    existing.sensitive ||= field.sensitive
    existing.description ??= field.description
    existing.placeholder ??= field.placeholder
    existing.defaultValue ??= field.defaultValue
    existing.label ??= field.label
    return
  }
  fields.set(field.key, field)
}

function createRegistryInputVariable(
  name: string,
  input: unknown,
  configurationKey: string,
  forceRequired: boolean,
  fields: Map<string, McpMarketplaceConfigurationField>
): McpMarketplaceRemoteVariable {
  const value = isRecord(input) ? input : {}
  const valueTemplate = stringTemplateValue(value.value)
  if (valueTemplate !== undefined) {
    return { name, valueTemplate }
  }

  const defaultValue = stringTemplateValue(value.default)
  addConfigurationField(fields, {
    key: configurationKey,
    label: name,
    description: stringValue(value.description),
    placeholder: stringValue(value.placeholder),
    defaultValue,
    required: forceRequired || booleanValue(value.isRequired) === true,
    sensitive:
      booleanValue(value.isSecret) === true ||
      /(?:api[_-]?key|token|secret|password|credential|authorization)/i.test(name)
  })
  return { name, configurationKey, defaultValue }
}

function resolveTemplate(
  template: string,
  getValue: (name: string) => string | undefined,
  encodeValues: boolean
): string | undefined {
  let unresolved = false
  const resolved = template.replace(TEMPLATE_VARIABLE_PATTERN, (placeholder, rawName: string) => {
    const value = getValue(rawName.trim())
    if (!value) {
      unresolved = true
      return placeholder
    }
    return encodeValues ? encodeURIComponent(value) : value
  })
  return unresolved || /[{}]/.test(resolved) ? undefined : resolved
}

function resolveRemoteVariables(
  variables: McpMarketplaceRemoteVariable[],
  configuration: Record<string, string>,
  getFallbackValue?: (name: string) => string | undefined
): (name: string) => string | undefined {
  const byName = new Map(variables.map(variable => [variable.name, variable]))
  const resolved = new Map<string, string | undefined>()
  const resolving = new Set<string>()

  const getValue = (name: string): string | undefined => {
    if (resolved.has(name)) return resolved.get(name)
    const variable = byName.get(name)
    if (!variable) return getFallbackValue?.(name)
    if (resolving.has(name)) return undefined

    resolving.add(name)
    let value: string | undefined
    if (variable.configurationKey) {
      value = configurationValue({ key: variable.configurationKey, defaultValue: variable.defaultValue }, configuration)
    } else if (variable.valueTemplate !== undefined) {
      value = resolveTemplate(variable.valueTemplate, getValue, false)
    }
    resolving.delete(name)
    resolved.set(name, value)
    return value
  }

  return getValue
}

function parseOfficialRegistryRemote(value: unknown): {
  remote: McpMarketplaceRemoteTransport
  configuration: McpMarketplaceConfigurationField[]
} | null {
  if (!isRecord(value) || value.type !== 'streamable-http') return null
  const urlTemplate = safeHttpsUrlTemplate(value.url)
  if (!urlTemplate) return null

  const fields = new Map<string, McpMarketplaceConfigurationField>()
  const rawVariables = isRecord(value.variables) ? value.variables : {}
  const remoteVariables = new Map<string, McpMarketplaceRemoteVariable>()
  const ensureRemoteVariable = (name: string, required: boolean): McpMarketplaceRemoteVariable | undefined => {
    if (!name) return undefined
    const existing = remoteVariables.get(name)
    if (existing) {
      if (existing.configurationKey) {
        const field = fields.get(existing.configurationKey)
        if (field) field.required ||= required
      }
      return existing
    }

    const variable = createRegistryInputVariable(name, rawVariables[name], `url:${name}`, required, fields)
    remoteVariables.set(name, variable)
    if (variable.valueTemplate !== undefined) {
      templateVariables(variable.valueTemplate).forEach(dependency => ensureRemoteVariable(dependency, required))
    }
    return variable
  }

  templateVariables(urlTemplate).forEach(name => ensureRemoteVariable(name, true))

  const rawHeaders = Array.isArray(value.headers) ? value.headers : []
  const headers: McpMarketplaceRemoteHeader[] = []
  for (const [index, rawHeader] of rawHeaders.entries()) {
    if (!isRecord(rawHeader)) return null
    const name = stringValue(rawHeader.name)
    if (!name || !isValidHeaderName(name)) return null

    const required = booleanValue(rawHeader.isRequired) === true
    const sensitive =
      booleanValue(rawHeader.isSecret) === true ||
      /(?:api[_-]?key|token|secret|password|credential|authorization)/i.test(name)
    const valueTemplate = stringTemplateValue(rawHeader.value)
    const rawHeaderVariables = isRecord(rawHeader.variables) ? rawHeader.variables : {}
    const headerVariables = new Map<string, McpMarketplaceRemoteVariable>()
    const ensureHeaderVariable = (variableName: string, forceRequired: boolean) => {
      const existing = headerVariables.get(variableName)
      if (existing) {
        if (existing.configurationKey) {
          const field = fields.get(existing.configurationKey)
          if (field) field.required ||= forceRequired
        }
        return existing
      }

      if (!(variableName in rawHeaderVariables)) {
        return ensureRemoteVariable(variableName, forceRequired)
      }

      const variable = createRegistryInputVariable(
        variableName,
        rawHeaderVariables[variableName],
        `header:${index}:variable:${variableName}`,
        forceRequired,
        fields
      )
      headerVariables.set(variableName, variable)
      if (variable.valueTemplate !== undefined) {
        templateVariables(variable.valueTemplate).forEach(dependency => ensureHeaderVariable(dependency, forceRequired))
      }
      return variable
    }

    if (valueTemplate !== undefined) {
      templateVariables(valueTemplate).forEach(variableName => ensureHeaderVariable(variableName, required))
    }

    let configurationKey: string | undefined
    const defaultValue = stringTemplateValue(rawHeader.default)
    if (valueTemplate === undefined) {
      configurationKey = `header:${index}:${name}`
      addConfigurationField(fields, {
        key: configurationKey,
        label: name,
        description: stringValue(rawHeader.description),
        placeholder: stringValue(rawHeader.placeholder),
        defaultValue,
        required,
        sensitive
      })
    }

    headers.push({
      name,
      valueTemplate,
      configurationKey,
      defaultValue,
      description: stringValue(rawHeader.description),
      required,
      sensitive,
      variables: [...headerVariables.values()]
    })
  }

  return {
    remote: { urlTemplate, variables: [...remoteVariables.values()], headers },
    configuration: [...fields.values()]
  }
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError'
}

/**
 * Integrates only documented, public marketplace APIs. Marketplace browsing
 * itself has no persistent credential; sensitive remote configuration is only
 * handled by the install sheet and never sent back to either registry.
 */
export class McpMarketplaceService {
  constructor(private readonly fetchFn: MarketplaceFetch = fetch as MarketplaceFetch) {}

  async searchModelScope(options: McpMarketplaceSearchOptions = {}): Promise<McpMarketplaceSearchResult> {
    const page = clampPage(options.page)
    const pageSize = clampPageSize(options.pageSize)
    const data = await this.requestJson(`${MODELSCOPE_API_BASE}/mcp/servers`, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        page_number: page,
        page_size: pageSize,
        ...(options.query?.trim() ? { search: options.query.trim() } : {}),
        // The list response does not always include is_hosted, but this filter
        // reduces the chance of surfacing local-only entries. Details are still
        // checked before an install button is ever shown.
        filter: { is_hosted: true }
      }),
      signal: options.signal
    })

    const payload = unwrapModelScopeEnvelope(data)
    if (!isRecord(payload)) {
      throw new McpMarketplaceError('INVALID_RESPONSE')
    }

    const list = Array.isArray(payload.mcp_server_list)
      ? payload.mcp_server_list
      : Array.isArray(payload.servers)
        ? payload.servers
        : null

    if (!list) {
      throw new McpMarketplaceError('INVALID_RESPONSE')
    }

    const servers = list.flatMap(item => {
      if (!isRecord(item)) return []
      const id = stringValue(item.id)
      if (!id) return []

      const name = stringValue(item.chinese_name) ?? stringValue(item.name) ?? id
      return [
        {
          marketplace: 'modelscope' as const,
          id,
          name,
          description: stringValue(item.description),
          logoUrl: safeHttpsUrl(item.logo_url),
          tags: mergeTags(item.tags, item.categories),
          providerUrl: modelscopeProviderUrl(id),
          isVerified: booleanValue(item.is_verified),
          popularity: numberValue(item.view_count),
          isRemoteReady: booleanValue(item.is_hosted)
        }
      ]
    })

    return {
      servers,
      totalCount: numberValue(payload.total_count) ?? servers.length,
      page,
      pageSize
    }
  }

  async getModelScopeServer(serverId: string, signal?: AbortSignal): Promise<McpMarketplaceServerDetail> {
    if (!serverId.trim()) {
      throw new McpMarketplaceError('INVALID_RESPONSE')
    }

    const data = await this.requestJson(`${MODELSCOPE_API_BASE}/mcp/servers/${encodeURIComponent(serverId)}`, {
      headers: { Accept: 'application/json' },
      signal
    })
    const payload = unwrapModelScopeEnvelope(data)
    if (!isRecord(payload)) {
      throw new McpMarketplaceError('INVALID_RESPONSE')
    }

    const id = stringValue(payload.id) ?? serverId
    const name = stringValue(payload.chinese_name) ?? stringValue(payload.name) ?? id
    const isHosted = booleanValue(payload.is_hosted) === true

    return {
      marketplace: 'modelscope',
      id,
      name,
      description: stringValue(payload.description),
      logoUrl: safeHttpsUrl(payload.logo_url),
      tags: mergeTags(payload.tags, payload.categories),
      providerUrl: modelscopeProviderUrl(id),
      isVerified: booleanValue(payload.is_verified),
      popularity: numberValue(payload.view_count),
      isRemoteReady: isHosted,
      canDeploy: isHosted,
      configuration: parseConfiguration(payload.env_schema),
      securityScanPassed: undefined
    }
  }

  async deployModelScopeServer(
    serverId: string,
    accessToken: string,
    configuration: Record<string, string>,
    signal?: AbortSignal
  ): Promise<McpMarketplaceDeployment> {
    if (!serverId.trim() || !accessToken.trim()) {
      throw new McpMarketplaceError('AUTHENTICATION_REQUIRED')
    }

    const envInfo = Object.fromEntries(
      Object.entries(configuration)
        .map(([key, value]) => [key.trim(), value.trim()] as const)
        .filter(([key, value]) => key && value)
    )
    const data = await this.requestJson(`${MODELSCOPE_API_BASE}/mcp/servers/${encodeURIComponent(serverId)}/deploy`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken.trim()}`
      },
      body: JSON.stringify({
        transport_type: 'streamable_http',
        // A marketplace installation must remain usable after the current
        // screen closes. ModelScope documents -1 as a non-expiring deployment;
        // users explicitly confirm this before the request is sent.
        expiration_minutes: -1,
        ...(Object.keys(envInfo).length > 0 ? { env_info: envInfo } : {})
      }),
      signal
    })
    const payload = unwrapModelScopeEnvelope(data)
    if (!isRecord(payload)) {
      throw new McpMarketplaceError('INVALID_RESPONSE')
    }

    const endpoint = safeHttpsUrl(payload.url)
    if (!endpoint) {
      throw new McpMarketplaceError('NO_REMOTE_ENDPOINT')
    }

    const transport = stringValue(payload.transport_type)
    if (transport && transport !== 'streamable_http' && transport !== 'streamableHttp') {
      throw new McpMarketplaceError('NO_REMOTE_ENDPOINT')
    }

    return {
      endpoint,
      authRequired: booleanValue(payload.auth_required) === true
    }
  }

  async searchOfficialRegistry(options: McpMarketplaceSearchOptions = {}): Promise<McpMarketplaceSearchResult> {
    const page = clampPage(options.page)
    const pageSize = clampPageSize(options.pageSize)
    const params = new URLSearchParams({ version: 'latest', limit: String(pageSize) })
    if (options.query?.trim()) {
      params.set('search', options.query.trim())
    }
    if (options.cursor?.trim()) {
      params.set('cursor', options.cursor.trim())
    }

    const payload = await this.requestJson(`${OFFICIAL_REGISTRY_API_BASE}/servers?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: options.signal
    })
    if (!isRecord(payload) || !Array.isArray(payload.servers)) {
      throw new McpMarketplaceError('INVALID_RESPONSE')
    }

    const servers = payload.servers.flatMap(item => {
      if (!isRecord(item) || !isRecord(item.server)) return []
      const server = item.server
      const id = stringValue(server.name)
      if (!id || !Array.isArray(server.remotes)) return []

      // The public Registry can list stdio-only and legacy SSE entries. The
      // app intentionally exposes only a transport it can actually use.
      const remote = server.remotes
        .map(parseOfficialRegistryRemote)
        .find((parsed): parsed is NonNullable<typeof parsed> => parsed !== null)
      if (!remote) return []

      return [
        {
          marketplace: 'registry' as const,
          id,
          name: stringValue(server.title) ?? id,
          description: stringValue(server.description),
          logoUrl: registryLogoUrl(server),
          tags: registryTags(server),
          providerUrl: officialRegistryProviderUrl(id),
          isRemoteReady: true
        }
      ]
    })

    const metadata = isRecord(payload.metadata) ? payload.metadata : {}
    return {
      // Registry metadata.count is the number returned for this cursor, not a
      // stable total across our client-side transport filter. Pagination uses
      // nextCursor instead, so the displayed count never promises too much.
      servers,
      totalCount: servers.length,
      page,
      pageSize,
      nextCursor: stringValue(metadata.nextCursor)
    }
  }

  async getOfficialRegistryServer(serverName: string, signal?: AbortSignal): Promise<McpMarketplaceServerDetail> {
    if (!serverName.trim()) {
      throw new McpMarketplaceError('INVALID_RESPONSE')
    }

    const payload = await this.requestJson(officialRegistryProviderUrl(serverName), {
      headers: { Accept: 'application/json' },
      signal
    })
    const server = isRecord(payload) && isRecord(payload.server) ? payload.server : undefined
    if (!server) {
      throw new McpMarketplaceError('INVALID_RESPONSE')
    }

    const id = stringValue(server.name) ?? serverName
    const parsedRemote = Array.isArray(server.remotes)
      ? server.remotes
          .map(parseOfficialRegistryRemote)
          .find((parsed): parsed is NonNullable<typeof parsed> => parsed !== null)
      : undefined

    return {
      marketplace: 'registry',
      id,
      name: stringValue(server.title) ?? id,
      description: stringValue(server.description),
      logoUrl: registryLogoUrl(server),
      tags: registryTags(server),
      providerUrl: officialRegistryProviderUrl(id),
      isRemoteReady: Boolean(parsedRemote),
      endpoint: parsedRemote?.remote.urlTemplate.includes('{')
        ? undefined
        : safeHttpsUrl(parsedRemote?.remote.urlTemplate),
      remote: parsedRemote?.remote,
      canDeploy: false,
      configuration: parsedRemote?.configuration ?? [],
      // Registry status is not a security audit. Deliberately do not use it as
      // a verification or safety signal in the UI.
      securityScanPassed: undefined
    }
  }

  createRemoteConnection(
    detail: McpMarketplaceServerDetail,
    configuration: Record<string, string>
  ): McpMarketplaceConnection {
    if (detail.marketplace !== 'registry' || !detail.remote) {
      throw new McpMarketplaceError('NO_REMOTE_ENDPOINT')
    }

    if (
      !detail.configuration.every(field => !field.required || isMarketplaceConfigurationSatisfied(field, configuration))
    ) {
      throw new McpMarketplaceError('CONFIGURATION_REQUIRED')
    }

    const getRemoteVariable = resolveRemoteVariables(detail.remote.variables, configuration)
    const endpointValue = resolveTemplate(detail.remote.urlTemplate, getRemoteVariable, true)
    const endpoint = safeHttpsUrl(endpointValue)
    if (!endpoint) {
      throw new McpMarketplaceError('NO_REMOTE_ENDPOINT')
    }

    const headers: Record<string, string> = {}
    for (const header of detail.remote.headers) {
      let value: string | undefined
      if (header.configurationKey) {
        value = configurationValue({ key: header.configurationKey, defaultValue: header.defaultValue }, configuration)
      } else if (header.valueTemplate !== undefined) {
        const getHeaderVariable = resolveRemoteVariables(header.variables, configuration, getRemoteVariable)
        value = resolveTemplate(header.valueTemplate, getHeaderVariable, false)
      }

      const validValue = safeHeaderValue(value)
      if (!validValue) {
        if (header.required) throw new McpMarketplaceError('CONFIGURATION_REQUIRED')
        continue
      }
      headers[header.name] = validValue
    }

    return { endpoint, ...(Object.keys(headers).length > 0 ? { headers } : {}) }
  }

  /**
   * Create an app-native MCP record from a verified remote marketplace result.
   * User-provided remote headers are stored on the installed MCP record, just
   * as with the existing manual form. Marketplace access itself has no key.
   */
  toMcpServer(
    detail: McpMarketplaceServerDetail,
    connection: string | McpMarketplaceConnection,
    dependencies: CreateMarketplaceMcpDependencies = {}
  ): MCPServer {
    const endpoint = typeof connection === 'string' ? connection : connection.endpoint
    const baseUrl = safeHttpsUrl(endpoint)
    if (!baseUrl) {
      throw new McpMarketplaceError('NO_REMOTE_ENDPOINT')
    }

    const headers =
      typeof connection === 'string'
        ? undefined
        : Object.fromEntries(
            Object.entries(connection.headers ?? {}).flatMap(([name, value]) => {
              const validValue = safeHeaderValue(value)
              return isValidHeaderName(name) && validValue ? [[name, validValue]] : []
            })
          )

    return {
      id: dependencies.idFactory?.() ?? uuid(),
      name: detail.name.trim() || detail.id,
      type: 'streamableHttp',
      baseUrl,
      description: detail.description,
      provider: marketplaceProviderName(detail.marketplace),
      providerUrl: detail.providerUrl,
      logoUrl: detail.logoUrl,
      tags: detail.tags,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      isActive: true,
      installedAt: dependencies.now?.() ?? Date.now()
    }
  }

  private async requestJson(url: string, init: MarketplaceRequestOptions): Promise<unknown> {
    let response: MarketplaceFetchResponse
    try {
      response = await this.fetchWithTimeout(url, init)
    } catch (error) {
      if (isAbortError(error)) {
        throw new McpMarketplaceError('REQUEST_ABORTED')
      }
      throw new McpMarketplaceError('NETWORK_ERROR')
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      throw new McpMarketplaceError('INVALID_RESPONSE')
    }

    let payload: unknown
    try {
      payload = text.trim() ? JSON.parse(text) : null
    } catch {
      throw new McpMarketplaceError('INVALID_RESPONSE')
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new McpMarketplaceError('UNAUTHORIZED')
      }
      if (response.status === 429) {
        throw new McpMarketplaceError('RATE_LIMITED')
      }
      throw new McpMarketplaceError('UNKNOWN')
    }

    if (payload === null) {
      throw new McpMarketplaceError('INVALID_RESPONSE')
    }

    return payload
  }

  /**
   * A registry should never leave a mobile screen indefinitely loading. Keep
   * the caller's cancellation signal intact while adding a bounded network
   * deadline for both browsing and deployment requests.
   */
  private async fetchWithTimeout(url: string, init: MarketplaceRequestOptions): Promise<MarketplaceFetchResponse> {
    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = () => controller.abort()
    if (init.signal?.aborted) controller.abort()
    init.signal?.addEventListener('abort', abortFromCaller)
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)

    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (timedOut) {
        throw new McpMarketplaceError('NETWORK_ERROR')
      }
      throw error
    } finally {
      clearTimeout(timeout)
      init.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

export const mcpMarketplaceService = new McpMarketplaceService()

export function isMcpMarketplaceError(error: unknown): error is McpMarketplaceError {
  return error instanceof McpMarketplaceError
}
