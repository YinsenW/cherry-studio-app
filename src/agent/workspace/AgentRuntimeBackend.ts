import type { File } from 'expo-file-system'

import type { PublicAgentAttachment } from '../attachments/AttachmentManifest'
import type { AgentInputBackend } from './AgentInputBackend'
import { AppSandboxBackend } from './AppSandboxBackend'
import { normalizeWorkspacePath } from './pathPolicy'
import type {
  FileMutationResult,
  ReadTextResult,
  SearchResult,
  WorkspaceBackend,
  WorkspaceDescriptor,
  WorkspaceEntry,
  WorkspaceListOptions,
  WorkspaceMutationContext,
  WorkspaceSearchOptions
} from './types'

export type AgentRuntimeMountName = 'inputs' | 'state' | 'scratch' | 'outputs' | 'legacy'

type RuntimeMount = {
  backend: WorkspaceBackend
  writable: boolean
  quotaBytes?: number
}

type RoutedPath = {
  mountName: AgentRuntimeMountName
  mount: RuntimeMount
  path: string
}

type AgentRuntimeBackendOptions = {
  runId: string
  inputs: AgentInputBackend
  state: AppSandboxBackend
  scratch: AppSandboxBackend
  outputs: AppSandboxBackend
  legacy?: WorkspaceBackend | null
  stateQuotaBytes?: number
  scratchQuotaBytes?: number
  outputsQuotaBytes?: number
}

const DEFAULT_STATE_QUOTA = 128 * 1024 * 1024
const DEFAULT_SCRATCH_QUOTA = 64 * 1024 * 1024
const DEFAULT_OUTPUTS_QUOTA = 128 * 1024 * 1024
const MAX_EDIT_GROWTH_RESERVATION = 1 * 1024 * 1024

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function supportsFileHandle(
  backend: WorkspaceBackend
): backend is WorkspaceBackend & { getFileHandle(path: string): Promise<File> } {
  return typeof (backend as { getFileHandle?: unknown }).getFileHandle === 'function'
}

/**
 * Logical router for the four private runtime mounts. Bare paths resolve to
 * durable state for compatibility with agents that naturally write plan.md;
 * all tool results use explicit mount-prefixed paths.
 */
export class AgentRuntimeBackend implements WorkspaceBackend {
  readonly descriptor: WorkspaceDescriptor
  readonly capabilities = {
    persistent: true,
    readOnly: false,
    supportsMove: true,
    supportsTrash: true
  } as const

  private readonly mounts = new Map<AgentRuntimeMountName, RuntimeMount>()
  private readonly trashRoutes = new Map<string, { mountName: AgentRuntimeMountName; trashPath: string }>()

  constructor(options: AgentRuntimeBackendOptions) {
    const now = Date.now()
    this.descriptor = {
      id: `agent-run-${options.runId}`,
      name: 'Agent private runtime',
      kind: 'app_sandbox',
      rootUri: '',
      readOnly: false,
      createdAt: now,
      updatedAt: now
    }
    this.mounts.set('inputs', { backend: options.inputs, writable: false })
    this.mounts.set('state', {
      backend: options.state,
      writable: true,
      quotaBytes: options.stateQuotaBytes ?? DEFAULT_STATE_QUOTA
    })
    this.mounts.set('scratch', {
      backend: options.scratch,
      writable: true,
      quotaBytes: options.scratchQuotaBytes ?? DEFAULT_SCRATCH_QUOTA
    })
    this.mounts.set('outputs', {
      backend: options.outputs,
      writable: true,
      quotaBytes: options.outputsQuotaBytes ?? DEFAULT_OUTPUTS_QUOTA
    })
    if (options.legacy) this.mounts.set('legacy', { backend: options.legacy, writable: false })
  }

  async ensureReady(): Promise<void> {
    await Promise.all([...this.mounts.values()].map(mount => mount.backend.ensureReady()))
  }

  async readText(path: string, offset?: number, limit?: number): Promise<ReadTextResult> {
    const routed = this.route(path, false)
    const result = await routed.mount.backend.readText(routed.path, offset, limit)
    return { ...result, path: this.logicalPath(routed.mountName, result.path) }
  }

