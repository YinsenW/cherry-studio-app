import { desc, eq } from 'drizzle-orm'

import type { WorkspaceDescriptor } from '@/agent/workspace/types'
import { loggerService } from '@/services/LoggerService'

import { db } from '..'
import { transformAgentWorkspaceToDb, transformDbToAgentWorkspace } from '../mappers/agentWorkspaces.mapper'
import { agentFileOperations, agentTopicWorkspaces, agentWorkspaces } from '../schema'

const logger = loggerService.withContext('DataBase AgentWorkspaces')

export async function upsertAgentWorkspace(workspace: WorkspaceDescriptor) {
  await db
    .insert(agentWorkspaces)
    .values(transformAgentWorkspaceToDb(workspace))
    .onConflictDoUpdate({
      target: agentWorkspaces.id,
      set: {
        name: workspace.name,
        kind: workspace.kind,
        root_uri: workspace.rootUri,
        read_only: workspace.readOnly,
        updated_at: workspace.updatedAt,
        last_used_at: workspace.lastUsedAt ?? null
      }
    })
}

export async function getAgentWorkspaceById(id: string): Promise<WorkspaceDescriptor | null> {
  try {
    const result = await db.select().from(agentWorkspaces).where(eq(agentWorkspaces.id, id)).limit(1)
    return result[0] ? transformDbToAgentWorkspace(result[0]) : null
  } catch (error) {
    logger.error('Error getting agent workspace:', error)
    throw error
  }
}

export async function getAgentWorkspaces(): Promise<WorkspaceDescriptor[]> {
  const result = await db.select().from(agentWorkspaces).orderBy(desc(agentWorkspaces.last_used_at))
  return result.map(transformDbToAgentWorkspace)
}

export async function deleteAgentWorkspace(id: string) {
  return db.delete(agentWorkspaces).where(eq(agentWorkspaces.id, id))
}

export async function bindAgentWorkspaceToTopic(topicId: string, workspaceId: string, relativePath = '.') {
  const now = Date.now()
  return db
    .insert(agentTopicWorkspaces)
    .values({
      topic_id: topicId,
      workspace_id: workspaceId,
      relative_path: relativePath,
      created_at: now,
      updated_at: now
    })
    .onConflictDoUpdate({
      target: agentTopicWorkspaces.topic_id,
      set: { workspace_id: workspaceId, relative_path: relativePath, updated_at: now }
    })
}

export async function getAgentWorkspaceBinding(topicId: string) {
  return db
    .select()
    .from(agentTopicWorkspaces)
    .where(eq(agentTopicWorkspaces.topic_id, topicId))
    .limit(1)
    .then(rows => rows[0])
}

export async function recordAgentFileOperation(operation: {
  id: string
  workspaceId: string
  topicId?: string
  toolCallId?: string
  action: string
  path: string
  destination?: string
  beforeRevision?: string
  afterRevision?: string
  status: string
  approval: string
  bytesWritten?: number
  snapshotUri?: string
}) {
  return db.insert(agentFileOperations).values({
    id: operation.id,
    workspace_id: operation.workspaceId,
    topic_id: operation.topicId ?? null,
    tool_call_id: operation.toolCallId ?? null,
    action: operation.action,
    path: operation.path,
    destination: operation.destination ?? null,
    before_revision: operation.beforeRevision ?? null,
    after_revision: operation.afterRevision ?? null,
    status: operation.status,
    approval: operation.approval,
    bytes_written: operation.bytesWritten ?? null,
    snapshot_uri: operation.snapshotUri ?? null,
    created_at: Date.now()
  })
}

export const agentWorkspaceQueries = {
  upsertAgentWorkspace,
  getAgentWorkspaceById,
  getAgentWorkspaces,
  deleteAgentWorkspace,
  bindAgentWorkspaceToTopic,
  getAgentWorkspaceBinding,
  recordAgentFileOperation
}
