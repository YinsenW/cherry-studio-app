import type { AgentTool } from '@earendil-works/pi-agent-core'

import type { WorkspaceMutationContext } from '@/agent/workspace/types'

import type { AgentDocumentService } from './AgentDocumentService'

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false }) as AgentTool['parameters']

export function createDocumentTools(
  service: AgentDocumentService,
  baseContext: WorkspaceMutationContext = {}
): AgentTool[] {
  const inspect: AgentTool = {
    name: 'document_inspect',
    label: 'document_inspect',
    description:
      'Locally normalize an office document, PDF, RTF, EPUB or OpenDocument attachment with anydoc, then return metadata and a bounded section outline. The full document is never inserted into context.',
    parameters: objectSchema({ path: { type: 'string', description: 'Read-only attachment path under inputs/' } }, [
      'path'
    ]),
    executionMode: 'parallel',
    execute: async (_callId, args) => {
      const result = await service.inspect((args as { path: string }).path)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result }
    }
  }

  const search: AgentTool = {
    name: 'document_search',
    label: 'document_search',
    description:
      'Search locally normalized document text with a case-insensitive literal query. Returns only matching lines and section IDs, capped at 50 matches.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: 'Read-only attachment path under inputs/' },
        query: { type: 'string', description: 'Literal text to find; maximum 200 characters' },
        max_results: { type: 'number', minimum: 1, maximum: 50 }
      },
      ['path', 'query']
    ),
    executionMode: 'parallel',
    execute: async (_callId, args) => {
      const input = args as { path: string; query: string; max_results?: number }
      const result = await service.search({ path: input.path, query: input.query, maxResults: input.max_results })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result }
    }
  }

  const read: AgentTool = {
    name: 'document_read',
    label: 'document_read',
    description:
      'Read one bounded section or line range from a locally normalized document. Output is capped at 400 lines and 50 KiB; continue with start_line when truncated.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: 'Read-only attachment path under inputs/' },
        section_id: { type: 'string', description: 'Optional section ID returned by document_inspect/search' },
        start_line: { type: 'number', minimum: 1, description: 'Optional absolute 1-based start line' },
        line_limit: { type: 'number', minimum: 1, maximum: 400 }
      },
      ['path']
    ),
    executionMode: 'parallel',
    execute: async (_callId, args) => {
      const input = args as { path: string; section_id?: string; start_line?: number; line_limit?: number }
      const result = await service.read({
        path: input.path,
        sectionId: input.section_id,
        startLine: input.start_line,
        lineLimit: input.line_limit
      })
      const continuation = result.oversizedLine
        ? '\n\n[A single derived line exceeded 50 KiB. Use document_search or a more specific query instead of requesting the whole line.]'
        : result.nextStartLine
          ? `\n\n[Continue with start_line=${result.nextStartLine}.]`
          : ''
      return {
        content: [{ type: 'text', text: result.content + continuation }],
        details: { ...result, content: undefined }
      }
    }
  }

  const exportDocument: AgentTool = {
    name: 'document_export',
    label: 'document_export',
    description:
      'Save the complete local anydoc Markdown conversion under outputs/ when the user explicitly wants a converted file. Publish it with publish_file.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: 'Read-only attachment path under inputs/' },
        output_path: { type: 'string', description: 'Destination path under outputs/, normally ending in .md' }
      },
      ['path', 'output_path']
    ),
    executionMode: 'sequential',
    execute: async (callId, args) => {
      const input = args as { path: string; output_path: string }
      const result = await service.exportMarkdown(
        { path: input.path, outputPath: input.output_path },
        { ...baseContext, toolCallId: callId }
      )
      return {
        content: [
          {
            type: 'text',
            text: `Exported the normalized document (${result.bytes} bytes) to ${result.path}. Operation: ${result.operationId}`
          }
        ],
        details: result
      }
    }
  }

  return [inspect, search, read, exportDocument]
}