  async writeText(
    path: string,
    content: string,
    expectedRevision?: string,
    context?: WorkspaceMutationContext
  ): Promise<FileMutationResult> {
    const routed = this.route(path, false)
    this.assertWritable(routed)
    await this.assertQuota(routed, byteLength(content), true)
    const result = await routed.mount.backend.writeText(routed.path, content, expectedRevision, context)
    return { ...result, path: this.logicalPath(routed.mountName, result.path) }
  }

  async editText(
    path: string,
    edits: { oldText: string; newText: string }[],
    expectedRevision?: string,
    context?: WorkspaceMutationContext
  ): Promise<FileMutationResult> {
    const routed = this.route(path, false)
    this.assertWritable(routed)
    await this.assertQuota(routed, MAX_EDIT_GROWTH_RESERVATION, false)
    const result = await routed.mount.backend.editText(routed.path, edits, expectedRevision, context)
    return { ...result, path: this.logicalPath(routed.mountName, result.path) }
  }

  async list(options: WorkspaceListOptions = {}): Promise<WorkspaceEntry[]> {
    const normalized = normalizeWorkspacePath(options.path)
    const maxEntries = Math.max(1, Math.min(2_000, options.maxEntries ?? 500))
    const recursive = options.recursive ?? false
    const maxDepth = Math.max(0, Math.min(20, options.maxDepth ?? (recursive ? 5 : 0)))

    if (normalized !== '.') {
      const routed = this.route(normalized)
      if (routed.path === '.') {
        const rootEntry: WorkspaceEntry = {
          path: routed.mountName,
          name: routed.mountName,
          kind: 'directory'
        }
        if (!recursive && maxDepth === 0) {
          const children = await routed.mount.backend.list({ ...options, path: '.', maxEntries })
          return children.map(entry => this.mapEntry(routed.mountName, entry)).slice(0, maxEntries)
        }
        const children = await routed.mount.backend.list({ ...options, path: '.', maxEntries, maxDepth })
        return [rootEntry, ...children.map(entry => this.mapEntry(routed.mountName, entry))].slice(0, maxEntries)
      }
      const entries = await routed.mount.backend.list({ ...options, path: routed.path, maxEntries, maxDepth })
      return entries.map(entry => this.mapEntry(routed.mountName, entry)).slice(0, maxEntries)
    }

    const results: WorkspaceEntry[] = []
    for (const [mountName, mount] of this.mounts) {
      if (results.length >= maxEntries) break
      results.push({ path: mountName, name: mountName, kind: 'directory' })
      if (!recursive || maxDepth === 0) continue
      const children = await mount.backend.list({
        ...options,
        path: '.',
        recursive: true,
        maxDepth: Math.max(0, maxDepth - 1),
        maxEntries: maxEntries - results.length
      })
      results.push(...children.map(entry => this.mapEntry(mountName, entry)))
    }
    return results.slice(0, maxEntries)
  }

  async stat(path = '.'): Promise<WorkspaceEntry & { exists: true }> {
    const normalized = normalizeWorkspacePath(path)
    if (normalized === '.') {
      return { path: '.', name: this.descriptor.name, kind: 'directory', exists: true }
    }
    const routed = this.route(normalized)
    if (routed.path === '.') {
      return { path: routed.mountName, name: routed.mountName, kind: 'directory', exists: true }
    }
    return this.mapEntry(routed.mountName, await routed.mount.backend.stat(routed.path)) as WorkspaceEntry & {
      exists: true
    }
  }

  async search(query: string, options: WorkspaceSearchOptions = {}): Promise<SearchResult> {
    const normalized = normalizeWorkspacePath(options.path)
    const maxResults = Math.max(1, Math.min(100, options.maxResults ?? 100))
    if (normalized !== '.') {
      const routed = this.route(normalized)
      const result = await routed.mount.backend.search(query, {
        ...options,
        path: routed.path,
        maxResults
      })
      return {
        ...result,
        matches: result.matches.map(match => ({
          ...match,
          path: this.logicalPath(routed.mountName, match.path)
        }))
      }
    }

    const matches: SearchResult['matches'] = []
    let scannedFiles = 0
    let truncated = false
    for (const [mountName, mount] of this.mounts) {
      if (matches.length >= maxResults) {
        truncated = true
        break
      }
      const result = await mount.backend.search(query, {
        ...options,
        path: '.',
        maxResults: maxResults - matches.length
      })
      scannedFiles += result.scannedFiles
      truncated ||= result.truncated
      matches.push(...result.matches.map(match => ({ ...match, path: this.logicalPath(mountName, match.path) })))
    }
    return { query, matches: matches.slice(0, maxResults), scannedFiles, truncated }
  }

