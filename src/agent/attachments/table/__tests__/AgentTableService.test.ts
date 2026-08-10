import type { File } from 'expo-file-system'
import type { SQLiteDatabase } from 'expo-sqlite'

import type { AgentRuntimeBackend } from '@/agent/workspace/AgentRuntimeBackend'

import type { PublicAgentAttachment } from '../../AttachmentManifest'

jest.mock('expo-file-system', () => ({
  Directory: class MockDirectory {
    exists = false
    uri = 'mock://tables'
    create() {
      this.exists = true
    }
  },
  Paths: { cache: 'mock://cache' }
}))

// eslint-disable-next-line import/first
import { AgentTableService } from '../AgentTableService'

function mockFile(content: string): File {
  const bytes = new TextEncoder().encode(content)
  return {
    size: bytes.byteLength,
    modificationTime: 1,
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

function nodeDatabase(): SQLiteDatabase {
  // Node 24's built-in SQLite gives this test a real SQL engine without
  // coupling production code to a desktop dependency.
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => any }
  const database = new DatabaseSync(':memory:')
  const wrapper = {
    async execAsync(source: string) {
      database.exec(source)
    },
    async prepareAsync(source: string) {
      const statement = database.prepare(source)
      const columnNames = () => statement.columns().map((column: { name: string }) => column.name)
      return {
        async getColumnNamesAsync() {
          return columnNames()
        },
        async executeAsync(params: unknown[] = []) {
          const rows = columnNames().length > 0 ? statement.all(...params) : (statement.run(...params), [])
          let index = 0
          return {
            [Symbol.asyncIterator]() {
              return this
            },
            async next() {
              return index < rows.length ? { value: rows[index++], done: false } : { value: undefined, done: true }
            }
          }
        },
        async finalizeAsync() {}
      }
    },
    async withTransactionAsync(task: () => Promise<void>) {
      database.exec('BEGIN')
      try {
        await task()
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    async closeAsync() {
      database.close()
    }
  }
  return wrapper as unknown as SQLiteDatabase
}

const attachment: PublicAgentAttachment = {
  id: 'csv-1',
  name: 'sales.csv',
  logicalPath: 'inputs/current/sales.csv',
  size: 100,
  extension: '.csv',
  kind: 'delimited_table',
  suggestedTools: ['table_inspect', 'table_query']
}

describe('AgentTableService', () => {
  it('imports incrementally, infers schema, executes bounded SELECT and exports CSV', async () => {
    const source = mockFile('region,amount,note,code\nEast,10,"alpha, one",001\nWest,20,beta,002\nEast,15,gamma,003\n')
    const writeText = jest.fn(async (path: string, content: string) => ({
      path,
      bytesWritten: new TextEncoder().encode(content).byteLength,
      operationId: 'export-1',
      revision: { value: '1', size: content.length, modificationTime: 1 }
    }))
    const backend = {
      getInputAttachment: jest.fn(async () => ({ attachment, file: source })),
      writeText
    } as unknown as AgentRuntimeBackend
    const service = new AgentTableService('run-1', backend, async () => nodeDatabase())

    const inspection = await service.inspect({ path: attachment.logicalPath })
    expect(inspection.rowCount).toBe(3)
    expect(inspection.columns).toContainEqual(
      expect.objectContaining({ name: 'amount', inferredType: 'integer', sqliteType: 'INTEGER' })
    )
    expect(inspection.columns).toContainEqual(
      expect.objectContaining({ name: 'code', inferredType: 'text', sqliteType: 'TEXT' })
    )

    const result = await service.query({
      path: attachment.logicalPath,
      sql: 'SELECT region, SUM(amount) AS total FROM data GROUP BY region ORDER BY region'
    })
    expect(result.rows).toEqual([
      { region: 'East', total: 25 },
      { region: 'West', total: 20 }
    ])
    await expect(
      service.query({ path: attachment.logicalPath, sql: 'SELECT * FROM data; DROP TABLE data' })
    ).rejects.toThrow('Only one SQL statement')

    const exported = await service.export({
      path: attachment.logicalPath,
      sql: 'SELECT region, amount FROM data ORDER BY _row_number',
      outputPath: 'outputs/sales-filtered.csv'
    })
    expect(exported.rows).toBe(3)
    expect(writeText).toHaveBeenCalledWith(
      'outputs/sales-filtered.csv',
      'region,amount\nEast,10\nWest,20\nEast,15\n',
      undefined,
      undefined
    )

    await service.dispose()
  })
})
