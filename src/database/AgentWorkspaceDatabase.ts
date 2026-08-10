import {
  agentWorkspaceQueries,
  bindAgentWorkspaceToTopic,
  deleteAgentFileOperationsByTopic,
  deleteAgentWorkspace,
  getAgentWorkspaceBinding,
  getAgentWorkspaceById,
  getAgentWorkspaces,
  pruneAgentFileOperations,
  recordAgentFileOperation,
  upsertAgentWorkspace
} from '@db/queries/agentWorkspaces.queries'

import type { WorkspaceDescriptor } from '@/agent/workspace/types'

export const agentWorkspaceDatabase = {
  upsertWorkspace: (workspace: WorkspaceDescriptor) => upsertAgentWorkspace(workspace),
  getWorkspaceById: (id: string) => getAgentWorkspaceById(id),
  getWorkspaces: () => getAgentWorkspaces(),
  deleteWorkspace: (id: string) => deleteAgentWorkspace(id),
  bindToTopic: (topicId: string, workspaceId: string, relativePath = '.') =>
    bindAgentWorkspaceToTopic(topicId, workspaceId, relativePath),
  getBinding: (topicId: string) => getAgentWorkspaceBinding(topicId),
  recordOperation: recordAgentFileOperation,
  deleteOperationsForTopic: deleteAgentFileOperationsByTopic,
  pruneOperations: pruneAgentFileOperations
}

// Keep this named export for callers that prefer the database module pattern.
export { agentWorkspaceQueries }
