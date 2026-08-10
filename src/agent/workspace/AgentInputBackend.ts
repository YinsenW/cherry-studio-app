import { File } from 'expo-file-system'

import type { FileMetadata } from '@/types/file'
import { FileTypes } from '@/types/file'

import {
  type AgentAttachment,
  buildMountedAttachments,
  type PublicAgentAttachment,
  publicAgentAttachment
} from '../attachments/AttachmentManifest'
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

const MAX_READ_BYTES = 50 * 1024
const MAX_READ_LINES = 2_000
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_RESULTS = 100
const FILE_CHUNK_BYTES = 64 * 1024
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.csv',
  '.tsv',
  '.xml',
  '.yaml',
  '.yml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.java',
  '.kt',
  '.swift',
  '.sql',
  '.log'
])

export type AgentInputGroup = {
  path: string
  files: FileMetadata[]
  messageId?: string
}

type MountedInput = {
  metadata: FileMetadata
  logicalPath: string
  attachment: AgentAttachment
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index).toLocaleLowerCase() : ''
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return value
  let truncated = new TextDecoder().decode(bytes.slice(0, Math.max(0, maxBytes)))
  while (byteLength(truncated) > maxBytes) truncated = truncated.slice(0, -1)
  return truncated
}

/**
 * Read-only virtual mount over message attachments. The original app-managed
 * files are referenced directly, so a run does not duplicate large uploads.
 */
export class AgentInputBackend implements WorkspaceBackend {
  readonly descriptor: WorkspaceDescriptor
  readonly capabilities = {
    persistent: false,
    readOnly: true,
    supportsMove: false,
    supportsTrash: false
  } as const

  private readonly files = new Map<string, MountedInput>()
  private readonly directories = new Set<string>(['.'])

  constructor(runId: string, groups: AgentInputGroup[]) {
    this.descriptor = {
      id: `agent-inputs-${runId}`,
      name: 'Agent inputs',
      kind: 'app_sandbox',
      rootUri: '',
      readOnly: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    for (const group of groups) {
      const groupPath = normalizeWorkspacePath(group.path)
      if (groupPath === '.') continue
      this.addDirectoryTree(groupPath)
      buildMountedAttachments(groupPath, group.files, group.messageId).forEach(attachment => {
        this.files.set(attachment.logicalPath, {
          metadata: attachment.metadata,
          logicalPath: attachment.logicalPath,
          attachment
        })
      })
    }
  }

  getAttachments(): PublicAgentAttachment[] {
    return [...this.files.values()].map(mounted => publicAgentAttachment(mounted.attachment))
  }

  getAttachment(path: string): PublicAgentAttachment {
    return publicAgentAttachment(this.requireMountedFile(path).attachment)
  }

  async ensureReady(): Promise<void> {
    // Message attachment metadata is already managed by FileService. Validate
    // individual files lazily so one missing historical file does not hide all
    // other inputs from the run.
  }

  async readText(path: string, offset = 1, limit = MAX_READ_LINES): Promise<ReadTextResult> {
    const mounted = this.requireMountedFile(path)
    const file = await this.getFileHandle(mounted.logicalPath)
    if (!this.isTextFile(mounted.metadata, file)) {
      throw new Error(`Binary attachment cannot be read as UTF-8 text: ${mounted.logicalPath}`)
    }

    const startLine = Math.max(1, Math.floor(offset || 1))
    const boundedLimit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(limit || MAX_READ_LINES)))
    const selected: string[] = []
    let currentSelectedLine = ''
    let storedBytes = 0
    let currentLine = 1
    let truncatedByBytes = false
    let pendingCarriageReturn = false

    const appendSelectedText = (value: string) => {
      if (truncatedByBytes || currentLine < startLine || currentLine >= startLine + boundedLimit || !value) {
        return
      }
      const separatorBytes = selected.length > 0 && currentSelectedLine.length === 0 ? 1 : 0
      const remaining = MAX_READ_BYTES - storedBytes - separatorBytes
      if (remaining <= 0) {
        truncatedByBytes = true
        return
      }
      const appended = truncateUtf8(value, remaining)
      currentSelectedLine += appended
      storedBytes += byteLength(appended) + separatorBytes
      if (appended.length < value.length) truncatedByBytes = true
    }

