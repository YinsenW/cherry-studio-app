import type { FileMetadata } from '@/types/file'
import type { MessageBlock } from '@/types/message'

const mockFiles = new Map<string, FileMetadata>()
const mockArtifacts = new Map<string, any>()
const mockBlocks: MessageBlock[] = []
let mockUuid = 0

jest.mock('expo-file-system', () => {
  const nodes = new Map<string, { kind: 'file' | 'directory'; content?: Uint8Array; mimeType?: string }>()
  const join = (base: string, child: string) => `${base.replace(/\/$/, '')}/${child}`

  class MockDirectory {
    readonly uri: string
    constructor(base: string | { uri: string }, ...children: string[]) {
      this.uri = children.reduce((current, child) => join(current, child), typeof base === 'string' ? base : base.uri)
    }
    get exists() {
      return nodes.get(this.uri)?.kind === 'directory'
    }
    create() {
      nodes.set(this.uri, { kind: 'directory' })
    }
  }

  class MockFile {
    readonly uri: string
    constructor(base: string | { uri: string }, ...children: string[]) {
      this.uri = children.reduce((current, child) => join(current, child), typeof base === 'string' ? base : base.uri)
    }
    get exists() {
      return nodes.get(this.uri)?.kind === 'file'
    }
    get size() {
      return nodes.get(this.uri)?.content?.byteLength ?? 0
    }
    get type() {
      return nodes.get(this.uri)?.mimeType
    }
    write(content: string | Uint8Array) {
      nodes.set(this.uri, {
        kind: 'file',
        content: typeof content === 'string' ? new TextEncoder().encode(content) : content,
        mimeType: nodes.get(this.uri)?.mimeType ?? 'text/plain'
      })
    }
    copy(destination: MockFile) {
      const source = nodes.get(this.uri)
      if (!source || source.kind !== 'file') throw new Error('missing source')
      nodes.set(destination.uri, { ...source, content: source.content?.slice() })
    }
    async bytes() {
      return nodes.get(this.uri)?.content ?? new Uint8Array()
    }
    delete() {
      nodes.delete(this.uri)
    }
  }

  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { document: new MockDirectory('file:///documents') }
  }
})

jest.mock('@database', () => ({
  agentRunDatabase: {
    getArtifact: jest.fn(
      async (runId: string, sourcePath: string) => mockArtifacts.get(`${runId}:${sourcePath}`) ?? null
    ),
    getArtifactsForRun: jest.fn(async (runId: string) =>
      [...mockArtifacts.values()].filter(artifact => artifact.runId === runId)
    ),
    recordArtifact: jest.fn(async (artifact: any) => {
      mockArtifacts.set(`${artifact.runId}:${artifact.sourcePath}`, artifact)
    }),
    publishArtifact: jest.fn(async (file: FileMetadata, artifact: any, block: MessageBlock) => {
      mockFiles.set(file.id, file)
      mockArtifacts.set(`${artifact.runId}:${artifact.sourcePath}`, artifact)
      mockBlocks.push(block)
    })
  },
  fileDatabase: {
    getFileById: jest.fn(async (id: string) => mockFiles.get(id) ?? null),
    upsertFiles: jest.fn(async (files: FileMetadata[]) => files.forEach(file => mockFiles.set(file.id, file))),
    deleteFileById: jest.fn(async (id: string) => mockFiles.delete(id))
  }
}))
jest.mock('@/services/LoggerService', () => ({
  loggerService: { withContext: () => ({ warn: jest.fn() }) }
}))
jest.mock('@/utils', () => ({ uuid: () => `uuid-${++mockUuid}` }))

// eslint-disable-next-line import/first
import { File } from 'expo-file-system'

// eslint-disable-next-line import/first
import { AgentArtifactPublisher } from '../AgentArtifactPublisher'

describe('AgentArtifactPublisher', () => {
  beforeEach(() => {
    mockFiles.clear()
    mockArtifacts.clear()
    mockBlocks.length = 0
    mockUuid = 0
    jest.clearAllMocks()
  })

  it('copies an output snapshot into persistent storage and creates a user-visible message block', async () => {
    const source = new File('file:///runtime/outputs/report.txt')
    source.write('finished report')
    const backend = {
      getOutputFile: jest.fn(async () => ({ path: 'outputs/report.txt', file: source })),
      listOutputFiles: jest.fn(async () => ['outputs/report.txt'])
    }
    const publisher = new AgentArtifactPublisher('run-1', 'assistant-1', backend as never)

    const result = await publisher.publish({ path: 'outputs/report.txt' })

    expect(result).toMatchObject({
      messageId: 'assistant-1',
      sourcePath: 'outputs/report.txt',
      displayName: 'report.txt',
      size: 15
    })
    expect(JSON.stringify(result)).not.toContain('file:///')
    expect(mockFiles.get(result.fileId)?.path).toContain('/AgentArtifacts/')
    expect(mockBlocks).toHaveLength(1)
    expect(mockBlocks[0]).toMatchObject({
      messageId: 'assistant-1',
      status: 'success',
      metadata: { agentArtifact: { runId: 'run-1', sourcePath: 'outputs/report.txt' } }
    })

    const duplicate = await publisher.publish({ path: 'outputs/report.txt' })
    expect(duplicate.fileId).toBe(result.fileId)
    expect(mockBlocks).toHaveLength(1)
  })
})
