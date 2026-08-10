import type { File } from 'expo-file-system'

const READ_CHUNK_BYTES = 64 * 1024
const MAX_TABLE_FILE_BYTES = 256 * 1024 * 1024
const MAX_FIELD_CHARACTERS = 1 * 1024 * 1024
const MAX_COLUMNS = 1_000
const MAX_ROWS = 1_000_000
const MAX_JSON_LINE_CHARACTERS = 4 * 1024 * 1024

export type DelimitedTextLimits = {
  maxRows?: number
  maxColumns?: number
  maxFieldCharacters?: number
}

export const DEFAULT_TABLE_LIMITS = {
  maxFileBytes: MAX_TABLE_FILE_BYTES,
  maxRows: MAX_ROWS,
  maxColumns: MAX_COLUMNS,
  maxFieldCharacters: MAX_FIELD_CHARACTERS
} as const

export class DelimitedTextParser {
  private readonly maxRows: number
  private readonly maxColumns: number
  private readonly maxFieldCharacters: number
  private field = ''
  private row: string[] = []
  private inQuotes = false
  private quotePending = false
  private skipLineFeed = false
  private touched = false
  private rowCount = 0

  constructor(
    private readonly delimiter: string,
    limits: DelimitedTextLimits = {}
  ) {
    if (delimiter.length !== 1) throw new Error('A delimited table separator must be exactly one character.')
    this.maxRows = Math.max(1, limits.maxRows ?? MAX_ROWS)
    this.maxColumns = Math.max(1, limits.maxColumns ?? MAX_COLUMNS)
    this.maxFieldCharacters = Math.max(1, limits.maxFieldCharacters ?? MAX_FIELD_CHARACTERS)
  }

  push(chunk: string): string[][] {
    const emitted: string[][] = []
    for (let index = 0; index < chunk.length; index++) {
      const character = chunk[index]
      if (this.skipLineFeed) {
        this.skipLineFeed = false
        if (character === '\n') continue
      }

      if (this.inQuotes) {
        if (this.quotePending) {
          if (character === '"') {
            this.append('"')
            this.quotePending = false
            continue
          }
          this.quotePending = false
          this.inQuotes = false
          // The current character is structural and is processed below.
        } else if (character === '"') {
          this.quotePending = true
          continue
        } else {
          this.append(character)
          continue
        }
      }

      if (character === '"' && this.field.length === 0) {
        this.inQuotes = true
        this.touched = true
      } else if (character === this.delimiter) {
        this.finishField()
      } else if (character === '\n' || character === '\r') {
        emitted.push(this.finishRow())
        if (character === '\r') this.skipLineFeed = true
      } else {
        this.append(character)
      }
    }
    return emitted
  }

  finish(): string[][] {
    if (this.inQuotes && !this.quotePending) {
      throw new Error('The delimited table contains an unterminated quoted field.')
    }
    this.inQuotes = false
    this.quotePending = false
    if (!this.touched && this.field.length === 0 && this.row.length === 0) return []
    return [this.finishRow()]
  }

  private append(value: string): void {
    if (this.field.length + value.length > this.maxFieldCharacters) {
      throw new Error(`A table field exceeds the ${this.maxFieldCharacters}-character safety limit.`)
    }
    this.field += value
    this.touched = true
  }

  private finishField(): void {
    if (this.row.length >= this.maxColumns) {
      throw new Error(`The table exceeds the ${this.maxColumns}-column safety limit.`)
    }
    this.row.push(this.field)
    this.field = ''
    this.touched = true
  }

  private finishRow(): string[] {
    this.finishField()
    const completed = this.row
    this.row = []
    this.touched = false
    this.rowCount++
    if (this.rowCount > this.maxRows) {
      throw new Error(`The table exceeds the ${this.maxRows}-row safety limit.`)
    }
    return completed
  }
}

function assertFileSize(file: File): void {
  if (file.size > MAX_TABLE_FILE_BYTES) {
    throw new Error(`Table attachments are limited to ${MAX_TABLE_FILE_BYTES / 1024 / 1024} MiB on mobile.`)
  }
}

