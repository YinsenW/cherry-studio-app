const mockNodes = new Map<
  string,
  { kind: 'file' | 'directory'; parent: string | null; name: string; content?: string; mimeType?: string }
>()
let mockUuidCounter = 0

function mockNodeName(uri: string): string {
  return decodeURIComponent(uri.replace(/\/$/, '').split('/').pop() ?? '')
}

function mockParentUri(uri: string): string {
  const slash = uri.lastIndexOf('/')
  return slash > 'file:///'.length ? uri.slice(0, slash) : uri
}

function mockEnsureDirectory(uri: string): void {
  if (mockNodes.get(uri)?.kind === 'directory') return
  const parent = mockParentUri(uri)
  if (parent !== uri) mockEnsureDirectory(parent)
  mockNodes.set(uri, { kind: 'directory', parent: parent === uri ? null : parent, name: mockNodeName(uri) })
}

function mockChildUri(parentUri: string, name: string): string {
  return `${parentUri.replace(/\/$/, '')}/${encodeURIComponent(name)}`
}

jest.mock('expo-file-system', () => {
  class MockFile {
    readonly uri: string

    constructor(...uris: unknown[]) {
      this.uri = uris.reduce<string>((current, part) => {
        const value = typeof part === 'string' ? part : (part as { uri: string }).uri
        return current ? mockChildUri(current, value) : value
      }, '')
    }

    get exists() {
      return mockNodes.get(this.uri)?.kind === 'file'
    }

    get name() {
      return mockNodeName(this.uri)
    }

    get size() {
      return mockNodes.get(this.uri)?.content?.length ?? null
    }

    get modificationTime() {
      return null
    }

    get type() {
      return mockNodes.get(this.uri)?.mimeType ?? 'text/plain'
    }

    get md5() {
      return mockNodes.get(this.uri)?.content ?? null
    }

    create(options: { intermediates?: boolean } = {}) {
      if (this.uri.startsWith('content://')) throw new Error('SAF File.create must not be used')
      if (mockNodes.has(this.uri)) throw new Error('file already exists')
      if (options.intermediates) mockEnsureDirectory(mockParentUri(this.uri))
      mockNodes.set(this.uri, {
        kind: 'file',
        parent: mockParentUri(this.uri),
        name: this.name,
        content: ''
      })
    }

    write(content: string | Uint8Array) {
      const node = mockNodes.get(this.uri)
      if (!node || node.kind !== 'file') throw new Error('file does not exist')
      node.content = typeof content === 'string' ? content : new TextDecoder().decode(content)
    }

    async text() {
      const node = mockNodes.get(this.uri)
      if (!node || node.kind !== 'file') throw new Error('file does not exist')
      return node.content ?? ''
    }

    async bytes() {
      return new TextEncoder().encode(await this.text())
    }

    info() {
      return { exists: this.exists, size: this.size, modificationTime: null }
    }

    delete() {
      mockNodes.delete(this.uri)
    }
  }

  class MockDirectory {
    readonly uri: string

    constructor(...uris: unknown[]) {
      this.uri = uris.reduce<string>((current, part) => {
        const value = typeof part === 'string' ? part : (part as { uri: string }).uri
        return current ? mockChildUri(current, value) : value
      }, '')
    }

    get exists() {
      return mockNodes.get(this.uri)?.kind === 'directory'
    }

    get name() {
      return mockNodeName(this.uri)
    }

    get size() {
      return 0
    }

    create(options: { intermediates?: boolean; idempotent?: boolean } = {}) {
      if (this.uri.startsWith('content://')) throw new Error('SAF Directory.create must not be used')
      if (this.exists && options.idempotent) return
      if (options.intermediates) mockEnsureDirectory(this.uri)
      else {
        mockEnsureDirectory(mockParentUri(this.uri))
        mockNodes.set(this.uri, { kind: 'directory', parent: mockParentUri(this.uri), name: this.name })
      }
    }

    createDirectory(name: string) {
      const uri = mockChildUri(this.uri, name)
      if (mockNodes.has(uri)) throw new Error('directory already exists')
      mockNodes.set(uri, { kind: 'directory', parent: this.uri, name })
      return new MockDirectory(uri)
    }

    createFile(name: string, mimeType: string | null) {
      const uri = mockChildUri(this.uri, name)
      if (mockNodes.has(uri)) throw new Error('file already exists')
      mockNodes.set(uri, { kind: 'file', parent: this.uri, name, content: '', mimeType: mimeType ?? undefined })
      return new MockFile(uri)
    }

    list() {
      return [...mockNodes.entries()]
        .filter(([, node]) => node.parent === this.uri)
        .map(([uri, node]) => (node.kind === 'file' ? new MockFile(uri) : new MockDirectory(uri)))
    }

    info() {
      return { exists: this.exists, size: 0, modificationTime: null }
    }
  }

  const document = new MockDirectory('file:///app/doc')
  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: {
      document,
      info(uri: string) {
        const node = mockNodes.get(uri)
        return { exists: !!node, isDirectory: node?.kind === 'directory' }
      }
    }
  }
})

jest.mock('@database', () => ({ agentWorkspaceDatabase: { recordOperation: jest.fn() } }))
jest.mock('@/services/LoggerService', () => ({
  loggerService: { withContext: () => ({ warn: jest.fn(), error: jest.fn() }) }
}))
jest.mock('@/utils', () => ({ uuid: () => `op-${++mockUuidCounter}` }))

// eslint-disable-next-line import/first
import { AppSandboxBackend } from '../AppSandboxBackend'
// eslint-disable-next-line import/first
import type { WorkspaceDescriptor } from '../types'

const descriptor: WorkspaceDescriptor = {
  id: 'android-test',
  name: 'Android folder',
  kind: 'android_saf',
  rootUri: 'content://picker/tree/android/document/android',
  readOnly: false,
  createdAt: 1,
  updatedAt: 1
}

describe('AppSandboxBackend Android SAF paths', () => {
  beforeEach(() => {
    mockNodes.clear()
    mockUuidCounter = 0
    mockNodes.set(descriptor.rootUri, { kind: 'directory', parent: null, name: descriptor.name })
  })

  it('creates and resolves files through SAF directory APIs instead of concatenated child URIs', async () => {
    const backend = new AppSandboxBackend(descriptor)

    await backend.mkdir('mydir')
    const write = await backend.writeText('mydir/hello.txt', 'hello')
    const rootWrite = await backend.writeText('test.txt', 'root')

    expect(write.path).toBe('mydir/hello.txt')
    expect(rootWrite.path).toBe('test.txt')
    expect((await backend.readText('mydir/hello.txt')).content).toBe('hello')
    expect((await backend.stat('test.txt')).kind).toBe('file')
    expect((await backend.list()).map(entry => entry.path)).toEqual(['mydir', 'test.txt'])

    await backend.editText('mydir/hello.txt', [{ oldText: 'hello', newText: 'updated' }])
    expect((await backend.readText('mydir/hello.txt')).content).toBe('updated')

    await backend.copy('mydir/hello.txt', 'copy.txt')
    await backend.move('copy.txt', 'moved.txt')
    expect((await backend.readText('moved.txt')).content).toBe('updated')

    const trashed = await backend.trash('moved.txt')
    await expect(backend.stat('moved.txt')).rejects.toThrow('Path not found')
    await backend.restore(trashed.trashPath)
    expect((await backend.readText('moved.txt')).content).toBe('updated')
  })
})
