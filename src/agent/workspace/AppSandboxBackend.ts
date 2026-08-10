import { Directory, File, Paths } from 'expo-file-system'

import { loggerService } from '@/services/LoggerService'
import { uuid } from '@/utils'

import {
  assertWorkspacePathNotReserved,
  isHiddenWorkspaceName,
  normalizeWorkspacePath,
  splitWorkspacePath
} from './pathPolicy'
import type {
  FileMutationResult,
  ReadTextResult,
  SearchResult,
  WorkspaceBackend,
  WorkspaceDescriptor,
  WorkspaceEntry,
  WorkspaceListOptions,
  WorkspaceMutationContext,
  WorkspaceRevision,
  WorkspaceSearchOptions
} from './types'

const MAX_READ_BYTES = 50 * 1024
const MAX_READ_LINES = 2_000
const MAX_WRITE_BYTES = 1 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 1 * 1024 * 1024
const MAX_SEARCH_FILES = 10_000
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_RESULTS = 100
const logger = loggerService.withContext('AppSandboxBackend')

type TrashEntry = {
  sourcePath: string
  trashUri: string
  kind: 'file' | 'directory'
}

type ResolvedFileReference = {
  path: string
  name: string
  parent: Directory
  file: File | null
}

export type AppSandboxBackendOptions = {
  /**
   * Runtime workspaces keep snapshots and trash beside their own lifecycle
   * root. This prevents per-run scratch data from leaking into durable app
   * storage while preserving the legacy workspace default.
   */
  stateRootUri?: string
  /** Maximum reversible write snapshots retained for this backend. */
  maxSnapshots?: number
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function detectLineEnding(value: string): '\n' | '\r\n' {
  return value.includes('\r\n') ? '\r\n' : '\n'
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function applyExactEdits(content: string, edits: { oldText: string; newText: string }[]): string {
  if (edits.length === 0 || edits.length > 50) {
    throw new Error('edit requires between 1 and 50 replacements.')
  }

  const ranges = edits.map((edit, index) => {
    const oldText = normalizeLineEndings(edit.oldText)
    const newText = normalizeLineEndings(edit.newText)
    if (!oldText) throw new Error(`Edit ${index + 1} has an empty oldText.`)

    const first = content.indexOf(oldText)
    const last = content.lastIndexOf(oldText)
    if (first < 0) throw new Error(`Edit ${index + 1} did not match the file.`)
    if (first !== last) throw new Error(`Edit ${index + 1} matched more than once; include more context.`)

    return { start: first, end: first + oldText.length, newText }
  })

  ranges.sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index - 1].end > ranges[index].start) {
      throw new Error('Edits overlap; merge nearby replacements into one edit.')
    }
  }

  let result = content
  for (let index = ranges.length - 1; index >= 0; index--) {
    const range = ranges[index]
    result = result.slice(0, range.start) + range.newText + result.slice(range.end)
  }
  return result
}

function createUnifiedDiff(path: string, before: string, after: string): string {
  const beforeLines = normalizeLineEndings(before).split('\n')
  const afterLines = normalizeLineEndings(after).split('\n')
  if (before === after) return ''

  const lines: string[] = [`--- ${path}`, `+++ ${path}`]
  const max = Math.max(beforeLines.length, afterLines.length)
  for (let index = 0; index < max; index++) {
    const oldLine = beforeLines[index]
    const newLine = afterLines[index]
    if (oldLine === newLine) continue
    if (oldLine !== undefined) lines.push(`-${oldLine}`)
    if (newLine !== undefined) lines.push(`+${newLine}`)
  }
  return lines.join('\n')
}

function isFile(entry: File | Directory): entry is File {
  return entry instanceof File
}

/**
 * Persistent workspace rooted inside the app's private document directory.
 * This backend deliberately never exposes the app's general document root.
 */
export class AppSandboxBackend implements WorkspaceBackend {
  readonly descriptor: WorkspaceDescriptor
  get capabilities() {
    return {
      persistent: this.descriptor.kind !== 'ios_session',
      readOnly: this.descriptor.readOnly,
      supportsMove: true,
      supportsTrash: true
    } as const
  }

