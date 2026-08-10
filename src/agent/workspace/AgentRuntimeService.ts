import { agentRunDatabase, agentWorkspaceDatabase, fileDatabase } from '@database'
import { Directory, File, Paths } from 'expo-file-system'

import { loggerService } from '@/services/LoggerService'
import type { FileMetadata } from '@/types/file'
import type { Message } from '@/types/message'
import { uuid } from '@/utils'
import { findFileBlocks, findImageBlocks } from '@/utils/messageUtils/find'

import { AgentArtifactPublisher } from './AgentArtifactPublisher'
import { AgentInputBackend } from './AgentInputBackend'
import { AgentRuntimeBackend } from './AgentRuntimeBackend'
import { AppSandboxBackend } from './AppSandboxBackend'
import type { AgentRunStatus } from './runtimeTypes'
import type { WorkspaceBackend, WorkspaceDescriptor } from './types'
import { workspaceService } from './WorkspaceService'

const FAILED_RUN_RETENTION_MS = 24 * 60 * 60 * 1_000
const OPERATION_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const logger = loggerService.withContext('AgentRuntimeService')

function storageSegment(value: string): string {
  return encodeURIComponent(value).replaceAll('%', '_')
}

async function collectMessageFiles(message: Message): Promise<FileMetadata[]> {
  const [fileBlocks, imageBlocks] = await Promise.all([findFileBlocks(message), findImageBlocks(message)])
  const unique = new Map<string, FileMetadata>()
  fileBlocks.forEach(block => unique.set(block.file.id, block.file))
  imageBlocks.forEach(block => {
    if (block.file) unique.set(block.file.id, block.file)
  })
  return [...unique.values()]
}

function directorySize(directory: Directory): number {
  if (!directory.exists) return 0
  let size = 0
  for (const entry of directory.list()) {
    size += entry instanceof Directory ? directorySize(entry) : entry.size || 0
  }
  return size
}

export type AgentTopicCleanup = {
  topicId: string
  topicStorageKey: string
  artifactFileIds: string[]
}

export class AgentRuntimeSession {
  readonly publisher: AgentArtifactPublisher
  private finished = false

  constructor(
    readonly runId: string,
    readonly topicId: string,
    readonly backend: AgentRuntimeBackend,
    private readonly runRoot: Directory,
    assistantMessageId: string
  ) {
    this.publisher = new AgentArtifactPublisher(runId, assistantMessageId, backend)
  }

  publishFile(input: { path: string; displayName?: string; mimeType?: string }) {
    return this.publisher.publish(input)
  }

  publishPendingOutputs() {
    return this.publisher.publishPendingOutputs()
  }

  async finish(status: Exclude<AgentRunStatus, 'running' | 'interrupted'>, error?: string): Promise<void> {
    if (this.finished) return
    this.finished = true
    const now = Date.now()
    const byteUsage = directorySize(this.runRoot)
    const cleanupAfter = status === 'success' ? now : now + FAILED_RUN_RETENTION_MS

    try {
      await agentRunDatabase.updateRun(this.runId, {
        status,
        error: error ?? null,
        byteUsage,
        finishedAt: now,
        cleanupAfter
      })
    } catch (databaseError) {
      logger.warn('Unable to persist final Agent run status:', databaseError as Error)
    }

    if (status === 'success') {
      this.deleteRunCache()
      try {
        await agentRunDatabase.updateRun(this.runId, { cacheCleanedAt: Date.now() })
      } catch (databaseError) {
        logger.warn('Unable to mark Agent run cache as cleaned:', databaseError as Error)
      }
    }
  }

  private deleteRunCache(): void {
    try {
      if (this.runRoot.exists) this.runRoot.delete()
    } catch (error) {
      logger.warn('Unable to clean completed Agent run cache:', error as Error)
    }
  }
}

export class AgentRuntimeService {
  private static instance: AgentRuntimeService
  private initialization: Promise<void> | null = null

  static getInstance(): AgentRuntimeService {
    if (!AgentRuntimeService.instance) AgentRuntimeService.instance = new AgentRuntimeService()
    return AgentRuntimeService.instance
  }

  private constructor() {}

