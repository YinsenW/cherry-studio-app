import { Directory, type File, Paths } from 'expo-file-system'
import type { SQLiteBindValue, SQLiteDatabase } from 'expo-sqlite'

import type { AgentRuntimeBackend } from '@/agent/workspace/AgentRuntimeBackend'
import type { WorkspaceMutationContext } from '@/agent/workspace/types'

import type { AgentAttachmentKind } from '../AttachmentManifest'
import { detectDelimiter, parseDelimitedFile, parseJsonLinesFile } from './DelimitedTextReader'
import { validateReadOnlySql } from './sqlPolicy'

const QUERY_DEFAULT_ROWS = 100
const QUERY_MAX_ROWS = 500
const QUERY_MAX_BYTES = 64 * 1024
const MAX_CELL_CHARACTERS = 4_096
const EXPORT_MAX_ROWS = 100_000
const EXPORT_MAX_BYTES = 16 * 1024 * 1024
const SAMPLE_ROWS = 5
const SAMPLE_CELL_CHARACTERS = 200
const TABLE_PROCESSING_TIMEOUT_MS = 60_000

type InferredType = 'null' | 'integer' | 'real' | 'boolean' | 'date' | 'text'

export type TableColumn = {
  name: string
  sqliteType: 'INTEGER' | 'REAL' | 'TEXT'
  inferredType: Exclude<InferredType, 'null'> | 'unknown'
  nullable: boolean
}

export type TableInspection = {
  path: string
  format: 'csv' | 'tsv' | 'jsonl'
  delimiter?: string
  hasHeader: boolean
  rowCount: number
  columns: TableColumn[]
  sampleRows: Record<string, unknown>[]
  invalidJsonRows?: number
  jsonKeys?: string[]
  queryHelp: string
}

export type TableQueryResult = {
  columns: string[]
  rows: Record<string, unknown>[]
  returnedRows: number
  truncated: boolean
  truncatedCells: number
}

type TableOptions = {
  path: string
  hasHeader?: boolean
  delimiter?: string
}

type LoadedTable = {
  key: string
  database: SQLiteDatabase
  inspection: TableInspection
  sourceSize: number
  sourceModificationTime: number | null
}

type DelimitedScan = {
  delimiter: string
  headers: string[]
  columns: TableColumn[]
  rowCount: number
  sampleRows: Record<string, unknown>[]
}

type DatabaseOpener = (
  databaseName: string,
  options?: { enableChangeListener?: boolean; useNewConnection?: boolean },
  directory?: string
) => Promise<SQLiteDatabase>

function yieldToUi(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function normalizeHeader(value: string, index: number, used: Set<string>): string {
  const cleaned = [...value.normalize('NFC')]
    .filter(character => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 128)
  const base = cleaned || `column_${index + 1}`
  let candidate = base.toLocaleLowerCase() === '_row_number' ? `${base}_value` : base
  let suffix = 2
  while (used.has(candidate.toLocaleLowerCase())) candidate = `${base}_${suffix++}`
  used.add(candidate.toLocaleLowerCase())
  return candidate
}

function inferValue(value: string): Exclude<InferredType, 'null'> | 'null' {
  const trimmed = value.trim()
  if (!trimmed) return 'null'
  if (/^(true|false)$/i.test(trimmed)) return 'boolean'
  if (/^[+-]?(0|[1-9]\d*)$/.test(trimmed)) {
    const number = Number(trimmed)
    if (Number.isSafeInteger(number)) return 'integer'
    return 'text'
  }
  if (/^[+-]?0\d/.test(trimmed)) return 'text'
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:e[+-]?\d+)?$/i.test(trimmed) && Number.isFinite(Number(trimmed))) {
    return 'real'
  }
  if (/^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]+Z?)?$/.test(trimmed)) return 'date'
  return 'text'
}

function mergeType(current: InferredType, next: InferredType): InferredType {
  if (next === 'null') return current
  if (current === 'null') return next
  if (current === next) return current
  if ((current === 'integer' && next === 'real') || (current === 'real' && next === 'integer')) return 'real'
  return 'text'
}

function sqliteType(type: InferredType): TableColumn['sqliteType'] {
  if (type === 'integer' || type === 'boolean') return 'INTEGER'
  if (type === 'real') return 'REAL'
  return 'TEXT'
}

function bindValue(value: string, column: TableColumn): SQLiteBindValue {
  if (!value.trim()) return null
  if (column.inferredType === 'integer') return Number(value)
  if (column.inferredType === 'real') return Number(value)
  if (column.inferredType === 'boolean') return /^true$/i.test(value.trim()) ? 1 : 0
  return value
}