  private readonly root: Directory
  private readonly stateRoot: Directory
  private trashRoot: Directory
  private readonly trashManifestFile: File
  private readonly mutationQueue = new Map<string, Promise<void>>()
  private readonly trashEntries = new Map<string, TrashEntry>()
  private trashManifestLoaded = false
  private readonly maxSnapshots: number

  constructor(descriptor: WorkspaceDescriptor, options: AppSandboxBackendOptions = {}) {
    this.descriptor = descriptor
    this.root =
      descriptor.kind === 'app_sandbox'
        ? descriptor.rootUri
          ? new Directory(descriptor.rootUri)
          : new Directory(Paths.document, 'AgentWorkspaces', descriptor.id, 'root')
        : new Directory(descriptor.rootUri)
    this.stateRoot = options.stateRootUri
      ? new Directory(options.stateRootUri)
      : new Directory(Paths.document, 'AgentState', descriptor.id)
    this.maxSnapshots = Math.max(0, options.maxSnapshots ?? 50)
    // Keep external-folder trash on the same provider as the selected folder.
    // Android SAF providers commonly reject a copy from content:// into the
    // app-private file:// directory. The manifest remains private so the
    // hidden implementation directory never becomes model-visible metadata.
    this.trashRoot =
      descriptor.kind === 'app_sandbox'
        ? new Directory(this.stateRoot, 'trash')
        : new Directory(this.root, '.cherry-agent-trash')
    this.trashManifestFile = new File(this.stateRoot, 'trash', 'manifest.json')
  }

  async ensureReady(): Promise<void> {
    if (this.descriptor.kind === 'app_sandbox') {
      if (!this.root.exists) this.root.create({ intermediates: true, idempotent: true })
    } else if (!this.root.exists) {
      const accessMessage =
        this.descriptor.kind === 'ios_session'
          ? 'The selected iOS folder is no longer available. Pick it again to restore access.'
          : 'The selected folder is no longer available. Pick it again or choose the mobile workspace.'
      throw new Error(accessMessage)
    }
    if (this.descriptor.readOnly) return
    if (this.isSafWorkspace()) {
      const existingTrash = this.findChild(this.root, '.cherry-agent-trash')
      if (existingTrash) {
        if (isFile(existingTrash)) throw new Error('The workspace internal trash path is occupied by a file.')
        this.trashRoot = existingTrash
      } else {
        this.trashRoot = this.root.createDirectory('.cherry-agent-trash')
      }
    } else if (!this.trashRoot.exists) {
      this.trashRoot.create({ intermediates: true, idempotent: true })
    }
    if (!this.trashManifestLoaded) await this.loadTrashManifest()
  }

