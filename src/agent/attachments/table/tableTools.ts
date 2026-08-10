import type { AgentTool } from '@earendil-works/pi-agent-core'

import type { WorkspaceMutationContext } from '@/agent/workspace/types'

import type { AgentTableService } from './AgentTableService'

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false }) as AgentTool['parameters']

const commonProperties = {
  path: { type: 'string', description: 'Read-only attachment path under inputs/' },
  has_header: { type: 'boolean', description: 'Whether the first CSV/TSV record is a header; defaults to true' },
  delimiter: {
    type: 'string',
    enum: [',', '\t', ';', '|'],
    description: 'Optional separator override for CSV/TSV; auto-detected when omitted'
  }
}

type CommonArgs = { path: string; has_header?: boolean; delimiter?: string }
type InspectArgs = CommonArgs & { column_offset?: number; column_limit?: number }

function common(args: CommonArgs) {
  return { path: args.path, hasHeader: args.has_header, delimiter: args.delimiter }
}

function boundedInspection(inspection: Awaited<ReturnType<AgentTableService['inspect']>>, args: InspectArgs) {
  const columnOffset = Math.min(inspection.columns.length, Math.max(0, Math.floor(args.column_offset ?? 0)))
  const columnLimit = Math.max(1, Math.min(50, Math.floor(args.column_limit ?? 25)))
  const columns = inspection.columns.slice(columnOffset, columnOffset + columnLimit)
  const names = new Set(columns.map(column => column.name))
  return {
    ...inspection,
    columnCount: inspection.columns.length,
    columnOffset,
    columns,
    sampleRows: inspection.sampleRows.map(row =>
      Object.fromEntries(Object.entries(row).filter(([name]) => names.has(name)))
    ),
    omittedColumnsBefore: columnOffset,
    omittedColumnsAfter: Math.max(0, inspection.columns.length - columnOffset - columns.length)
  }
}

export function createTableTools(service: AgentTableService, baseContext: WorkspaceMutationContext = {}): AgentTool[] {
  const inspect: AgentTool = {
    name: 'table_inspect',
    label: 'table_inspect',
    description:
      'Inspect a CSV, TSV, JSONL or NDJSON attachment without putting the whole file in model context. Returns exact row count, inferred schema and a small sample. Call this before writing SQL.',
    parameters: objectSchema(
      {
        ...commonProperties,
        column_offset: { type: 'number', minimum: 0, description: '0-based schema column offset; defaults to 0' },
        column_limit: {
          type: 'number',
          minimum: 1,
          maximum: 50,
          description: 'Schema columns to return; defaults to 25'
        }
      },
      ['path']
    ),
    executionMode: 'parallel',
    execute: async (_callId, args) => {
      const input = args as InspectArgs
      const result = boundedInspection(await service.inspect(common(input)), input)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result }
    }
  }

  const query: AgentTool = {
    name: 'table_query',
    label: 'table_query',
    description:
      'Run one read-only SQLite SELECT over a CSV/TSV/JSONL attachment imported as table data. Results are capped by rows and bytes. Mutation, PRAGMA, ATTACH and multiple statements are rejected.',
    parameters: objectSchema(
      {
        ...commonProperties,
        sql: {
          type: 'string',
          description: 'One SELECT or WITH ... SELECT statement. Query the attachment as table data.'
        },
        row_limit: { type: 'number', minimum: 1, maximum: 500, description: 'Maximum rows to return; defaults to 100' }
      },
      ['path', 'sql']
    ),
    executionMode: 'parallel',
    execute: async (_callId, args) => {
      const input = args as CommonArgs & { sql: string; row_limit?: number }
      const result = await service.query({ ...common(input), sql: input.sql, rowLimit: input.row_limit })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result }
    }
  }

  const exportTable: AgentTool = {
    name: 'table_export',
    label: 'table_export',
    description:
      'Run one read-only SQLite SELECT and save the result as a CSV under outputs/. The export is capped at 100,000 rows and 16 MiB. Publish the completed output with publish_file.',
    parameters: objectSchema(
      {
        ...commonProperties,
        sql: { type: 'string', description: 'One SELECT or WITH ... SELECT statement' },
        output_path: { type: 'string', description: 'Destination path under outputs/, normally ending in .csv' }
      },
      ['path', 'sql', 'output_path']
    ),
    executionMode: 'sequential',
    execute: async (callId, args) => {
      const input = args as CommonArgs & { sql: string; output_path: string }
      const result = await service.export(
        { ...common(input), sql: input.sql, outputPath: input.output_path },
        { ...baseContext, toolCallId: callId }
      )
      return {
        content: [
          {
            type: 'text',
            text: `Exported ${result.rows} row(s), ${result.bytes} bytes to ${result.path}. Operation: ${result.operationId}`
          }
        ],
        details: result
      }
    }
  }

  return [inspect, query, exportTable]
}