function* decodedChunks(file: File): Generator<string> {
  assertFileSize(file)
  const handle = file.open()
  const decoder = new TextDecoder('utf-8')
  let firstChunk = true
  try {
    while ((handle.offset ?? 0) < (handle.size ?? file.size)) {
      const remaining = (handle.size ?? file.size) - (handle.offset ?? 0)
      const bytes = handle.readBytes(Math.min(READ_CHUNK_BYTES, remaining))
      if (bytes.byteLength === 0) break
      let decoded = decoder.decode(bytes, { stream: true })
      if (firstChunk) {
        firstChunk = false
        if (decoded.charCodeAt(0) === 0xfeff) decoded = decoded.slice(1)
      }
      if (decoded) yield decoded
    }
    const final = decoder.decode()
    if (final) yield final
  } finally {
    handle.close()
  }
}

export function* parseDelimitedFile(
  file: File,
  delimiter: string,
  limits: DelimitedTextLimits = {}
): Generator<string[]> {
  const parser = new DelimitedTextParser(delimiter, limits)
  for (const chunk of decodedChunks(file)) {
    for (const row of parser.push(chunk)) yield row
  }
  for (const row of parser.finish()) yield row
}

export function* parseJsonLinesFile(file: File): Generator<{ lineNumber: number; text: string }> {
  let buffered = ''
  let lineNumber = 0
  let skipLineFeed = false
  const emitLine = function* (line: string) {
    if (line.length > MAX_JSON_LINE_CHARACTERS) {
      throw new Error(`A JSONL record exceeds the ${MAX_JSON_LINE_CHARACTERS}-character safety limit.`)
    }
    lineNumber++
    if (lineNumber > MAX_ROWS) throw new Error(`The table exceeds the ${MAX_ROWS}-row safety limit.`)
    if (line.trim()) yield { lineNumber, text: line }
  }

  for (const chunk of decodedChunks(file)) {
    let cursor = 0
    for (let index = 0; index < chunk.length; index++) {
      const character = chunk[index]
      if (skipLineFeed) {
        skipLineFeed = false
        if (character === '\n') {
          cursor = index + 1
          continue
        }
      }
      if (character !== '\n' && character !== '\r') continue
      buffered += chunk.slice(cursor, index)
      yield* emitLine(buffered)
      buffered = ''
      if (character === '\r') skipLineFeed = true
      cursor = index + 1
    }
    buffered += chunk.slice(cursor)
    if (buffered.length > MAX_JSON_LINE_CHARACTERS) {
      throw new Error(`A JSONL record exceeds the ${MAX_JSON_LINE_CHARACTERS}-character safety limit.`)
    }
  }
  if (buffered.trim()) yield* emitLine(buffered)
}

function readSample(file: File, bytes = READ_CHUNK_BYTES): string {
  assertFileSize(file)
  const handle = file.open()
  try {
    const sample = handle.readBytes(Math.min(bytes, handle.size ?? file.size))
    return new TextDecoder('utf-8').decode(sample).replace(/^\uFEFF/, '')
  } finally {
    handle.close()
  }
}

/** Picks the separator with the most consistent positive field count. */
export function detectDelimiter(file: File, extension: string): string {
  if (extension.toLocaleLowerCase() === '.tsv') return '\t'
  const sample = readSample(file)
  const candidates = [',', '\t', ';', '|']
  let best = { delimiter: ',', score: -1 }

  for (const delimiter of candidates) {
    const parser = new DelimitedTextParser(delimiter)
    let rows: string[][]
    try {
      rows = parser.push(sample).slice(0, 25)
    } catch {
      continue
    }
    const widths = rows.map(row => row.length).filter(width => width > 1)
    if (widths.length === 0) continue
    const frequencies = new Map<number, number>()
    widths.forEach(width => frequencies.set(width, (frequencies.get(width) ?? 0) + 1))
    const consistency = Math.max(...frequencies.values())
    const commonWidth = [...frequencies].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 1
    const score = consistency * 1_000 + commonWidth
    if (score > best.score) best = { delimiter, score }
  }

  return best.delimiter
}
