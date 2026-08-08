export type WorkspaceKind = 'app_sandbox' | 'android_saf' | 'ios_session'

export type WorkspaceAction =
  | 'pwd'
  | 'list'
  | 'tree'
  | 'stat'
  | 'search'
  | 'mkdir'
  | 'copy'
  | 'move'
  | 'trash'
  | 'restore'

export type WorkspaceEntryKind = 'file' | 'directory'

export type WorkspaceEntry = {
  path: string
  name: string
  kind: WorkspaceEntryKind
  size?: number
  modificationTime?: number | null
  mimeType?: string
}

export type WorkspaceRevision = {
  value: string
  size: number
  modificationTime: number | null
}

export type ReadTextResult = {
  path: string
  content: string
  revision: WorkspaceRevision
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
  size: number
}

export type FileMutationResult = {
  path: string
  revision: WorkspaceRevision
  bytesWritten: number
  operationId: string
  diff?: string
  snapshotPath?: string
}

export type SearchMatch = {
  path: string
  line: number
  text: string
}

export type SearchResult = {
  query: string
  matches: SearchMatch[]
  truncated: boolean
  scannedFiles: number
}

export type WorkspaceBackendCapabilities = {
  persistent: boolean
  readOnly: boolean
  supportsMove: boolean
  supportsTrash: boolean
}

export type WorkspaceDescriptor = {
  id: string
  name: string
  kind: WorkspaceKind
  rootUri: string
  readOnly: boolean
  createdAt: number
  updatedAt: number
  lastUsedAt?: number | null
}

export type WorkspaceMutationContext = {
  topicId?: string
  toolCallId?: string
}

export type WorkspaceListOptions = {
  path?: string
  recursive?: boolean
  maxDepth?: number
  maxEntries?: number
  includeHidden?: boolean
}

export type WorkspaceSearchOptions = {
  path?: string
  mode?: 'literal' | 'regex'
  maxResults?: number
  includeHidden?: boolean
  maxFileBytes?: number
}

export type WorkspaceBackend = {
  descriptor: WorkspaceDescriptor
  capabilities: WorkspaceBackendCapabilities
  ensureReady(): Promise<void>
  readText(path: string, offset?: number, limit?: number): Promise<ReadTextResult>
  writeText(
    path: string,
    content: string,
    expectedRevision?: string,
    context?: WorkspaceMutationContext
  ): Promise<FileMutationResult>
  editText(
    path: string,
    edits: { oldText: string; newText: string }[],
    expectedRevision?: string,
    context?: WorkspaceMutationContext
  ): Promise<FileMutationResult>
  list(options?: WorkspaceListOptions): Promise<WorkspaceEntry[]>
  stat(path?: string): Promise<WorkspaceEntry & { exists: true }>
  search(query: string, options?: WorkspaceSearchOptions): Promise<SearchResult>
  mkdir(path: string, context?: WorkspaceMutationContext): Promise<{ path: string; operationId: string }>
  copy(
    source: string,
    destination: string,
    context?: WorkspaceMutationContext
  ): Promise<{ source: string; destination: string; operationId: string }>
  move(
    source: string,
    destination: string,
    context?: WorkspaceMutationContext
  ): Promise<{ source: string; destination: string; operationId: string }>
  trash(
    path: string,
    context?: WorkspaceMutationContext
  ): Promise<{ path: string; trashPath: string; operationId: string }>
  restore(
    trashPath: string,
    destination?: string,
    context?: WorkspaceMutationContext
  ): Promise<{ path: string; operationId: string }>
}
