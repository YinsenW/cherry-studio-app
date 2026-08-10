const MAX_SQL_CHARACTERS = 20_000
const BLOCKED_SQL_KEYWORDS = new Set([
  'alter',
  'analyze',
  'attach',
  'begin',
  'commit',
  'create',
  'delete',
  'detach',
  'drop',
  'end',
  'format',
  'group_concat',
  'insert',
  'join',
  'json_group_array',
  'json_group_object',
  'load_extension',
  'pragma',
  'printf',
  'reindex',
  'release',
  'replace',
  'recursive',
  'rollback',
  'savepoint',
  'transaction',
  'update',
  'vacuum',
  'randomblob',
  'zeroblob'
])

type ScannedSql = { words: string[]; semicolons: number; hasParameter: boolean }

function scanSql(source: string): ScannedSql {
  const words: string[] = []
  let token = ''
  let semicolons = 0
  let hasParameter = false
  let quote: "'" | '"' | '`' | ']' | null = null

  const finishToken = () => {
    if (token) words.push(token.toLocaleLowerCase())
    token = ''
  }

  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    const next = source[index + 1]

    if (quote) {
      if (quote === ']' ? character === ']' : character === quote) {
        if (quote !== ']' && next === quote) {
          index++
        } else {
          quote = null
        }
      }
      continue
    }

    if (character === '-' && next === '-') {
      finishToken()
      index += 2
      while (index < source.length && source[index] !== '\n') index++
      continue
    }
    if (character === '/' && next === '*') {
      finishToken()
      const end = source.indexOf('*/', index + 2)
      if (end < 0) throw new Error('SQL contains an unterminated block comment.')
      index = end + 1
      continue
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      finishToken()
      quote = character === '[' ? ']' : character
      continue
    }
    if (/[A-Za-z0-9_]/.test(character)) {
      token += character
      continue
    }

    finishToken()
    if (character === ';') semicolons++
    if (character === '?' || character === '$' || character === ':' || character === '@') hasParameter = true
  }
  if (quote) throw new Error('SQL contains an unterminated quoted value or identifier.')
  finishToken()
  return { words, semicolons, hasParameter }
}

export function validateReadOnlySql(source: string): string {
  if (!source.trim()) throw new Error('table_query requires a non-empty SQL SELECT statement.')
  if (source.length > MAX_SQL_CHARACTERS) throw new Error('SQL exceeds the 20,000-character safety limit.')
  if (source.includes('\0')) throw new Error('SQL contains a null byte.')

  const sql = source.trim().replace(/;\s*$/, '').trim()
  const scanned = scanSql(source)
  if (scanned.semicolons > (source.trim().endsWith(';') ? 1 : 0)) {
    throw new Error('Only one SQL statement is allowed.')
  }
  if (scanned.hasParameter) throw new Error('SQL parameters are not supported by Agent table tools.')
  if (!['select', 'with'].includes(scanned.words[0] ?? '')) {
    throw new Error('Only read-only SELECT or WITH ... SELECT statements are allowed.')
  }
  const blocked = scanned.words.find(word => BLOCKED_SQL_KEYWORDS.has(word))
  if (blocked) throw new Error(`SQL keyword is not allowed in the read-only table sandbox: ${blocked}`)
  return sql
}