  async mkdir(path: string, context?: WorkspaceMutationContext): Promise<{ path: string; operationId: string }> {
    const routed = this.route(path, false)
    this.assertWritable(routed)
    const result = await routed.mount.backend.mkdir(routed.path, context)
    return { ...result, path: this.logicalPath(routed.mountName, result.path) }
  }

  async copy(
    source: string,
    destination: string,
    context?: WorkspaceMutationContext
  ): Promise<{ source: string; destination: string; operationId: string }> {
    const sourceRoute = this.route(source, false)
    const destinationRoute = this.route(destination, false)
    this.assertWritable(destinationRoute)
    const sourceStat = await sourceRoute.mount.backend.stat(sourceRoute.path)
    if (sourceStat.kind !== 'file') throw new Error('Cross-mount directory copies are not supported on mobile.')
    await this.assertQuota(destinationRoute, sourceStat.size ?? 0, true)

    if (sourceRoute.mountName === destinationRoute.mountName) {
      const result = await sourceRoute.mount.backend.copy(sourceRoute.path, destinationRoute.path, context)
      return {
        ...result,
        source: this.logicalPath(sourceRoute.mountName, result.source),
        destination: this.logicalPath(destinationRoute.mountName, result.destination)
      }
    }

    if (
      !supportsFileHandle(sourceRoute.mount.backend) ||
      !(destinationRoute.mount.backend instanceof AppSandboxBackend)
    ) {
      throw new Error('This file cannot be copied between the selected mobile mounts.')
    }
    const sourceFile = await sourceRoute.mount.backend.getFileHandle(sourceRoute.path)
    const result = await destinationRoute.mount.backend.copyFromFile(sourceFile, destinationRoute.path, context)
    return {
      ...result,
      source: this.logicalPath(sourceRoute.mountName, sourceRoute.path),
      destination: this.logicalPath(destinationRoute.mountName, destinationRoute.path)
    }
  }

  async move(
    source: string,
    destination: string,
    context?: WorkspaceMutationContext
  ): Promise<{ source: string; destination: string; operationId: string }> {
    const sourceRoute = this.route(source, false)
    const destinationRoute = this.route(destination, false)
    this.assertWritable(sourceRoute)
    this.assertWritable(destinationRoute)
    if (sourceRoute.mountName !== destinationRoute.mountName) {
      throw new Error('Move is limited to one mount. Copy the file, then trash the source.')
    }
    const result = await sourceRoute.mount.backend.move(sourceRoute.path, destinationRoute.path, context)
    return {
      ...result,
      source: this.logicalPath(sourceRoute.mountName, result.source),
      destination: this.logicalPath(destinationRoute.mountName, result.destination)
    }
  }

  async trash(
    path: string,
    context?: WorkspaceMutationContext
  ): Promise<{ path: string; trashPath: string; operationId: string }> {
    const routed = this.route(path, false)
    this.assertWritable(routed)
    const result = await routed.mount.backend.trash(routed.path, context)
    const trashPath = `@trash/${routed.mountName}/${result.operationId}`
    this.trashRoutes.set(trashPath, { mountName: routed.mountName, trashPath: result.trashPath })
    return { ...result, path: this.logicalPath(routed.mountName, result.path), trashPath }
  }

