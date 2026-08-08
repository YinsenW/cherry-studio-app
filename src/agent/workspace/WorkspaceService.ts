import { agentWorkspaceDatabase } from '@database'
import { Directory, Paths } from 'expo-file-system'

import { uuid } from '@/utils'

import { AppSandboxBackend } from './AppSandboxBackend'
import type { WorkspaceBackend, WorkspaceDescriptor } from './types'

const DEFAULT_WORKSPACE_ID = 'default-mobile-workspace'
const DEFAULT_WORKSPACE_NAME = '手机工作区'

/**
 * Resolves a topic's logical workspace into a backend. The service deliberately
 * keeps native URIs behind this boundary and exposes only logical paths.
 */
export class WorkspaceService {
  private static instance: WorkspaceService

  static getInstance(): WorkspaceService {
    if (!WorkspaceService.instance) WorkspaceService.instance = new WorkspaceService()
    return WorkspaceService.instance
  }

  private constructor() {}

  async ensureDefaultWorkspace(): Promise<WorkspaceDescriptor> {
    const existing = await agentWorkspaceDatabase.getWorkspaceById(DEFAULT_WORKSPACE_ID)
    if (existing) {
      await new AppSandboxBackend(existing).ensureReady()
      return existing
    }

    const now = Date.now()
    const rootUri = new Directory(Paths.document, 'AgentWorkspaces', DEFAULT_WORKSPACE_ID, 'root').uri
    const workspace: WorkspaceDescriptor = {
      id: DEFAULT_WORKSPACE_ID,
      name: DEFAULT_WORKSPACE_NAME,
      kind: 'app_sandbox',
      rootUri,
      readOnly: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    }
    await agentWorkspaceDatabase.upsertWorkspace(workspace)
    await new AppSandboxBackend(workspace).ensureReady()
    return workspace
  }

  async getWorkspace(workspaceId?: string): Promise<WorkspaceDescriptor> {
    if (!workspaceId) return this.ensureDefaultWorkspace()
    const workspace = await agentWorkspaceDatabase.getWorkspaceById(workspaceId)
    if (!workspace) return this.ensureDefaultWorkspace()
    return workspace
  }

  async getBackend(workspaceId?: string): Promise<WorkspaceBackend> {
    const workspace = await this.getWorkspace(workspaceId)
    const now = Date.now()
    await agentWorkspaceDatabase.upsertWorkspace({ ...workspace, updatedAt: now, lastUsedAt: now })

    return new AppSandboxBackend({ ...workspace, updatedAt: now, lastUsedAt: now })
  }

  async getBackendForTopic(topicId: string): Promise<WorkspaceBackend> {
    return this.getBackend((await this.getWorkspaceForTopic(topicId)).id)
  }

  async getWorkspaceForTopic(topicId: string): Promise<WorkspaceDescriptor> {
    const binding = await agentWorkspaceDatabase.getBinding(topicId)
    return this.getWorkspace(binding?.workspace_id)
  }

  async bindTopic(topicId: string, workspaceId: string, relativePath = '.') {
    const workspace = await this.getWorkspace(workspaceId)
    await agentWorkspaceDatabase.bindToTopic(topicId, workspace.id, relativePath)
    return workspace
  }

  async createSandboxWorkspace(name: string): Promise<WorkspaceDescriptor> {
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName.length > 80) throw new Error('Workspace name must be 1-80 characters.')
    const id = uuid()
    const now = Date.now()
    const workspace: WorkspaceDescriptor = {
      id,
      name: trimmedName,
      kind: 'app_sandbox',
      rootUri: new Directory(Paths.document, 'AgentWorkspaces', id, 'root').uri,
      readOnly: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    }
    await agentWorkspaceDatabase.upsertWorkspace(workspace)
    await new AppSandboxBackend(workspace).ensureReady()
    return workspace
  }

  /**
   * Register a directory selected through the platform picker. Android's
   * Storage Access Framework returns a content URI; iOS returns a
   * security-scoped, session-lifetime directory reference. The URI stays
   * behind this service and is never sent to the model.
   */
  async createPickedWorkspace(
    name: string,
    directory: { uri: string },
    kind: Extract<WorkspaceDescriptor['kind'], 'android_saf' | 'ios_session'>
  ): Promise<WorkspaceDescriptor> {
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName.length > 80) throw new Error('Workspace name must be 1-80 characters.')
    if (!directory?.uri) throw new Error('The selected folder did not return a usable directory reference.')

    const id = uuid()
    const now = Date.now()
    const workspace: WorkspaceDescriptor = {
      id,
      name: trimmedName,
      kind,
      rootUri: directory.uri,
      readOnly: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    }
    await agentWorkspaceDatabase.upsertWorkspace(workspace)
    await new AppSandboxBackend(workspace).ensureReady()
    return workspace
  }

  async listWorkspaces(): Promise<WorkspaceDescriptor[]> {
    await this.ensureDefaultWorkspace()
    return agentWorkspaceDatabase.getWorkspaces()
  }
}

export const workspaceService = WorkspaceService.getInstance()
export { DEFAULT_WORKSPACE_ID }
