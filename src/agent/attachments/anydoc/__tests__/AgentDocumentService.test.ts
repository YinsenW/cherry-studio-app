import type { File } from 'expo-file-system'

import type { AgentRuntimeBackend } from '@/agent/workspace/AgentRuntimeBackend'

import type { PublicAgentAttachment } from '../../AttachmentManifest'
import { AgentDocumentService } from '../AgentDocumentService'

jest.mock('@/modules/pdf-text-extractor', () => ({ extractPdfText: jest.fn() }))

const markdown = Array.from(
  { length: 150 },
  (_, index) => `# Section ${index + 1}\nThis is body ${index + 1} with ${index === 119 ? 'needle' : 'ordinary text'}.`
).join('\n')

const attachment: PublicAgentAttachment = {
  id: 'document-1',
  name: 'report.docx',
  logicalPath: 'inputs/current/report.docx',
  size: 1_024,
  extension: '.docx',
  kind: 'document',
  suggestedTools: ['document_inspect']
}

describe('AgentDocumentService', () => {
  it('keeps full anydoc output private while supporting inspect, search, bounded read and export', async () => {
    const writeText = jest.fn(async (path: string, content: string) => ({
      path,
      bytesWritten: new TextEncoder().encode(content).byteLength,
      operationId: 'operation-1',
      revision: { value: '1', size: content.length, modificationTime: 1 }
    }))
    const backend = {
      getInputAttachment: jest.fn(async () => ({
        attachment,
        file: { size: 1_024, modificationTime: 1 } as File
      })),
      writeText
    } as unknown as AgentRuntimeBackend
    const adapter = {
      normalize: jest.fn(async () => ({ markdown, engine: 'anydoc-wasm' as const, engineVersion: '0.1.7' }))
    }
    const service = new AgentDocumentService(backend, adapter)

    const inspection = await service.inspect('inputs/current/report.docx')
    expect(inspection.sections).toHaveLength(100)
    expect(inspection.omittedSections).toBe(50)
    expect(JSON.stringify(inspection)).not.toContain('needle')
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('scratch/attachments/'), markdown)

    const search = await service.search({ path: attachment.logicalPath, query: 'needle' })
    expect(search.matches).toEqual([
      expect.objectContaining({ sectionId: 'section-120', text: expect.stringContaining('needle') })
    ])

    const read = await service.read({ path: attachment.logicalPath, sectionId: 'section-120', lineLimit: 10 })
    expect(read.content).toContain('needle')
    expect(read.content).not.toContain('Section 121')

    const exported = await service.exportMarkdown({
      path: attachment.logicalPath,
      outputPath: 'outputs/report.md'
    })
    expect(exported.path).toBe('outputs/report.md')
    expect(writeText).toHaveBeenLastCalledWith('outputs/report.md', markdown, undefined, undefined)
  })

  it('does not advertise a skipped continuation after truncating one oversized derived line', async () => {
    const backend = {
      getInputAttachment: jest.fn(async () => ({
        attachment,
        file: { size: 1_024, modificationTime: 1 } as File
      })),
      writeText: jest.fn(async (path: string, content: string) => ({
        path,
        bytesWritten: content.length,
        operationId: 'operation-2',
        revision: { value: '1', size: content.length, modificationTime: 1 }
      }))
    } as unknown as AgentRuntimeBackend
    const adapter = {
      normalize: jest.fn(async () => ({
        markdown: `# Huge\n${'数'.repeat(30_000)}`,
        engine: 'anydoc-wasm' as const,
        engineVersion: '0.1.7'
      }))
    }
    const service = new AgentDocumentService(backend, adapter)

    const result = await service.read({ path: attachment.logicalPath, startLine: 2, lineLimit: 1 })

    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(50 * 1024)
    expect(result.oversizedLine).toBe(true)
    expect(result.nextStartLine).toBeUndefined()
  })
})