  async restore(
    trashPath: string,
    destination?: string,
    context?: WorkspaceMutationContext
  ): Promise<{ path: string; operationId: string }> {
    const route = this.trashRoutes.get(trashPath)
    if (!route) throw new Error('Trash item is no longer available in this agent run.')
    const mount = this.mounts.get(route.mountName)!
    if (!mount.writable) throw new Error(`${route.mountName} is read-only.`)
    const destinationRoute = destination ? this.route(destination, false) : null
    if (destinationRoute && destinationRoute.mountName !== route.mountName) {
      throw new Error('A trashed item can only be restored to its original mount.')
    }
    const result = await mount.backend.restore(route.trashPath, destinationRoute?.path, context)
    this.trashRoutes.delete(trashPath)
    return { ...result, path: this.logicalPath(route.mountName, result.path) }
  }

  async getOutputFile(path: string): Promise<{ path: string; file: File }> {
    const routed = this.route(path, false)
    if (routed.mountName !== 'outputs') {
      throw new Error('Only files under outputs can be published to the conversation.')
    }
    if (!supportsFileHandle(routed.mount.backend)) throw new Error('Output file is not locally accessible.')
    return {
      path: this.logicalPath('outputs', routed.path),
      file: await routed.mount.backend.getFileHandle(routed.path)
    }
  }

  async getInputAttachment(path: string): Promise<{ attachment: PublicAgentAttachment; file: File }> {
    const routed = this.route(path, false)
    if (routed.mountName !== 'inputs') {
      throw new Error('Attachment analysis tools only accept paths under inputs.')
    }
    const inputBackend = routed.mount.backend as AgentInputBackend
    const attachment = inputBackend.getAttachment(routed.path)
    return {
      attachment: { ...attachment, logicalPath: this.logicalPath('inputs', attachment.logicalPath) },
      file: await inputBackend.getFileHandle(routed.path)
    }
  }

  async listOutputFiles(): Promise<string[]> {
    const outputs = this.mounts.get('outputs')!
    const entries = await outputs.backend.list({ path: '.', recursive: true, maxDepth: 20, maxEntries: 2_000 })
    return entries
      .filter(entry => entry.kind === 'file')
      .map(entry => this.logicalPath('outputs', entry.path))
      .sort()
  }

  private route(path: string | undefined, allowRoot = true): RoutedPath {
    const normalized = normalizeWorkspacePath(path, allowRoot)
    if (normalized === '.') throw new Error('Choose a file or directory inside a runtime mount.')
    const segments = normalized.split('/')
    const requestedMount = segments[0] as AgentRuntimeMountName
    const mount = this.mounts.get(requestedMount)
    if (mount) {
      return {
        mountName: requestedMount,
        mount,
        path: segments.length === 1 ? '.' : segments.slice(1).join('/')
      }
    }

    return { mountName: 'state', mount: this.mounts.get('state')!, path: normalized }
  }

  private logicalPath(mountName: AgentRuntimeMountName, path: string): string {
    return path === '.' ? mountName : `${mountName}/${path}`
  }

  private mapEntry(mountName: AgentRuntimeMountName, entry: WorkspaceEntry): WorkspaceEntry {
    return { ...entry, path: this.logicalPath(mountName, entry.path) }
  }

  private assertWritable(routed: RoutedPath): void {
    if (!routed.mount.writable) {
      const explanation =
        routed.mountName === 'inputs'
          ? 'Input attachments are read-only. Copy the file before changing it.'
          : `${routed.mountName} is a read-only compatibility mount.`
      throw new Error(explanation)
    }
  }

  private async assertQuota(routed: RoutedPath, requestedBytes: number, replaceExisting: boolean): Promise<void> {
    const quota = routed.mount.quotaBytes
    if (!quota) return
    const entries = await routed.mount.backend.list({ path: '.', recursive: true, maxDepth: 20, maxEntries: 2_000 })
    let currentBytes = entries.reduce((total, entry) => total + (entry.kind === 'file' ? (entry.size ?? 0) : 0), 0)
    if (replaceExisting) {
      try {
        const existing = await routed.mount.backend.stat(routed.path)
        if (existing.kind === 'file') currentBytes -= existing.size ?? 0
      } catch {
        // A missing destination contributes no existing bytes.
      }
    }
    if (currentBytes + requestedBytes > quota) {
      throw new Error(`${routed.mountName} storage quota exceeded (${Math.floor(quota / 1024 / 1024)} MiB).`)
    }
  }
}
