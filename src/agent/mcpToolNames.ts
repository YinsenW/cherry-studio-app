export type McpAgentToolMetadata = {
  serverId: string
  serverName: string
  toolName: string
}

const metadataByAgentToolName = new Map<string, McpAgentToolMetadata>()

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

export function registerMcpAgentToolName(metadata: McpAgentToolMetadata): string {
  const safeToolName = metadata.toolName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_') || 'tool'
  const prefix = `mcp_${stableHash(`${metadata.serverId}\u0000${metadata.toolName}`)}_`
  const agentToolName = `${prefix}${safeToolName.slice(0, 64 - prefix.length)}`
  metadataByAgentToolName.set(agentToolName, metadata)
  return agentToolName
}

export function getMcpAgentToolMetadata(agentToolName: string): McpAgentToolMetadata | undefined {
  return metadataByAgentToolName.get(agentToolName)
}
