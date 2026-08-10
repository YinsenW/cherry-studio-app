import { type FileMetadata, FileTypes } from '@/types/file'

const mockInputFiles = new Map<string, { content: string; mimeType: string }>()

jest.mock('expo-file-system', () => ({
  File: class MockFile {
    readonly uri: string
    constructor(mockUri: string) {
      this.uri = mockUri
    }
    get exists() {
      return mockInputFiles.has(this.uri)
    }
    get size() {
      return new TextEncoder().encode(mockInputFiles.get(this.uri)?.content ?? '').byteLength
    }
    get modificationTime() {
      return 1
    }
    get md5() {
      return this.exists ? `md5:${this.uri}` : null
    }
    get type() {
      return mockInputFiles.get(this.uri)?.mimeType
    }
    async text() {
      const file = mockInputFiles.get(this.uri)
      if (!file) throw new Error('missing file')
      return file.content
    }
  }
}))

// eslint-disable-next-line import/first
import { AgentInputBackend } from '../AgentInputBackend'

const metadata = (id: string, path: string, name: string, type = FileTypes.TEXT): FileMetadata => ({
  id,
  path,
  name,
  origin_name: name,
  size: mockInputFiles.get(path)?.content.length ?? 0,
  ext: name.includes('.') ? name.slice(name.lastIndexOf('.')) : '',
  type,
  count: 1,
  created_at: 1
})

describe('AgentInputBackend', () => {
  beforeEach(() => {
    mockInputFiles.clear()
    mockInputFiles.set('file:///one', { content: 'first\nsecond', mimeType: 'text/plain' })
    mockInputFiles.set('file:///two', { content: 'other', mimeType: 'text/plain' })
    mockInputFiles.set('file:///pdf', { content: '%PDF-binary', mimeType: 'application/pdf' })
  })

  it('mounts attachments by safe logical names without exposing native paths', async () => {
    const backend = new AgentInputBackend('run-1', [
      {
        path: 'current',
        files: [
          metadata('one', 'file:///one', '../notes.txt'),
          metadata('two', 'file:///two', 'notes.txt'),
          metadata('pdf', 'file:///pdf', 'report.pdf', FileTypes.DOCUMENT)
        ]
      }
    ])

    const entries = await backend.list({ path: 'current' })
    expect(entries.map(entry => entry.path)).toEqual(['current/notes-2.txt', 'current/notes.txt', 'current/report.pdf'])
    expect(JSON.stringify(entries)).not.toContain('file:///')
    expect((await backend.readText('current/notes.txt')).content).toBe('first\nsecond')
    await expect(backend.readText('current/report.pdf')).rejects.toThrow('Binary attachment')
    await expect(backend.writeText('current/notes.txt', 'changed')).rejects.toThrow('read-only')
  })
})