    const finishLine = () => {
      if (currentLine >= startLine && currentLine < startLine + boundedLimit && !truncatedByBytes) {
        selected.push(currentSelectedLine)
        currentSelectedLine = ''
      } else if (currentLine >= startLine && currentLine < startLine + boundedLimit && currentSelectedLine) {
        selected.push(currentSelectedLine)
        currentSelectedLine = ''
      }
      currentLine++
    }

    const consume = (decoded: string, final = false) => {
      let text = decoded
      if (pendingCarriageReturn) {
        if (text.startsWith('\n')) text = text.slice(1)
        finishLine()
        pendingCarriageReturn = false
      }
      if (!final && text.endsWith('\r')) {
        pendingCarriageReturn = true
        text = text.slice(0, -1)
      }

      let cursor = 0
      for (let index = 0; index < text.length; index++) {
        const character = text[index]
        if (character !== '\n' && character !== '\r') continue
        appendSelectedText(text.slice(cursor, index))
        if (character === '\r' && text[index + 1] === '\n') index++
        finishLine()
        cursor = index + 1
      }
      appendSelectedText(text.slice(cursor))
      if (final && pendingCarriageReturn) {
        finishLine()
        pendingCarriageReturn = false
      }
    }

    const decoder = new TextDecoder('utf-8')
    const handle = file.open()
    try {
      while ((handle.offset ?? 0) < (handle.size ?? file.size)) {
        const remaining = (handle.size ?? file.size) - (handle.offset ?? 0)
        const bytes = handle.readBytes(Math.min(FILE_CHUNK_BYTES, remaining))
        if (bytes.byteLength === 0) break
        consume(decoder.decode(bytes, { stream: true }))
      }
      consume(decoder.decode(), true)
    } finally {
      handle.close()
    }

    if (currentLine >= startLine && currentLine < startLine + boundedLimit) {
      selected.push(currentSelectedLine)
    }
    const totalLines = currentLine
    const joinedContent = selected.join('\n')
    const content = truncateUtf8(joinedContent, MAX_READ_BYTES)
    if (content.length < joinedContent.length) truncatedByBytes = true
    const endLine =
      selected.length > 0 ? Math.min(totalLines, startLine + selected.length - 1) : Math.min(totalLines, startLine)

