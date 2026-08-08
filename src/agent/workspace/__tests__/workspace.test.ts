import { createMobileWorkspaceTools } from '../mobileWorkspaceTools'
import { normalizeWorkspacePath } from '../pathPolicy'
import type { WorkspaceBackend } from '../types'

const backend = {
  descriptor: {
    id: 'workspace-test',
    name: 'Test workspace',
    kind: 'app_sandbox',
    rootUri: 'file:///private/not-for-model',
    readOnly: false,
    createdAt: 1,
    updatedAt: 1
  },
  capabilities: {
    persistent: true,
    readOnly: false,
    supportsMove: true,
    supportsTrash: true
  },
  ensureReady: jest.fn(async () => undefined),
  readText: jest.fn(async () => ({
    path: 'notes/today.md',
    content: 'hello',
    revision: { value: 'rev-1', size: 5, modificationTime: null },
    startLine: 1,
    endLine: 1,
    totalLines: 1,
    truncated: false,
    size: 5
  })),
  writeText: jest.fn(async () => ({
    path: 'notes/today.md',
    revision: { value: 'rev-2', size: 6, modificationTime: null },
    bytesWritten: 6,
    operationId: 'op-write',
    snapshotPath: 'file:///private/should-not-leak'
  })),
  editText: jest.fn(async () => ({
    path: 'notes/today.md',
    revision: { value: 'rev-3', size: 7, modificationTime: null },
    bytesWritten: 7,
    operationId: 'op-edit',
    snapshotPath: 'file:///private/should-not-leak'
  })),
  list: jest.fn(async () => []),
  stat: jest.fn(),
  search: jest.fn(),
  mkdir: jest.fn(),
  copy: jest.fn(),
  move: jest.fn(),
  trash: jest.fn(),
  restore: jest.fn()
} as unknown as WorkspaceBackend

describe('mobile agent workspace contract', () => {
  beforeEach(() => jest.clearAllMocks())

  it('normalizes relative paths and rejects URI or traversal escapes', () => {
    expect(normalizeWorkspacePath('./notes\\today.md')).toBe('notes/today.md')
    expect(normalizeWorkspacePath('a//b/./c')).toBe('a/b/c')
    expect(() => normalizeWorkspacePath('../outside')).toThrow('traversal')
    expect(() => normalizeWorkspacePath('/absolute/path')).toThrow('relative')
    expect(() => normalizeWorkspacePath('file:///private/path')).toThrow('relative')
    expect(() => normalizeWorkspacePath('.')).not.toThrow()
    expect(() => normalizeWorkspacePath('.', false)).toThrow('file path')
  })

  it('keeps native snapshot URIs out of model-visible mutation results', async () => {
    const [read, write, edit, workspace] = createMobileWorkspaceTools(backend, { topicId: 'topic-test' })

    const readResult = await read.execute('read-call', { path: 'notes/today.md' })
    expect(backend.readText).toHaveBeenCalledWith('notes/today.md', undefined, undefined)
    expect(readResult.content[0]).toMatchObject({ type: 'text', text: 'hello' })

    const writeResult = await write.execute('write-call', {
      path: 'notes/today.md',
      content: 'updated',
      expectedRevision: 'rev-1'
    })
    expect(backend.writeText).toHaveBeenCalledWith('notes/today.md', 'updated', 'rev-1', {
      topicId: 'topic-test',
      toolCallId: 'write-call'
    })
    expect(JSON.stringify(writeResult)).not.toContain('private/should-not-leak')

    const editResult = await edit.execute('edit-call', {
      path: 'notes/today.md',
      edits: [{ oldText: 'old', newText: 'new' }],
      expectedRevision: 'rev-2'
    })
    expect(backend.editText).toHaveBeenCalledWith('notes/today.md', [{ oldText: 'old', newText: 'new' }], 'rev-2', {
      topicId: 'topic-test',
      toolCallId: 'edit-call'
    })
    expect(JSON.stringify(editResult)).not.toContain('private/should-not-leak')

    await workspace.execute('workspace-call', { action: 'pwd' })
    expect(backend.descriptor.rootUri).toContain('private')
    // The pwd result contains only a logical path and display name, never the
    // native root URI.
    expect(JSON.stringify(await workspace.execute('workspace-call-2', { action: 'pwd' }))).not.toContain('file:///')
  })
})
