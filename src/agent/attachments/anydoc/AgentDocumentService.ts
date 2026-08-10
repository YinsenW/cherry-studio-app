import type { AgentRuntimeBackend } from '@/agent/workspace/AgentRuntimeBackend'
import type { WorkspaceMutationContext } from '@/agent/workspace/types'

import type { AgentAttachmentKind } from '../AttachmentManifest'
import { AnydocAdapter } from './AnydocAdapter'

const MAX_READ_LINES = 400
const MAX_READ_BYTES = 50 * 1024
const MAX_SEARCH_RESULTS = 50
const MAX_SECTION_RESULTS = 100

export type DocumentSection = {
  id: string
  title: string
  level: number
  startLine: number
  endLine: number
}

export type DocumentInspection = {
  path: string
  format: string
  engine: string
  engineVersion: string
  derivedPath: string
  characters: number
  lines: number
  sections: DocumentSection[]
  omittedSections: number
  instructions: string
}

type IndexedDocument = {
  key: string
  inspection: DocumentInspection
  lines: string[]
  sections: DocumentSection[]
}

function hashKey(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return value
  let truncated = new TextDecoder().decode(bytes.slice(0, maxBytes))
  while (new TextEncoder().encode(truncated).byteLength > maxBytes) truncated = truncated.slice(0, -1)
  return truncated
}

function assertDocumentKind(kind: AgentAttachmentKind): void {
  if (kind !== 'document' && kind !== 'spreadsheet') {
    throw new Error('document_* tools accept office documents, PDFs, RTF, EPUB and OpenDocument attachments.')
  }
}

function buildSections(lines: string[]): DocumentSection[] {
  const headings: DocumentSection[] = []
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!match) return
    headings.push({
      id: `section-${headings.length + 1}`,
      title: match[2].replace(/\s+#+\s*$/, '').slice(0, 300),
      level: match[1].length,
      startLine: index + 1,
      endLine: lines.length
    })
  })
  headings.forEach((heading, index) => {
    const next = headings.slice(index + 1).find(candidate => candidate.level <= heading.level)
    heading.endLine = next ? next.startLine - 1 : lines.length
  })
  return headings
}

export class AgentDocumentService {
  private readonly cache = new Map<string, Promise<IndexedDocument>>()

  constructor(
    private readonly backend: AgentRuntimeBackend,
    private readonly adapter = new AnydocAdapter()
  ) {}

  async inspect(path: string): Promise<DocumentInspection> {
    return (await this.load(path)).inspection
  }

  async read(input: { path: string; sectionId?: string; startLine?: number; lineLimit?: number }): Promise<{
    path: string
    section?: DocumentSection
    content: string
    startLine: number
    endLine: number
    totalLines: number
    truncated: boolean
    nextStartLine?: number
    oversizedLine: boolean
  }> {
    const document = await this.load(input.path)
    const section = input.sectionId ? document.sections.find(candidate => candidate.id === input.sectionId) : undefined
    if (input.sectionId && !section) throw new Error(`Document section not found: ${input.sectionId}`)
    const minimum = section?.startLine ?? 1
    const maximum = section?.endLine ?? document.lines.length
    const startLine = Math.max(minimum, Math.min(maximum, Math.floor(input.startLine ?? minimum)))
    const limit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(input.lineLimit ?? 120)))
    const requestedEnd = Math.min(maximum, startLine + limit - 1)
    let content = ''
    let endLine = startLine - 1
    let oversizedLine = false
    for (let lineNumber = startLine; lineNumber <= requestedEnd; lineNumber++) {
      const line = document.lines[lineNumber - 1]
      const hasSelectedLine = endLine >= startLine
      const candidate = hasSelectedLine ? `${content}\n${line}` : line
      if (new TextEncoder().encode(candidate).byteLength > MAX_READ_BYTES) {
        if (!hasSelectedLine) {
          content = truncateUtf8(line, MAX_READ_BYTES)
          endLine = lineNumber
          oversizedLine = true
        }
        break
      }
      content = candidate
      endLine = lineNumber
    }
    const truncated = endLine < maximum || oversizedLine
    return {
      path: document.inspection.path,
      ...(section ? { section } : {}),
      content,
      startLine,
      endLine,
      totalLines: document.lines.length,
      truncated,
      ...(truncated && !oversizedLine ? { nextStartLine: endLine + 1 } : {}),
      oversizedLine
    }
  }

  async search(input: { path: string; query: string; maxResults?: number }): Promise<{
    path: string
    query: string
    matches: { line: number; sectionId?: string; text: string }[]
    truncated: boolean
  }> {
    if (!input.query) throw new Error('document_search requires a non-empty query.')
    if (input.query.length > 200) throw new Error('document_search query is limited to 200 characters.')
    const document = await this.load(input.path)
    const query = input.query.toLocaleLowerCase()
    const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(input.maxResults ?? 20)))
    const matches: { line: number; sectionId?: string; text: string }[] = []
    for (let index = 0; index < document.lines.length; index++) {
      const lineNumber = index + 1
      if (!document.lines[index].toLocaleLowerCase().includes(query)) continue
      const activeSection = [...document.sections]
        .reverse()
        .find(section => section.startLine <= lineNumber && section.endLine >= lineNumber)
      matches.push({
        line: lineNumber,
        ...(activeSection ? { sectionId: activeSection.id } : {}),
        text: document.lines[index].slice(0, 500)
      })
      if (matches.length >= maxResults) {
        return { path: document.inspection.path, query: input.query, matches, truncated: true }
      }
    }
    return { path: document.inspection.path, query: input.query, matches, truncated: false }
  }

  async exportMarkdown(
    input: { path: string; outputPath: string },
    context?: WorkspaceMutationContext
  ): Promise<{ path: string; bytes: number; operationId: string }> {
    if (!input.outputPath.startsWith('outputs/')) throw new Error('document_export output_path must be under outputs/.')
    const document = await this.load(input.path)
    const content = document.lines.join('\n')
    const mutation = await this.backend.writeText(input.outputPath, content, undefined, context)
    return { path: mutation.path, bytes: mutation.bytesWritten, operationId: mutation.operationId }
  }

  dispose(): void {
    this.cache.clear()
  }

  private async load(path: string): Promise<IndexedDocument> {
    const source = await this.backend.getInputAttachment(path)
    assertDocumentKind(source.attachment.kind)
    const key = [source.attachment.id, source.file.size, source.file.modificationTime].join(':')
    let pending = this.cache.get(key)
    if (!pending) {
      pending = (async () => {
        const normalized = await this.adapter.normalize(source.file, source.attachment.extension)
        const markdown = normalized.markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        const lines = markdown.split('\n')
        const sections = buildSections(lines)
        const derivedPath = `scratch/attachments/${hashKey(key)}-anydoc.md`
        await this.backend.writeText(derivedPath, markdown)
        const inspection: DocumentInspection = {
          path: source.attachment.logicalPath,
          format: source.attachment.extension.replace(/^\./, '') || 'unknown',
          engine: normalized.engine,
          engineVersion: normalized.engineVersion,
          derivedPath,
          characters: markdown.length,
          lines: lines.length,
          sections: sections.slice(0, MAX_SECTION_RESULTS),
          omittedSections: Math.max(0, sections.length - MAX_SECTION_RESULTS),
          instructions:
            'Use document_search to locate terms, then document_read with a section_id or narrow line range. The full converted document is intentionally not returned.'
        }
        return { key, inspection, lines, sections }
      })()
      this.cache.set(key, pending)
      pending.catch(() => this.cache.delete(key))
    }
    return pending
  }
}
