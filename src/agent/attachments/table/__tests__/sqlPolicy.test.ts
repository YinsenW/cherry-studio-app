import { validateReadOnlySql } from '../sqlPolicy'

describe('validateReadOnlySql', () => {
  it('accepts SELECT and CTE queries', () => {
    expect(validateReadOnlySql('SELECT "delete" FROM data;')).toBe('SELECT "delete" FROM data')
    expect(validateReadOnlySql('WITH totals AS (SELECT sum(amount) total FROM data) SELECT * FROM totals')).toContain(
      'WITH totals'
    )
  })

  it.each([
    'DELETE FROM data',
    'SELECT * FROM data; DROP TABLE data',
    'WITH source AS (SELECT * FROM data) UPDATE data SET value = 1',
    'PRAGMA table_info(data)',
    "SELECT load_extension('bad')",
    'SELECT * FROM data AS left JOIN data AS right ON left.id = right.id',
    'SELECT randomblob(1000000000)',
    'WITH RECURSIVE sequence AS (SELECT 1 UNION ALL SELECT 1 FROM sequence) SELECT * FROM sequence',
    'SELECT * FROM data WHERE value = ?'
  ])('rejects unsafe SQL: %s', sql => {
    expect(() => validateReadOnlySql(sql)).toThrow()
  })

  it('ignores blocked words inside literals and comments', () => {
    expect(validateReadOnlySql("SELECT 'DROP TABLE data' AS note FROM data -- DELETE\n")).toContain('SELECT')
  })
})