  async startRun(input: {
    topicId: string
    userMessage: Message
    assistantMessageId: string
    historyMessages?: Message[]
  }): Promise<AgentRuntimeSession> {
    await this.initialize()
    const runId = uuid()
    const now = Date.now()
    const topicKey = storageSegment(input.topicId)
    const runRoot = new Directory(Paths.cache, 'AgentRuntime', 'runs', runId)
    const topicRoot = new Directory(Paths.document, 'AgentRuntime', 'topics', topicKey)

    const currentFiles = await collectMessageFiles(input.userMessage)
    const inputGroups = [{ path: 'current', files: currentFiles }]
    for (const message of input.historyMessages ?? []) {
      if (message.id === input.userMessage.id) continue
      const files = await collectMessageFiles(message)
      if (files.length > 0) inputGroups.push({ path: `history/${storageSegment(message.id)}`, files })
    }

    const descriptor = (id: string, name: string, rootUri: string): WorkspaceDescriptor => ({
      id,
      name,
      kind: 'app_sandbox',
      rootUri,
      readOnly: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    })
    const state = new AppSandboxBackend(
      descriptor(`agent-state-${topicKey}`, 'Agent state', new Directory(topicRoot, 'state').uri),
      { stateRootUri: new Directory(topicRoot, 'control').uri, maxSnapshots: 20 }
    )
    const scratch = new AppSandboxBackend(
      descriptor(`agent-scratch-${runId}`, 'Agent scratch', new Directory(runRoot, 'scratch').uri),
      { stateRootUri: new Directory(runRoot, 'control', 'scratch').uri, maxSnapshots: 0 }
    )
    const outputs = new AppSandboxBackend(
      descriptor(`agent-outputs-${runId}`, 'Agent outputs', new Directory(runRoot, 'outputs').uri),
      { stateRootUri: new Directory(runRoot, 'control', 'outputs').uri, maxSnapshots: 0 }
    )
    const inputs = new AgentInputBackend(runId, inputGroups)

    let legacy: WorkspaceBackend | null = null
    try {
      legacy = await workspaceService.getLegacyBackendForTopic(input.topicId)
    } catch (error) {
      logger.warn('Legacy workspace could not be mounted read-only:', error as Error)
    }

    const backend = new AgentRuntimeBackend({ runId, inputs, state, scratch, outputs, legacy })
    try {
      await backend.ensureReady()
      await agentRunDatabase.createRun({
        id: runId,
        topicId: input.topicId,
        userMessageId: input.userMessage.id,
        assistantMessageId: input.assistantMessageId,
        status: 'running',
        error: null,
        byteUsage: 0,
        startedAt: now,
        finishedAt: null,
        cleanupAfter: null,
        cacheCleanedAt: null
      })
    } catch (error) {
      if (runRoot.exists) runRoot.delete()
      throw error
    }

    return new AgentRuntimeSession(runId, input.topicId, backend, runRoot, input.assistantMessageId)
  }

  async prepareTopicCleanup(topicId: string): Promise<AgentTopicCleanup> {
    const artifacts = await agentRunDatabase.getArtifactsForTopic(topicId)
    return {
      topicId,
      topicStorageKey: storageSegment(topicId),
      artifactFileIds: [...new Set(artifacts.map(artifact => artifact.fileId))]
    }
  }

  async cleanupTopicStorage(cleanup: AgentTopicCleanup): Promise<void> {
    const topicRoot = new Directory(Paths.document, 'AgentRuntime', 'topics', cleanup.topicStorageKey)
    if (topicRoot.exists) topicRoot.delete()

    for (const fileId of cleanup.artifactFileIds) {
      const metadata = await fileDatabase.getFileById(fileId)
      if (!metadata) continue
      const file = new File(metadata.path)
      await fileDatabase.deleteFileById(fileId)
      if (file.exists) file.delete()
    }
    await agentWorkspaceDatabase.deleteOperationsForTopic(cleanup.topicId).catch(() => undefined)
  }

  async clearAllStorage(): Promise<void> {
    for (const directory of [
      new Directory(Paths.cache, 'AgentRuntime'),
      new Directory(Paths.document, 'AgentRuntime'),
      new Directory(Paths.document, 'AgentArtifacts')
    ]) {
      if (directory.exists) directory.delete()
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialization) return this.initialization
    this.initialization = (async () => {
      const now = Date.now()
      await agentRunDatabase.interruptRunningRuns(now)
      await agentWorkspaceDatabase.pruneOperations(now - OPERATION_LOG_RETENTION_MS)
      const expired = await agentRunDatabase.getRunsDueForCleanup(now)
      for (const run of expired) {
        const runRoot = new Directory(Paths.cache, 'AgentRuntime', 'runs', run.id)
        try {
          if (runRoot.exists) runRoot.delete()
          await agentRunDatabase.updateRun(run.id, { cacheCleanedAt: Date.now() })
        } catch (error) {
          logger.warn(`Unable to clean expired Agent run ${run.id}:`, error as Error)
        }
      }
    })().catch(error => {
      this.initialization = null
      throw error
    })
    return this.initialization
  }
}

export const agentRuntimeService = AgentRuntimeService.getInstance()
