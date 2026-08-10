import { agentRunDatabase, fileDatabase } from '@database'
import { Directory, File, Paths } from 'expo-file-system'

import type { FileMetadata } from '@/types/file'
import { FileTypes } from '@/types/file'
import { MessageBlockStatus } from '@/types/message'
import { uuid } from '@/utils'
import { getFileExtension, getFileType, normalizeExtension } from '@/utils/file'
import { createFileBlock, createImageBlock } from '@/utils/messageUtils/create'

import type { AgentRuntimeBackend } from './AgentRuntimeBackend'

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

export type PublishedAgentArtifact = {
  artifactId: string
  fileId: string
  messageId: string
  sourcePath: string
  displayName: string
  size: number
  type: FileTypes
}

function safeDisplayName(value: string, fallback: string): string {
  const basename = value.split(/[\\/]/).pop()?.normalize('NFC') ?? ''
  const withoutControlCharacters = [...basename]
    .filter(character => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f)
    .join('')
  const sanitized = withoutControlCharacters
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .slice(0, 160)
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : fallback
}

function fileTypeFromMime(mimeType: string | undefined, extension: string): FileTypes {
  const fromExtension = getFileType(extension)
  if (fromExtension !== FileTypes.OTHER) return fromExtension
  if (mimeType?.startsWith('image/')) return FileTypes.IMAGE
  if (mimeType?.startsWith('video/')) return FileTypes.VIDEO
  if (mimeType?.startsWith('audio/')) return FileTypes.AUDIO
  if (mimeType?.startsWith('text/')) return FileTypes.TEXT
  if (mimeType === 'application/pdf') return FileTypes.DOCUMENT
  return FileTypes.OTHER
}

export class AgentArtifactPublisher {
  private readonly publishedPaths = new Set<string>()

  constructor(
    private readonly runId: string,
    private readonly assistantMessageId: string,
    private readonly backend: AgentRuntimeBackend
  ) {}

  async publish(input: { path: string; displayName?: string; mimeType?: string }): Promise<PublishedAgentArtifact> {
    const output = await this.backend.getOutputFile(input.path)
    const existing = await agentRunDatabase.getArtifact(this.runId, output.path)
    if (existing) {
      const existingFile = await fileDatabase.getFileById(existing.fileId)
      if (existingFile) {
        this.publishedPaths.add(output.path)
        return this.toPublicResult(existing.id, output.path, existingFile)
      }
    }

    if (output.file.size > MAX_ARTIFACT_BYTES) {
      throw new Error('Published files are limited to 100 MiB on mobile.')
    }
    if (input.mimeType && !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType)) {
      throw new Error('mimeType is not a valid MIME type.')
    }

    const sourceName = output.path.split('/').pop() || 'agent-output'
    let displayName = safeDisplayName(input.displayName || sourceName, 'agent-output')
    const sourceExtension = normalizeExtension(getFileExtension(sourceName))
    if (!getFileExtension(displayName) && sourceExtension) displayName += sourceExtension
    const extension = normalizeExtension(getFileExtension(displayName) || sourceExtension)
    const mimeType = output.file.type || input.mimeType
    const type = fileTypeFromMime(mimeType, extension)
    const fileId = uuid()
    const artifactId = uuid()
    const artifactDirectory = new Directory(Paths.document, 'AgentArtifacts')
    if (!artifactDirectory.exists) artifactDirectory.create({ intermediates: true, idempotent: true })
    const destination = new File(artifactDirectory, `${fileId}${extension}`)

    try {
      try {
        output.file.copy(destination)
      } catch {
        destination.write(await output.file.bytes())
      }
    } catch (error) {
      if (destination.exists) destination.delete()
      throw error
    }

    const file: FileMetadata = {
      id: fileId,
      name: displayName,
      origin_name: displayName,
      path: destination.uri,
      size: destination.size,
      ext: extension,
      count: 1,
      type,
      created_at: Date.now()
    }
    const metadata = {
      agentArtifact: {
        runId: this.runId,
        sourcePath: output.path,
        mimeType: mimeType || undefined
      }
    }
    const block =
      type === FileTypes.IMAGE
        ? createImageBlock(this.assistantMessageId, { file, metadata, status: MessageBlockStatus.SUCCESS })
        : createFileBlock(this.assistantMessageId, file, { metadata, status: MessageBlockStatus.SUCCESS })

    try {
      await agentRunDatabase.publishArtifact(
        file,
        {
          id: artifactId,
          runId: this.runId,
          fileId,
          messageId: this.assistantMessageId,
          sourcePath: output.path,
          displayName,
          createdAt: Date.now()
        },
        block
      )
    } catch (error) {
      if (destination.exists) destination.delete()
      throw error
    }

    this.publishedPaths.add(output.path)
    return this.toPublicResult(artifactId, output.path, file)
  }

  async publishPendingOutputs(): Promise<PublishedAgentArtifact[]> {
    const existing = await agentRunDatabase.getArtifactsForRun(this.runId)
    existing.forEach(artifact => this.publishedPaths.add(artifact.sourcePath))
    const paths = await this.backend.listOutputFiles()
    const published: PublishedAgentArtifact[] = []
    for (const path of paths) {
      if (this.publishedPaths.has(path)) continue
      published.push(await this.publish({ path }))
    }
    return published
  }

  private toPublicResult(artifactId: string, sourcePath: string, file: FileMetadata): PublishedAgentArtifact {
    return {
      artifactId,
      fileId: file.id,
      messageId: this.assistantMessageId,
      sourcePath,
      displayName: file.origin_name,
      size: file.size,
      type: file.type
    }
  }
}