    return {
      path: mounted.logicalPath,
      content,
      revision: {
        value: `${file.size}:${file.modificationTime ?? 0}`,
        size: file.size,
        modificationTime: file.modificationTime
      },
      startLine,
      endLine,
      totalLines,
      truncated: endLine < totalLines || truncatedByBytes,
      size: file.size
    }
  }

  async list(options: WorkspaceListOptions = {}): Promise<WorkspaceEntry[]> {
    const base = normalizeWorkspacePath(options.path)
    if (!this.directories.has(base)) throw new Error(`Path not found: ${base}`)
    const recursive = options.recursive ?? false
    const maxDepth = Math.max(0, Math.min(20, options.maxDepth ?? (recursive ? 5 : 0)))
    const maxEntries = Math.max(1, Math.min(2_000, options.maxEntries ?? 500))
    const entries: WorkspaceEntry[] = []

    const pushIfVisible = (entry: WorkspaceEntry) => {
      if (entries.length >= maxEntries) return
      const relative = base === '.' ? entry.path : entry.path.slice(base.length + 1)
      if (!relative || entry.path === base || entry.path.startsWith(`${base}/`) === false) return
      const depth = relative.split('/').length - 1
      if (depth > maxDepth) return
      if (!options.includeHidden && entry.name.startsWith('.')) return
      entries.push(entry)
    }

    for (const directory of this.directories) {
      if (directory === '.') continue
      pushIfVisible({
        path: directory,
        name: directory.split('/').pop()!,
        kind: 'directory'
      })
    }
    for (const mounted of this.files.values()) {
      const file = new File(mounted.metadata.path)
      pushIfVisible({
        path: mounted.logicalPath,
        name: mounted.logicalPath.split('/').pop()!,
        kind: 'file',
        size: mounted.metadata.size,
        modificationTime: file.exists ? file.modificationTime : null,
        mimeType: file.exists ? file.type : undefined
      })
    }

    return entries.sort((left, right) => left.path.localeCompare(right.path)).slice(0, maxEntries)
  }

  async stat(path = '.'): Promise<WorkspaceEntry & { exists: true }> {
    const normalized = normalizeWorkspacePath(path)
    if (this.directories.has(normalized)) {
      return {
        path: normalized,
        name: normalized === '.' ? this.descriptor.name : normalized.split('/').pop()!,
        kind: 'directory',
        exists: true
      }
    }

    const file = await this.getFileHandle(normalized)
    return {
      path: normalized,
      name: normalized.split('/').pop()!,
      kind: 'file',
      size: file.size,
      modificationTime: file.modificationTime,
      mimeType: file.type,
      exists: true
    }
  }

  async search(query: string, options: WorkspaceSearchOptions = {}): Promise<SearchResult> {
    if (!query) throw new Error('search requires a non-empty query.')
    if (query.length > 200) throw new Error('search query is limited to 200 characters.')
    const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, options.maxResults ?? MAX_SEARCH_RESULTS))
    const maxFileBytes = Math.max(1, Math.min(MAX_SEARCH_FILE_BYTES, options.maxFileBytes ?? MAX_SEARCH_FILE_BYTES))
    let regex: RegExp | null = null
    if (options.mode === 'regex') {
      try {
        regex = new RegExp(query, 'g')
      } catch {
        throw new Error('search query is not a valid regular expression.')
      }
    }

    const files = await this.list({
      path: options.path,
      recursive: true,
      maxDepth: 20,
      maxEntries: 10_000,
      includeHidden: options.includeHidden
    })
    const matches: SearchResult['matches'] = []
    let scannedFiles = 0

    for (const entry of files) {
      if (entry.kind !== 'file' || (entry.size ?? 0) > maxFileBytes) continue
      const mounted = this.files.get(entry.path)
      if (!mounted) continue
      const file = new File(mounted.metadata.path)
      if (!file.exists || !this.isTextFile(mounted.metadata, file)) continue
      scannedFiles++
      const lines = normalizeText(await file.text()).split('\n')
      for (let index = 0; index < lines.length; index++) {
        if (regex) regex.lastIndex = 0
        const matched = regex
          ? regex.test(lines[index])
          : lines[index].toLocaleLowerCase().includes(query.toLocaleLowerCase())
        if (!matched) continue
        matches.push({ path: entry.path, line: index + 1, text: lines[index].slice(0, 500) })
        if (matches.length >= maxResults) return { query, matches, truncated: true, scannedFiles }
      }
    }

    return { query, matches, truncated: false, scannedFiles }
  }

  async getFileHandle(path: string): Promise<File> {
    const mounted = this.requireMountedFile(path)
    const file = new File(mounted.metadata.path)
    if (!file.exists) throw new Error(`Attachment is no longer available: ${mounted.logicalPath}`)
    return file
  }

  async writeText(
    _path: string,
    _content: string,
    _expectedRevision?: string,
    _context?: WorkspaceMutationContext
  ): Promise<FileMutationResult> {
    return this.readOnlyError()
  }

  async editText(): Promise<FileMutationResult> {
    return this.readOnlyError()
  }

  async mkdir(): Promise<{ path: string; operationId: string }> {
    return this.readOnlyError()
  }

  async copy(): Promise<{ source: string; destination: string; operationId: string }> {
    return this.readOnlyError()
  }

  async move(): Promise<{ source: string; destination: string; operationId: string }> {
    return this.readOnlyError()
  }

  async trash(): Promise<{ path: string; trashPath: string; operationId: string }> {
    return this.readOnlyError()
  }

  async restore(): Promise<{ path: string; operationId: string }> {
    return this.readOnlyError()
  }

  private addDirectoryTree(path: string): void {
    const segments = path.split('/')
    for (let index = 1; index <= segments.length; index++) {
      this.directories.add(segments.slice(0, index).join('/'))
    }
  }

  private requireMountedFile(path: string): MountedInput {
    const normalized = normalizeWorkspacePath(path, false)
    const mounted = this.files.get(normalized)
    if (!mounted) {
      if (this.directories.has(normalized)) throw new Error(`Path is a directory: ${normalized}`)
      throw new Error(`File not found: ${normalized}`)
    }
    return mounted
  }

  private isTextFile(metadata: FileMetadata, file: File): boolean {
    return (
      metadata.type === FileTypes.TEXT ||
      file.type?.startsWith('text/') === true ||
      TEXT_EXTENSIONS.has(extensionOf(metadata.origin_name || metadata.name))
    )
  }

  private readOnlyError(): never {
    throw new Error('Input attachments are read-only. Copy a file to state, scratch or outputs before changing it.')
  }
}