  async readText(path = '.', offset = 1, limit = MAX_READ_LINES): Promise<ReadTextResult> {
    await this.ensureReady()
    const normalized = this.filePath(path, false)
    const reference = await this.resolveFileReference(normalized)
    const file = reference.file
    if (!file) throw new Error(`File not found: ${normalized}`)
    this.assertFileExists(file, normalized)
    const raw = await file.text()
    const lines = normalizeLineEndings(raw).split('\n')
    const startLine = Math.max(1, Math.floor(offset || 1))
    const boundedLimit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(limit || MAX_READ_LINES)))
    const selected = lines.slice(startLine - 1, startLine - 1 + boundedLimit)
    let content = selected.join('\n')
    const bytes = byteLength(content)
    if (bytes > MAX_READ_BYTES) {
      const encoded = new TextEncoder().encode(content)
      content = new TextDecoder().decode(encoded.slice(0, MAX_READ_BYTES))
    }

    const endLine = Math.min(lines.length, startLine - 1 + selected.length)
    return {
      path: normalized,
      content,
      revision: this.revisionFor(file),
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: endLine < lines.length || bytes > MAX_READ_BYTES,
      size: file.size
    }
  }

  async writeText(
    path: string,
    content: string,
    expectedRevision?: string,
    context?: WorkspaceMutationContext
  ): Promise<FileMutationResult> {
    const normalized = this.filePath(path, false)
    this.assertWritable()
    if (byteLength(content) > MAX_WRITE_BYTES) throw new Error('write payload exceeds the 1 MiB limit.')

    return this.withMutation(normalized, async () => {
      await this.ensureReady()
      const reference = await this.resolveFileReference(normalized, true)
      let file = reference.file
      const beforeRevision = file ? this.revisionFor(file) : null
      this.assertExpectedRevision(expectedRevision, beforeRevision?.value)
      const operationId = uuid()
      const snapshotPath = file ? await this.snapshotFile(normalized, file, operationId) : undefined
      const before = file ? await file.text() : ''
      if (!file) file = this.createFileInDirectory(reference.parent, reference.name, 'text/plain')
      file.write(content)
      const result = {
        path: normalized,
        revision: this.revisionFor(file),
        bytesWritten: byteLength(content),
        operationId,
        diff: createUnifiedDiff(normalized, before, content),
        ...(snapshotPath ? { snapshotPath } : {})
      }
      await this.recordOperation('write', normalized, result, context, beforeRevision?.value)
      return result
    })
  }

  async editText(
    path: string,
    edits: { oldText: string; newText: string }[],
    expectedRevision?: string,
    context?: WorkspaceMutationContext
  ): Promise<FileMutationResult> {
    const normalized = this.filePath(path, false)
    this.assertWritable()

    return this.withMutation(normalized, async () => {
      await this.ensureReady()
      const reference = await this.resolveFileReference(normalized)
      const file = reference.file
      if (!file) throw new Error(`File not found: ${normalized}`)
      this.assertFileExists(file, normalized)
      const beforeRevision = this.revisionFor(file)
      this.assertExpectedRevision(expectedRevision, beforeRevision.value)
      const operationId = uuid()
      const beforeRaw = await file.text()
      const hasBom = beforeRaw.startsWith('\ufeff')
      const beforeWithoutBom = hasBom ? beforeRaw.slice(1) : beforeRaw
      const ending = detectLineEnding(beforeWithoutBom)
      const before = normalizeLineEndings(beforeWithoutBom)
      const afterNormalized = applyExactEdits(before, edits)
      const after = `${hasBom ? '\ufeff' : ''}${afterNormalized.replace(/\n/g, ending)}`
      if (byteLength(after) > MAX_WRITE_BYTES) throw new Error('edited file exceeds the 1 MiB limit.')
      const snapshotPath = await this.snapshotFile(normalized, file, operationId)
      file.write(after)
      const result = {
        path: normalized,
        revision: this.revisionFor(file),
        bytesWritten: byteLength(after),
        operationId,
        diff: createUnifiedDiff(normalized, beforeRaw, after),
        ...(snapshotPath ? { snapshotPath } : {})
      }
      await this.recordOperation('edit', normalized, result, context, beforeRevision.value)
      return result
    })
  }

  async list(options: WorkspaceListOptions = {}): Promise<WorkspaceEntry[]> {
    await this.ensureReady()
    const basePath = await this.directoryPath(options.path)
    const maxEntries = Math.max(1, Math.min(2_000, options.maxEntries ?? 500))
    const maxDepth = Math.max(0, Math.min(20, options.maxDepth ?? (options.recursive ? 5 : 0)))
    const includeHidden = options.includeHidden ?? false
    const result: WorkspaceEntry[] = []

    const visit = (directory: Directory, relativePath: string, depth: number) => {
      for (const entry of directory.list()) {
        if (result.length >= maxEntries) return
        if (!includeHidden && isHiddenWorkspaceName(entry.name)) continue
        const childPath = relativePath === '.' ? entry.name : `${relativePath}/${entry.name}`
        const entryIsFile = isFile(entry)
        result.push({
          path: childPath,
          name: entry.name,
          kind: entryIsFile ? 'file' : 'directory',
          ...(entryIsFile
            ? { size: entry.size ?? undefined, modificationTime: entry.modificationTime ?? null, mimeType: entry.type }
            : { size: entry.size ?? undefined, modificationTime: entry.info().modificationTime ?? null })
        })
        if (!entryIsFile && depth < maxDepth) visit(entry, childPath, depth + 1)
      }
    }

    visit(basePath, normalizeWorkspacePath(options.path), 0)
    return result
  }

  async stat(path = '.'): Promise<WorkspaceEntry & { exists: true }> {
    await this.ensureReady()
    const normalized = normalizeWorkspacePath(path)
    const entry = await this.entryFor(normalized)
    if (!entry || !entry.exists) throw new Error(`Path not found: ${normalized}`)
    const entryIsFile = isFile(entry)
    return {
      path: normalized,
      name: normalized === '.' ? this.descriptor.name : entry.name,
      kind: entryIsFile ? 'file' : 'directory',
      size: entryIsFile ? entry.size : (entry.size ?? undefined),
      modificationTime: entryIsFile ? entry.modificationTime : (entry.info().modificationTime ?? null),
      ...(entryIsFile ? { mimeType: entry.type } : {}),
      exists: true
    }
  }

  async search(query: string, options: WorkspaceSearchOptions = {}): Promise<SearchResult> {
    await this.ensureReady()
    if (!query) throw new Error('search requires a non-empty query.')
    if (query.length > 200) throw new Error('search query is limited to 200 characters.')
    const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, options.maxResults ?? MAX_SEARCH_RESULTS))
    const maxFileBytes = Math.max(1, Math.min(MAX_SEARCH_FILE_BYTES, options.maxFileBytes ?? MAX_SEARCH_FILE_BYTES))
    const files = await this.list({
      path: options.path,
      recursive: true,
      maxDepth: 20,
      maxEntries: MAX_SEARCH_FILES,
      includeHidden: options.includeHidden ?? false
    })
    let regex: RegExp | null = null
    if (options.mode === 'regex') {
      try {
        regex = new RegExp(query, 'g')
      } catch {
        throw new Error('search query is not a valid regular expression.')
      }
    }
    const matches: SearchResult['matches'] = []
    let scannedFiles = 0

    for (const entry of files) {
      if (entry.kind !== 'file' || (entry.size ?? 0) > maxFileBytes) continue
      scannedFiles++
      let text: string
      try {
        const file = (await this.resolveFileReference(entry.path)).file
        if (!file) continue
        text = normalizeLineEndings(await file.text())
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        if (regex) regex.lastIndex = 0
        const matched = regex ? regex.test(line) : line.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        if (!matched) continue
        matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 500) })
        if (matches.length >= maxResults) {
          return { query, matches, truncated: true, scannedFiles }
        }
      }
      if (scannedFiles % 50 === 0) await Promise.resolve()
    }

    return { query, matches, truncated: false, scannedFiles }
  }

  async mkdir(path: string, context?: WorkspaceMutationContext): Promise<{ path: string; operationId: string }> {
    const normalized = this.directoryPathName(path)
    this.assertWritable()
    return this.withMutation(normalized, async () => {
      await this.ensureReady()
      await this.resolveDirectory(normalized, true)
      const result = { path: normalized, operationId: uuid() }
      await this.recordOperation('mkdir', normalized, result, context)
      return result
    })
  }

  async copy(
    source: string,
    destination: string,
    context?: WorkspaceMutationContext
  ): Promise<{ source: string; destination: string; operationId: string }> {
    return this.copyOrMove(source, destination, false, context)
  }

  async move(
    source: string,
    destination: string,
    context?: WorkspaceMutationContext
  ): Promise<{ source: string; destination: string; operationId: string }> {
    return this.copyOrMove(source, destination, true, context)
  }

  async trash(
    path: string,
    context?: WorkspaceMutationContext
  ): Promise<{ path: string; trashPath: string; operationId: string }> {
    const normalized = this.filePath(path, false)
    this.assertWritable()
    if (normalized === '.') throw new Error('The workspace root cannot be trashed.')
    return this.withMutation(normalized, async () => {
      await this.ensureReady()
      const source = await this.entryFor(normalized)
      if (!source || !source.exists) throw new Error(`Path not found: ${normalized}`)
      const operationId = uuid()
      const trashDirectory = this.createDirectoryInDirectory(this.trashRoot, operationId)
      const trashTarget = this.isSafWorkspace()
        ? isFile(source)
          ? this.createFileInDirectory(trashDirectory, source.name, source.type ?? 'application/octet-stream')
          : this.createDirectoryInDirectory(trashDirectory, source.name)
        : isFile(source)
          ? new File(trashDirectory, source.name)
          : new Directory(trashDirectory, source.name)
      await this.relocate(source, trashTarget, true)
      const trashPath = `@trash/${operationId}/${source.name}`
      this.trashEntries.set(trashPath, {
        sourcePath: normalized,
        trashUri: trashTarget.uri,
        kind: isFile(source) ? 'file' : 'directory'
      })
      await this.persistTrashManifest()
      const result = { path: normalized, trashPath, operationId }
      await this.recordOperation('trash', normalized, result, context)
      return result
    })
  }

  async restore(
    trashPath: string,
    destination?: string,
    context?: WorkspaceMutationContext
  ): Promise<{ path: string; operationId: string }> {
    this.assertWritable()
    const entry = this.trashEntries.get(trashPath)
    if (!entry) throw new Error('Trash item is no longer available in this app session.')
    const targetPath = this.filePath(destination ?? entry.sourcePath, false)
    return this.withMutation(targetPath, async () => {
      const source = entry.kind === 'file' ? new File(entry.trashUri) : new Directory(entry.trashUri)
      if (!source.exists) throw new Error('Trash item no longer exists.')
      const parent = await this.ensureParentDirectory(targetPath)
      const targetName = splitWorkspacePath(targetPath, false).pop()!
      const existingTarget = this.findChild(parent, targetName)
      if (existingTarget) throw new Error(`Destination already exists: ${targetPath}`)
      const target = this.isSafWorkspace()
        ? entry.kind === 'file'
          ? this.createFileInDirectory(parent, targetName, 'application/octet-stream')
          : this.createDirectoryInDirectory(parent, targetName)
        : entry.kind === 'file'
          ? new File(parent, targetName)
          : new Directory(parent, targetName)
      await this.relocate(source, target, true)
      this.trashEntries.delete(trashPath)
      await this.persistTrashManifest()
      const result = { path: targetPath, operationId: uuid() }
      await this.recordOperation('restore', targetPath, result, context, undefined, trashPath)
      return result
    })
  }

  /**
   * Resolve a validated logical file to an internal File handle. Callers must
   * never put its URI in model-visible output; it exists for binary-safe input
   * mounting and artifact publication only.
   */
  async getFileHandle(path: string): Promise<File> {
    await this.ensureReady()
    const normalized = this.filePath(path, false)
    const reference = await this.resolveFileReference(normalized)
    if (!reference.file) throw new Error(`File not found: ${normalized}`)
    this.assertFileExists(reference.file, normalized)
    return reference.file
  }

  /** Binary-safe cross-mount import used by the private runtime router. */
  async copyFromFile(
    source: File,
    destination: string,
    context?: WorkspaceMutationContext
  ): Promise<{ source: string; destination: string; operationId: string }> {
    const normalized = this.filePath(destination, false)
    this.assertWritable()
    if (!source.exists) throw new Error('Source file no longer exists.')

    return this.withMutation(`import->${normalized}`, async () => {
      await this.ensureReady()
      const parent = await this.ensureParentDirectory(normalized)
      const destinationName = splitWorkspacePath(normalized, false).pop()!
      if (this.findChild(parent, destinationName)) {
        throw new Error(`Destination already exists: ${normalized}`)
      }
      const target = this.isSafWorkspace()
        ? this.createFileInDirectory(parent, destinationName, source.type ?? 'application/octet-stream')
        : new File(parent, destinationName)
      if (this.isSafWorkspace()) target.write(await source.bytes())
      else source.copy(target)

      const result = { source: '[internal-file]', destination: normalized, operationId: uuid() }
      await this.recordOperation('copy', normalized, result, context, undefined, normalized)
      return result
    })
  }

  private async copyOrMove(
    sourcePath: string,
    destinationPath: string,
    move: boolean,
    context?: WorkspaceMutationContext
  ) {
    const sourceNormalized = this.filePath(sourcePath, false)
    const destinationNormalized = this.filePath(destinationPath, false)
    this.assertWritable()
    const lockKey = `${sourceNormalized}->${destinationNormalized}`
    return this.withMutation(lockKey, async () => {
      await this.ensureReady()
      const source = await this.entryFor(sourceNormalized)
      if (!source || !source.exists) throw new Error(`Path not found: ${sourceNormalized}`)
      if (
        !isFile(source) &&
        (destinationNormalized === sourceNormalized || destinationNormalized.startsWith(`${sourceNormalized}/`))
      ) {
        throw new Error('A directory cannot be copied or moved into itself.')
      }
      const parent = await this.ensureParentDirectory(destinationNormalized)
      const destinationName = splitWorkspacePath(destinationNormalized, false).pop()!
      if (this.findChild(parent, destinationName)) {
        throw new Error(`Destination already exists: ${destinationNormalized}`)
      }
      const destination = this.isSafWorkspace()
        ? isFile(source)
          ? this.createFileInDirectory(parent, destinationName, source.type ?? 'application/octet-stream')
          : this.createDirectoryInDirectory(parent, destinationName)
        : isFile(source)
          ? new File(parent, destinationName)
          : new Directory(parent, destinationName)
      await this.relocate(source, destination, move)
      const result = { source: sourceNormalized, destination: destinationNormalized, operationId: uuid() }
      await this.recordOperation(
        move ? 'move' : 'copy',
        sourceNormalized,
        result,
        context,
        undefined,
        destinationNormalized
      )
      return result
    })
  }

  private filePath(path: string | undefined, allowRoot = true): string {
    const normalized = normalizeWorkspacePath(path, allowRoot)
    assertWorkspacePathNotReserved(normalized)
    return normalized
  }

  private async directoryPath(path: string | undefined): Promise<Directory> {
    const normalized = this.filePath(path)
    return this.resolveDirectory(normalized)
  }

  private directoryPathName(path: string | undefined): string {
    return this.filePath(path)
  }

  private directoryFor(path: string): Directory {
    const segments = splitWorkspacePath(path)
    return new Directory(this.root, ...segments)
  }

  private fileFor(path: string): File {
    const segments = splitWorkspacePath(path, false)
    return new File(this.root, ...segments)
  }

  private isSafWorkspace(): boolean {
    return this.descriptor.kind === 'android_saf'
  }

  private findChild(directory: Directory, name: string): File | Directory | undefined {
    return directory.list().find(entry => entry.name === name)
  }

  private async resolveDirectory(path: string, create = false): Promise<Directory> {
    const normalized = this.filePath(path)
    if (this.descriptor.kind === 'app_sandbox') {
      const directory = this.directoryFor(normalized)
      if (create && !directory.exists) directory.create({ intermediates: true, idempotent: true })
      return directory
    }

    let current = this.root
    for (const segment of splitWorkspacePath(normalized)) {
      const child = this.findChild(current, segment)
      if (child) {
        if (isFile(child)) throw new Error(`Path is a file: ${normalized}`)
        current = child
        continue
      }
      if (!create) throw new Error(`Path not found: ${normalized}`)
      current = current.createDirectory(segment)
    }
    return current
  }

  private async resolveFileReference(path: string, createParent = false): Promise<ResolvedFileReference> {
    const normalized = this.filePath(path, false)
    const segments = splitWorkspacePath(normalized, false)
    const name = segments.pop()!
    const parentPath = segments.length > 0 ? segments.join('/') : '.'
    const parent = await this.resolveDirectory(parentPath, createParent)

    if (this.descriptor.kind === 'app_sandbox') {
      const file = this.fileFor(normalized)
      if (file.exists && Paths.info(file.uri).isDirectory === true) {
        throw new Error(`Path is a directory: ${normalized}`)
      }
      return { path: normalized, name, parent, file: file.exists ? file : null }
    }

    const child = this.findChild(parent, name)
    if (child && !isFile(child)) throw new Error(`Path is a directory: ${normalized}`)
    return { path: normalized, name, parent, file: child && isFile(child) ? child : null }
  }

  private async entryFor(path: string): Promise<File | Directory | null> {
    if (path === '.') return this.root
    const normalized = this.filePath(path, false)
    if (this.descriptor.kind === 'app_sandbox') {
      const segments = splitWorkspacePath(normalized, false)
      const file = new File(this.root, ...segments)
      if (file.exists && Paths.info(file.uri).isDirectory !== true) return file
      const directory = new Directory(this.root, ...segments)
      return directory.exists ? directory : null
    }

    let current = this.root as File | Directory
    for (const segment of splitWorkspacePath(normalized, false)) {
      if (isFile(current)) return null
      const child = this.findChild(current, segment)
      if (!child) return null
      current = child
    }
    return current
  }

  private assertFileExists(file: File, path: string): void {
    if (!file.exists) throw new Error(`File not found: ${path}`)
    if (Paths.info(file.uri).isDirectory === true || file.type === 'inode/directory') {
      throw new Error(`Path is a directory: ${path}`)
    }
  }

  private assertWritable(): void {
    if (this.descriptor.readOnly) throw new Error('The active workspace is read-only.')
  }

  private assertExpectedRevision(expected: string | undefined, actual: string | undefined): void {
    if (expected !== undefined && expected !== actual) {
      throw new Error(`File changed since it was read. Expected revision ${expected}, got ${actual ?? 'missing'}.`)
    }
  }

  private revisionFor(file: File): WorkspaceRevision {
    if (!file.exists) throw new Error('Cannot calculate a revision for a missing file.')
    return {
      value: file.md5 ?? `${file.size}:${file.modificationTime ?? 0}`,
      size: file.size,
      modificationTime: file.modificationTime
    }
  }

  private async ensureParentDirectory(path: string): Promise<Directory> {
    const segments = splitWorkspacePath(path, false)
    segments.pop()
    const parentPath = segments.length > 0 ? segments.join('/') : '.'
    return this.resolveDirectory(parentPath, true)
  }

  private createFileInDirectory(parent: Directory, name: string, mimeType: string): File {
    if (this.descriptor.kind !== 'app_sandbox') return parent.createFile(name, mimeType)
    const file = new File(parent, name)
    file.create({ intermediates: true, overwrite: false })
    return file
  }

  private createDirectoryInDirectory(parent: Directory, name: string): Directory {
    if (this.descriptor.kind !== 'app_sandbox') return parent.createDirectory(name)
    const directory = new Directory(parent, name)
    directory.create({ intermediates: true, idempotent: true })
    return directory
  }

  private async snapshotFile(path: string, file: File, operationId: string): Promise<string | undefined> {
    if (this.maxSnapshots === 0 || !file.exists || file.size > MAX_SNAPSHOT_BYTES) return undefined
    const snapshotDirectory = new Directory(this.stateRoot, 'snapshots', operationId)
    snapshotDirectory.create({ intermediates: true, idempotent: true })
    const snapshotFile = new File(snapshotDirectory, path.replaceAll('/', '__'))
    try {
      if (this.isSafWorkspace()) snapshotFile.write(await file.bytes())
      else file.copy(snapshotFile)
      this.pruneSnapshots()
      return snapshotFile.uri
    } catch (error) {
      // Some SAF providers do not permit cross-provider copies. Snapshots are
      // a safety enhancement, so do not make the requested edit unusable.
      logger.warn('Unable to create an agent workspace snapshot:', error as Error)
      return undefined
    }
  }

  private pruneSnapshots(): void {
    const snapshotsRoot = new Directory(this.stateRoot, 'snapshots')
    if (!snapshotsRoot.exists) return
    const snapshots = snapshotsRoot
      .list()
      .filter((entry): entry is Directory => entry instanceof Directory)
      .sort((left, right) => (right.info().modificationTime ?? 0) - (left.info().modificationTime ?? 0))
    for (const snapshot of snapshots.slice(this.maxSnapshots)) snapshot.delete()
  }

  private async relocate(source: File | Directory, destination: File | Directory, move: boolean): Promise<void> {
    // Android SAF providers can reject a cross-provider rename. Copy/delete
    // gives external folders the same logical move semantics while retaining
    // the safer atomic rename for the private app sandbox.
    if (this.descriptor.kind !== 'app_sandbox') {
      await this.copyExternalEntry(source, destination)
      if (move) source.delete()
      return
    }
    if (move) source.move(destination)
    else source.copy(destination)
  }

  private async copyExternalEntry(source: File | Directory, destination: File | Directory): Promise<void> {
    if (isFile(source)) {
      if (!isFile(destination)) throw new Error('A file can only be copied to a file destination.')
      destination.write(await source.bytes())
      return
    }

    if (isFile(destination)) throw new Error('A directory cannot be copied to a file destination.')
    for (const child of source.list()) {
      const target = isFile(child)
        ? this.createFileInDirectory(destination, child.name, child.type ?? 'application/octet-stream')
        : this.createDirectoryInDirectory(destination, child.name)
      await this.copyExternalEntry(child, target)
    }
  }

  private async loadTrashManifest(): Promise<void> {
    this.trashManifestLoaded = true
    if (!this.trashManifestFile.exists) return
    try {
      const parsed = JSON.parse(await this.trashManifestFile.text()) as Record<string, Partial<TrashEntry>>
      for (const [trashPath, entry] of Object.entries(parsed)) {
        if (
          !trashPath.startsWith('@trash/') ||
          typeof entry.sourcePath !== 'string' ||
          typeof entry.trashUri !== 'string' ||
          (entry.kind !== 'file' && entry.kind !== 'directory')
        ) {
          continue
        }
        this.trashEntries.set(trashPath, {
          sourcePath: normalizeWorkspacePath(entry.sourcePath, false),
          trashUri: entry.trashUri,
          kind: entry.kind
        })
      }
    } catch (error) {
      logger.warn('Unable to load the agent trash manifest; starting with an empty restore list:', error as Error)
      this.trashEntries.clear()
    }
  }

  private async persistTrashManifest(): Promise<void> {
    try {
      if (!this.trashManifestFile.exists) this.trashManifestFile.create({ intermediates: true, overwrite: false })
      this.trashManifestFile.write(JSON.stringify(Object.fromEntries(this.trashEntries), null, 2))
    } catch (error) {
      logger.warn('Unable to persist the agent trash manifest:', error as Error)
    }
  }

  private async recordOperation(
    action: string,
    path: string,
    result: {
      operationId: string
      revision?: WorkspaceRevision
      bytesWritten?: number
      snapshotPath?: string
      trashPath?: string
    },
    context?: WorkspaceMutationContext,
    beforeRevision?: string,
    destination?: string
  ): Promise<void> {
    try {
      const { agentWorkspaceDatabase } = await import('@database')
      await agentWorkspaceDatabase.recordOperation({
        id: result.operationId,
        workspaceId: this.descriptor.id,
        topicId: context?.topicId,
        toolCallId: context?.toolCallId,
        action,
        path,
        destination: destination ?? result.trashPath,
        beforeRevision,
        afterRevision: result.revision?.value,
        status: 'success',
        approval: 'approved',
        bytesWritten: result.bytesWritten,
        snapshotUri: result.snapshotPath
      })
    } catch (error) {
      // Audit persistence must never turn a successful file operation into a
      // failed tool call (for example while an older database is migrating).
      logger.warn('Unable to persist agent workspace operation metadata:', error as Error)
    }
  }

  private async withMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const settled = current.then(
      () => undefined,
      () => undefined
    )
    this.mutationQueue.set(key, settled)
    try {
      return await current
    } finally {
      if (this.mutationQueue.get(key) === settled) this.mutationQueue.delete(key)
    }
  }
}
