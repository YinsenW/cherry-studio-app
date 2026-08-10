import type { File } from 'expo-file-system'

import { DelimitedTextParser, detectDelimiter, parseDelimitedFile } from '../DelimitedTextReader'

function mockFile(content: string): File {
  const bytes = new TextEncoder().encode(content)
  return {
    size: bytes.byteLength,
    open() {
      let offset = 0
      return {
        get offset() {
          return offset
        },
        get size() {
          return bytes.byteLength
        },
        readBytes(length: number) {
          const chunk = bytes.slice(offset, offset + length)
          offset += chunk.byteLength
          return chunk
        },
        close() {}
      }
    }
  } as unknown as File
}

describe('DelimitedTextReader', () => {
  it('parses escaped quotes and multiline quoted cells across chunks', () => {
    const parser = new DelimitedTextParser(',')
    const rows = [
      ...parser.push('name,desc\nalpha,"line one'),
      ...parser.push('\nline ""two"""\nbeta,plain'),
      ...parser.finish()
    ]

    expect(rows).toEqual([
      ['name', 'desc'],
      ['alpha', 'line one\nline "two"'],
      ['beta', 'plain']
    ])
  })

  it('streams a multi-megabyte CSV through file handles', () => {
    const content = ['id,value', ...Array.from({ length: 120_000 }, (_, index) => `${index},${index * 2}`)].join('\n')
    const rows = [...parseDelimitedFile(mockFile(content), ',')]

    expect(content.length).toBeGreaterThan(1_000_000)
    expect(rows).toHaveLength(120_001)
    expect(rows[120_000]).toEqual(['119999', '239998'])
  })

  it('detects semicolon-separated CSV', () => {
    expect(detectDelimiter(mockFile('a;b;c\n1;2;3\n4;5;6\n'), '.csv')).toBe(';')
  })
})
