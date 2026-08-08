const MAX_ERROR_MESSAGE_LENGTH = 2_000
const MAX_RESPONSE_BODY_LENGTH = 8_000
const UNKNOWN_AGENT_ERROR_MESSAGE = 'Unknown model provider error.'

export type AgentErrorMetadata = {
  statusCode?: number
  responseBody?: string
}

export type NormalizedAgentError = Error & AgentErrorMetadata

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength)}…`
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function getNestedErrorMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined
  if (typeof value === 'string' && value.trim()) return value.trim()

  const record = getRecord(value)
  if (!record) return undefined

  for (const key of ['message', 'msg', 'detail', 'error_description']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }

  if ('error' in record) {
    return getNestedErrorMessage(record.error, depth + 1)
  }

  return undefined
}

function getResponseBodyMessage(responseBody: string): string | undefined {
  const trimmed = responseBody.trim()
  if (!trimmed) return undefined

  try {
    const parsed = JSON.parse(trimmed) as unknown
    return getNestedErrorMessage(parsed) ?? truncate(trimmed, MAX_ERROR_MESSAGE_LENGTH)
  } catch {
    return truncate(trimmed, MAX_ERROR_MESSAGE_LENGTH)
  }
}

function getErrorMetadata(error: unknown): AgentErrorMetadata {
  const record = getRecord(error)
  if (!record) return {}

  return {
    ...(typeof record.statusCode === 'number' ? { statusCode: record.statusCode } : {}),
    ...(typeof record.responseBody === 'string' && record.responseBody.trim()
      ? { responseBody: truncate(record.responseBody, MAX_RESPONSE_BODY_LENGTH) }
      : {})
  }
}

export function getAgentErrorMessage(error: unknown, fallback = UNKNOWN_AGENT_ERROR_MESSAGE): string {
  const metadata = getErrorMetadata(error)
  const responseMessage = metadata.responseBody ? getResponseBodyMessage(metadata.responseBody) : undefined
  const directMessage =
    error instanceof Error
      ? error.message.trim()
      : typeof getRecord(error)?.message === 'string'
        ? String(getRecord(error)?.message).trim()
        : ''

  const message = responseMessage || directMessage
  if (message) {
    return truncate(
      typeof metadata.statusCode === 'number' && !message.startsWith(`HTTP ${metadata.statusCode}`)
        ? `HTTP ${metadata.statusCode}: ${message}`
        : message,
      MAX_ERROR_MESSAGE_LENGTH
    )
  }

  if (typeof metadata.statusCode === 'number') {
    return `HTTP ${metadata.statusCode}`
  }

  if (typeof error === 'string' && error.trim()) {
    return truncate(error, MAX_ERROR_MESSAGE_LENGTH)
  }

  try {
    const serialized = JSON.stringify(error)
    if (serialized && serialized !== '{}') {
      return truncate(serialized, MAX_ERROR_MESSAGE_LENGTH)
    }
  } catch {
    // Fall through to the stable user-facing fallback.
  }

  return fallback
}

export function normalizeAgentError(error: unknown, fallback?: string): NormalizedAgentError {
  const metadata = getErrorMetadata(error)
  const normalized = new Error(getAgentErrorMessage(error, fallback)) as NormalizedAgentError

  if (error instanceof Error) {
    normalized.name = error.name
    normalized.stack = error.stack
    normalized.cause = error.cause
  } else if (error !== undefined) {
    normalized.cause = error
  }

  normalized.statusCode = metadata.statusCode
  normalized.responseBody = metadata.responseBody
  return normalized
}