function hashKey(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function normalizeCell(value: unknown): { value: unknown; truncated: boolean } {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return { value, truncated: false }
  if (value instanceof Uint8Array) return { value: `[binary ${value.byteLength} bytes]`, truncated: true }
  const text = String(value)
  if (text.length <= MAX_CELL_CHARACTERS) return { value: text, truncated: false }
  return { value: `${text.slice(0, MAX_CELL_CHARACTERS)}…`, truncated: true }
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = value instanceof Uint8Array ? `[binary ${value.byteLength} bytes]` : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function assertSupportedKind(kind: AgentAttachmentKind): void {
  if (kind !== 'delimited_table') {
    throw new Error(
      'table_* tools currently accept CSV, TSV, JSONL and NDJSON attachments. Use document_* for workbooks.'
    )
  }
}

export class AgentTableService {
  private readonly cache = new Map<string, Promise<LoadedTable>>()
  private readonly databaseDirectory: Directory
  private databaseSequence = 0
  private cancelled = false

  constructor(
    runId: string,
    private readonly backend: AgentRuntimeBackend,
    private readonly openDatabase?: DatabaseOpener
  ) {
    this.databaseDirectory = new Directory(Paths.cache, 'AgentRuntime', 'runs', runId, 'tables')
  }

  async inspect(options: TableOptions): Promise<TableInspection> {
    return (await this.load(options)).inspection
  }

  async query(options: TableOptions & { sql: string; rowLimit?: number }): Promise<TableQueryResult> {
    const loaded = await this.load(options)
    const sql = validateReadOnlySql(options.sql)
    const limit = Math.max(1, Math.min(QUERY_MAX_ROWS, Math.floor(options.rowLimit ?? QUERY_DEFAULT_ROWS)))
    return this.executeBoundedQuery(loaded.database, sql, limit)
  }

  async export(
    options: TableOptions & { sql: string; outputPath: string },
    context?: WorkspaceMutationContext
  ): Promise<{ path: string; rows: number; bytes: number; operationId: string }> {
    if (!options.outputPath.startsWith('outputs/')) throw new Error('table_export output_path must be under outputs/.')
    const loaded = await this.load(options)
    const sql = validateReadOnlySql(options.sql)
    const deadline = Date.now() + TABLE_PROCESSING_TIMEOUT_MS
    const statement = await loaded.database.prepareAsync(
      `SELECT * FROM (${sql}) AS agent_export LIMIT ${EXPORT_MAX_ROWS + 1}`
    )
    try {
      const columns = await statement.getColumnNamesAsync()
      const result = await statement.executeAsync<Record<string, unknown>>()
      const chunks: string[] = [`${columns.map(csvCell).join(',')}\n`]
      let bytes = new TextEncoder().encode(chunks[0]).byteLength
      let rows = 0
      for await (const row of result) {
        this.assertActive(deadline)
        if (rows >= EXPORT_MAX_ROWS) {
          throw new Error(`Export exceeds the ${EXPORT_MAX_ROWS}-row mobile safety limit. Narrow the SQL query.`)
        }
        const line = `${columns.map(column => csvCell(row[column])).join(',')}\n`
        const lineBytes = new TextEncoder().encode(line).byteLength
        if (bytes + lineBytes > EXPORT_MAX_BYTES) {
          throw new Error('Export exceeds the 16 MiB mobile safety limit. Narrow the SQL query.')
        }
        chunks.push(line)
        bytes += lineBytes
        rows++
        if (rows % 2_000 === 0) await yieldToUi()
      }
      const mutation = await this.backend.writeText(options.outputPath, chunks.join(''), undefined, context)
      return { path: mutation.path, rows, bytes, operationId: mutation.operationId }
    } finally {
      await statement.finalizeAsync()
    }
  }

  async dispose(): Promise<void> {
    this.cancelled = true
    const loaded = await Promise.allSettled([...this.cache.values()])
    await Promise.all(
      loaded.map(result =>
        result.status === 'fulfilled' ? result.value.database.closeAsync().catch(() => undefined) : undefined
      )
    )
    this.cache.clear()
  }

  private async load(options: TableOptions): Promise<LoadedTable> {
    this.assertActive()
    const source = await this.backend.getInputAttachment(options.path)
    assertSupportedKind(source.attachment.kind)
    const extension = source.attachment.extension.toLocaleLowerCase()
    const hasHeader = options.hasHeader ?? true
    const delimiter = options.delimiter
    if (delimiter && ![',', '\t', ';', '|'].includes(delimiter)) {
      throw new Error('delimiter must be comma, tab, semicolon or pipe.')
    }
    const key = [source.attachment.id, source.file.size, source.file.modificationTime, hasHeader, delimiter].join(':')
    let pending = this.cache.get(key)
    if (!pending) {
      pending = this.buildLoadedTable(key, source.file, source.attachment.logicalPath, extension, hasHeader, delimiter)
      this.cache.set(key, pending)
      pending.catch(() => this.cache.delete(key))
    }
    return pending
  }

  private async buildLoadedTable(
    key: string,
    file: File,
    path: string,
    extension: string,
    hasHeader: boolean,
    requestedDelimiter?: string
  ): Promise<LoadedTable> {
    const deadline = Date.now() + TABLE_PROCESSING_TIMEOUT_MS
    if (!this.openDatabase && !this.databaseDirectory.exists) {
      this.databaseDirectory.create({ intermediates: true, idempotent: true })
    }
    const openDatabase = this.openDatabase ?? (await import('expo-sqlite')).openDatabaseAsync
    const database = await openDatabase(
      `attachment-${hashKey(key)}-${++this.databaseSequence}.db`,
      { enableChangeListener: false, useNewConnection: true },
      this.databaseDirectory.uri
    )
    try {
      await database.execAsync('PRAGMA trusted_schema = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;')
      const inspection =
        extension === '.jsonl' || extension === '.ndjson'
          ? await this.importJsonLines(database, file, path, deadline)
          : await this.importDelimited(database, file, path, extension, hasHeader, requestedDelimiter, deadline)
      await database.execAsync('PRAGMA query_only = ON;')
      return {
        key,
        database,
        inspection,
        sourceSize: file.size,
        sourceModificationTime: file.modificationTime
      }
    } catch (error) {
      await database.closeAsync().catch(() => undefined)
      throw error
    }
  }

  private async scanDelimited(
    file: File,
    delimiter: string,
    hasHeader: boolean,
    deadline: number
  ): Promise<DelimitedScan> {
    const iterator = parseDelimitedFile(file, delimiter)
    const first = iterator.next()
    if (first.done) throw new Error('The table attachment is empty.')
    const usedHeaders = new Set<string>()
    const headers = (hasHeader ? first.value : first.value.map((_, index) => `column_${index + 1}`)).map(
      (value, index) => normalizeHeader(value, index, usedHeaders)
    )
    const inferred: InferredType[] = headers.map(() => 'null')
    const nullable: boolean[] = headers.map(() => false)
    const sampleRows: Record<string, unknown>[] = []
    let rowCount = 0

    const consume = (row: string[]) => {
      while (headers.length < row.length) {
        const index = headers.length
        headers.push(normalizeHeader('', index, usedHeaders))
        inferred.push('null')
        nullable.push(true)
      }
      const sample: Record<string, unknown> = {}
      headers.forEach((header, index) => {
        const value = row[index] ?? ''
        const type = inferValue(value)
        inferred[index] = mergeType(inferred[index], type)
        if (type === 'null') nullable[index] = true
        if (sampleRows.length < SAMPLE_ROWS) sample[header] = value.slice(0, SAMPLE_CELL_CHARACTERS)
      })
      if (sampleRows.length < SAMPLE_ROWS) sampleRows.push(sample)
      rowCount++
    }

    if (!hasHeader) consume(first.value)
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      consume(next.value)
      if (rowCount % 2_000 === 0) {
        this.assertActive(deadline)
        await yieldToUi()
      }
    }

    const columns = headers.map<TableColumn>((name, index) => ({
      name,
      inferredType: inferred[index] === 'null' ? 'unknown' : inferred[index],
      sqliteType: sqliteType(inferred[index]),
      nullable: nullable[index] || inferred[index] === 'null'
    }))
    return { delimiter, headers, columns, rowCount, sampleRows }
  }

  private async importDelimited(
    database: SQLiteDatabase,
    file: File,
    path: string,
    extension: string,
    hasHeader: boolean,
    requestedDelimiter: string | undefined,
    deadline: number
  ): Promise<TableInspection> {
    const delimiter = requestedDelimiter ?? detectDelimiter(file, extension)
    const scan = await this.scanDelimited(file, delimiter, hasHeader, deadline)
    const definitions = [quoteIdentifier('_row_number') + ' INTEGER NOT NULL']
      .concat(scan.columns.map(column => `${quoteIdentifier(column.name)} ${column.sqliteType}`))
      .join(', ')
    await database.execAsync(`CREATE TABLE ${quoteIdentifier('data')} (${definitions});`)

    const insertColumns = ['_row_number', ...scan.headers].map(quoteIdentifier).join(', ')
    const placeholders = scan.headers
      .map(() => '?')
      .concat('?')
      .join(', ')
    // Put the row number first while keeping the placeholder count obvious.
    const statement = await database.prepareAsync(
      `INSERT INTO ${quoteIdentifier('data')} (${insertColumns}) VALUES (${placeholders})`
    )
    const iterator = parseDelimitedFile(file, delimiter)
    if (hasHeader) iterator.next()
    let rowNumber = 0
    try {
      await database.withTransactionAsync(async () => {
        for (let next = iterator.next(); !next.done; next = iterator.next()) {
          rowNumber++
          const values: SQLiteBindValue[] = [rowNumber]
          scan.columns.forEach((column, index) => values.push(bindValue(next.value[index] ?? '', column)))
          await statement.executeAsync(values)
          if (rowNumber % 2_000 === 0) {
            this.assertActive(deadline)
            await yieldToUi()
          }
        }
      })
    } finally {
      await statement.finalizeAsync()
    }

    return {
      path,
      format: extension === '.tsv' ? 'tsv' : 'csv',
      delimiter,
      hasHeader,
      rowCount: scan.rowCount,
      columns: [
        { name: '_row_number', inferredType: 'integer', sqliteType: 'INTEGER', nullable: false },
        ...scan.columns
      ],
      sampleRows: scan.sampleRows,
      queryHelp: 'Query the imported table as data. _row_number is a 1-based stable source-row index.'
    }
  }

  private async importJsonLines(
    database: SQLiteDatabase,
    file: File,
    path: string,
    deadline: number
  ): Promise<TableInspection> {
    await database.execAsync(
      `CREATE TABLE ${quoteIdentifier('data')} (${quoteIdentifier('_row_number')} INTEGER NOT NULL, ${quoteIdentifier(
        'json'
      )} TEXT NOT NULL, ${quoteIdentifier('json_valid')} INTEGER NOT NULL);`
    )
    const statement = await database.prepareAsync('INSERT INTO data (_row_number, json, json_valid) VALUES (?, ?, ?)')
    let rowCount = 0
    let invalidJsonRows = 0
    const keys = new Set<string>()
    const sampleRows: Record<string, unknown>[] = []
    try {
      await database.withTransactionAsync(async () => {
        for (const record of parseJsonLinesFile(file)) {
          rowCount++
          let parsed: unknown
          let valid = 1
          try {
            parsed = JSON.parse(record.text)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              Object.keys(parsed)
                .slice(0, 100)
                .forEach(key => {
                  if (keys.size < 200) keys.add(key)
                })
            }
          } catch {
            valid = 0
            invalidJsonRows++
          }
          if (sampleRows.length < SAMPLE_ROWS) {
            sampleRows.push({
              _row_number: rowCount,
              json: record.text.slice(0, SAMPLE_CELL_CHARACTERS),
              json_valid: valid
            })
          }
          await statement.executeAsync([rowCount, record.text, valid])
          if (rowCount % 2_000 === 0) {
            this.assertActive(deadline)
            await yieldToUi()
          }
        }
      })
    } finally {
      await statement.finalizeAsync()
    }
    return {
      path,
      format: 'jsonl',
      hasHeader: false,
      rowCount,
      columns: [
        { name: '_row_number', inferredType: 'integer', sqliteType: 'INTEGER', nullable: false },
        { name: 'json', inferredType: 'text', sqliteType: 'TEXT', nullable: false },
        { name: 'json_valid', inferredType: 'boolean', sqliteType: 'INTEGER', nullable: false }
      ],
      sampleRows,
      invalidJsonRows,
      jsonKeys: [...keys],
      queryHelp:
        "Query data and use SQLite JSON functions, for example: SELECT json_extract(json, '$.field') AS field FROM data WHERE json_valid = 1."
    }
  }

  private async executeBoundedQuery(database: SQLiteDatabase, sql: string, limit: number): Promise<TableQueryResult> {
    this.assertActive()
    const statement = await database.prepareAsync(`SELECT * FROM (${sql}) AS agent_query LIMIT ${limit + 1}`)
    try {
      const columns = await statement.getColumnNamesAsync()
      const result = await statement.executeAsync<Record<string, unknown>>()
      const rows: Record<string, unknown>[] = []
      let bytes = 0
      let truncated = false
      let truncatedCells = 0

      for await (const rawRow of result) {
        if (rows.length >= limit) {
          truncated = true
          break
        }
        const row: Record<string, unknown> = {}
        for (const column of columns) {
          const normalized = normalizeCell(rawRow[column])
          row[column] = normalized.value
          if (normalized.truncated) truncatedCells++
        }
        const rowBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength
        if (bytes + rowBytes > QUERY_MAX_BYTES) {
          truncated = true
          break
        }
        bytes += rowBytes
        rows.push(row)
      }
      return { columns, rows, returnedRows: rows.length, truncated, truncatedCells }
    } finally {
      await statement.finalizeAsync()
    }
  }

  private assertActive(deadline?: number): void {
    if (this.cancelled) throw new Error('Table processing was cancelled because the Agent run ended.')
    if (deadline && Date.now() > deadline) {
      throw new Error('Table import exceeded the 60-second mobile processing limit.')
    }
  }
}
