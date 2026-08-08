import { tool } from 'ai'
import { Buffer } from 'buffer'
import dayjs from 'dayjs'
import * as Localization from 'expo-localization'
import { z } from 'zod'

/**
 * 计算 / 数据处理工具组。
 *
 * 在 Android 上不能跑 npm / Python，但这些"算力"工具让 agent
 * 在 App 进程内直接处理数据：JSON、正则、编码、字符串、日期、diff。
 * 全部纯 JS，零原生依赖，零权限。
 */

export const parseJson = tool({
  description:
    'Parse a JSON string into a pretty-printed JSON structure. Use when you need to inspect or reformat JSON data.',
  inputSchema: z.object({
    json: z.string().describe('The JSON string to parse')
  }),
  execute: async ({ json }) => {
    try {
      const parsed = JSON.parse(json)
      return { ok: true, result: JSON.stringify(parsed, null, 2) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
})

export const jsonQuery = tool({
  description:
    'Extract a value from a JSON object using a dot path (e.g. "items.0.title" for {"items":[{"title":"x"}]}). Returns the found value or an error.',
  inputSchema: z.object({
    json: z.string().describe('The JSON string to query'),
    path: z.string().describe('Dot-separated path, e.g. "user.profile.name" or "items.0.id"')
  }),
  execute: async ({ json, path }) => {
    try {
      const parsed = JSON.parse(json)
      const segments = path.split('.').filter(Boolean)
      let current: unknown = parsed
      for (const seg of segments) {
        if (current === null || current === undefined) {
          return { ok: false, error: `Path "${path}" not found` }
        }
        current = (current as Record<string, unknown>)[seg]
      }
      return { ok: true, result: JSON.stringify(current, null, 2) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
})

export const regexMatch = tool({
  description: 'Match text with a regular expression and return all matches. Useful for extracting patterns from text.',
  inputSchema: z.object({
    text: z.string().describe('The text to search in'),
    pattern: z.string().describe('The regular expression pattern, e.g. "\\\\d{4}-\\\\d{2}-\\\\d{2}" for dates'),
    flags: z.string().optional().describe('RegExp flags, e.g. "g" for global, "gi" for global case-insensitive')
  }),
  execute: async ({ text, pattern, flags }) => {
    try {
      const re = new RegExp(pattern, flags ?? '')
      const matches: string[] = []
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        matches.push(m[0])
        if (m.index === re.lastIndex) re.lastIndex++
      }
      return { ok: true, count: matches.length, matches: matches.slice(0, 100) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
})

export const regexReplace = tool({
  description: 'Replace text matching a regular expression with a replacement string.',
  inputSchema: z.object({
    text: z.string().describe('The text to modify'),
    pattern: z.string().describe('The regular expression pattern to match'),
    replacement: z.string().describe('The replacement string, $1 etc. for capture groups'),
    flags: z.string().optional().describe('RegExp flags, e.g. "g"')
  }),
  execute: async ({ text, pattern, replacement, flags }) => {
    try {
      const re = new RegExp(pattern, flags ?? '')
      return { ok: true, result: text.replace(re, replacement) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
})

export const base64Encode = tool({
  description: 'Encode a text string to base64.',
  inputSchema: z.object({ text: z.string().describe('The text to encode') }),
  execute: async ({ text }) => {
    return { ok: true, result: Buffer.from(text, 'utf-8').toString('base64') }
  }
})

export const base64Decode = tool({
  description: 'Decode a base64 string to text.',
  inputSchema: z.object({ base64: z.string().describe('The base64 string to decode') }),
  execute: async ({ base64 }) => {
    try {
      return { ok: true, result: Buffer.from(base64, 'base64').toString('utf-8') }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
})

export const urlEncode = tool({
  description: 'Encode text for safe use in a URL query string.',
  inputSchema: z.object({ text: z.string().describe('The text to URL-encode') }),
  execute: async ({ text }) => ({ ok: true, result: encodeURIComponent(text) })
})

export const urlDecode = tool({
  description: 'Decode a URL-encoded string back to plain text.',
  inputSchema: z.object({ text: z.string().describe('The URL-encoded text') }),
  execute: async ({ text }) => {
    try {
      return { ok: true, result: decodeURIComponent(text) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
})

export const splitText = tool({
  description: 'Split a text by a delimiter and return the parts. Useful for CSV-like or line-based data.',
  inputSchema: z.object({
    text: z.string().describe('The text to split'),
    delimiter: z.string().describe('The delimiter, e.g. "\\n", ",", "\\t"'),
    limit: z.number().optional().describe('Maximum number of parts to return')
  }),
  execute: async ({ text, delimiter, limit }) => {
    const parts = text.split(delimiter)
    const sliced = limit ? parts.slice(0, limit) : parts
    return { ok: true, count: parts.length, parts: sliced }
  }
})

export const toUpperCase = tool({
  description: 'Convert text to uppercase.',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ ok: true, result: text.toUpperCase() })
})

export const toLowerCase = tool({
  description: 'Convert text to lowercase.',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ ok: true, result: text.toLowerCase() })
})

export const trimText = tool({
  description: 'Trim leading and trailing whitespace from text.',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ ok: true, result: text.trim() })
})

export const substring = tool({
  description:
    'Extract a substring of text from start (inclusive) to end (exclusive). Negative indexes count from the end.',
  inputSchema: z.object({
    text: z.string().describe('The text'),
    start: z.number().describe('Start index'),
    end: z.number().optional().describe('End index (exclusive)')
  }),
  execute: async ({ text, start, end }) => ({ ok: true, result: text.substring(start, end) })
})

export const length = tool({
  description: 'Get the character length of a text.',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ ok: true, length: text.length })
})

export const now = tool({
  description:
    'Get the current date and time in ISO format, plus the device timezone and a human-readable local string.',
  inputSchema: z.object({}),
  execute: async () => {
    const now = new Date()
    const locale = Localization.getLocales()[0] as { timeZone?: string | null } | undefined
    return {
      iso: now.toISOString(),
      local: now.toLocaleString(),
      timezone: locale?.timeZone ?? 'unknown',
      deviceTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
    }
  }
})

export const formatDate = tool({
  description:
    'Format a date/time into a readable string. Provide an ISO date string and a dayjs format (e.g. "YYYY-MM-DD HH:mm").',
  inputSchema: z.object({
    iso: z.string().describe('ISO 8601 date string'),
    format: z.string().optional().describe('dayjs format, default "YYYY-MM-DD HH:mm"')
  }),
  execute: async ({ iso, format }) => {
    const d = dayjs(iso)
    if (!d.isValid()) return { ok: false, error: 'Invalid date' }
    return { ok: true, result: d.format(format ?? 'YYYY-MM-DD HH:mm') }
  }
})

export const dateDiff = tool({
  description: 'Compute the difference between two ISO dates. Returns days/hours/minutes and a readable description.',
  inputSchema: z.object({
    from: z.string().describe('Start ISO date'),
    to: z.string().describe('End ISO date')
  }),
  execute: async ({ from, to }) => {
    const a = dayjs(from)
    const b = dayjs(to)
    if (!a.isValid() || !b.isValid()) return { ok: false, error: 'Invalid date' }
    const diffMs = b.diff(a)
    const days = Math.floor(diffMs / 86400000)
    const hours = Math.floor((diffMs % 86400000) / 3600000)
    const minutes = Math.floor((diffMs % 3600000) / 60000)
    const abs = Math.abs
    return {
      ok: true,
      days: abs(days),
      hours: abs(hours),
      minutes: abs(minutes),
      description: `${diffMs < 0 ? '-' : ''}${abs(days)}d ${abs(hours)}h ${abs(minutes)}m`
    }
  }
})

export const addToDate = tool({
  description:
    'Add a duration to an ISO date. Amount can be negative. Unit: day, hour, minute, week, month, year. Returns the new ISO date.',
  inputSchema: z.object({
    iso: z.string().describe('Base ISO date'),
    amount: z.number().describe('Amount to add (can be negative)'),
    unit: z.enum(['day', 'hour', 'minute', 'week', 'month', 'year']).describe('Unit of the amount')
  }),
  execute: async ({ iso, amount, unit }) => {
    const d = dayjs(iso)
    if (!d.isValid()) return { ok: false, error: 'Invalid date' }
    return { ok: true, result: d.add(amount, unit as dayjs.ManipulateType).toISOString() }
  }
})

export const textDiff = tool({
  description:
    'Compare two texts line by line and return the differences (lines added/removed). Useful for showing what changed.',
  inputSchema: z.object({
    before: z.string().describe('The original text'),
    after: z.string().describe('The new text')
  }),
  execute: async ({ before, after }) => {
    const a = before.split('\n')
    const b = after.split('\n')
    const added: string[] = []
    const removed: string[] = []
    // 简单 LCS 差分（行级）
    const n = a.length
    const m = b.length
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        removed.push(a[i++])
      } else {
        added.push(b[j++])
      }
    }
    while (i < n) removed.push(a[i++])
    while (j < m) added.push(b[j++])
    return {
      ok: true,
      addedCount: added.length,
      removedCount: removed.length,
      added: added.slice(0, 50),
      removed: removed.slice(0, 50)
    }
  }
})

export const ComputeTool = {
  ParseJson: parseJson,
  JsonQuery: jsonQuery,
  RegexMatch: regexMatch,
  RegexReplace: regexReplace,
  Base64Encode: base64Encode,
  Base64Decode: base64Decode,
  UrlEncode: urlEncode,
  UrlDecode: urlDecode,
  SplitText: splitText,
  ToUpperCase: toUpperCase,
  ToLowerCase: toLowerCase,
  TrimText: trimText,
  Substring: substring,
  TextLength: length,
  Now: now,
  FormatDate: formatDate,
  DateDiff: dateDiff,
  AddToDate: addToDate,
  TextDiff: textDiff
}

export type ComputeToolKeys = keyof typeof ComputeTool
