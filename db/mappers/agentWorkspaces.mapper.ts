import type { WorkspaceDescriptor } from '@/agent/workspace/types'

export function transformDbToAgentWorkspace(dbRecord: any): WorkspaceDescriptor {
  return {
    id: dbRecord.id,
    name: dbRecord.name,
    kind: dbRecord.kind,
    rootUri: dbRecord.root_uri,
    readOnly: !!dbRecord.read_only,
    createdAt: dbRecord.created_at,
    updatedAt: dbRecord.updated_at,
    lastUsedAt: dbRecord.last_used_at ?? null
  }
}

export function transformAgentWorkspaceToDb(workspace: WorkspaceDescriptor) {
  return {
    id: workspace.id,
    name: workspace.name,
    kind: workspace.kind,
    root_uri: workspace.rootUri,
    read_only: workspace.readOnly,
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
    last_used_at: workspace.lastUsedAt ?? null
  }
}
