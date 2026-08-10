import type { AgentTool } from '@earendil-works/pi-agent-core'

import type { WorkspaceBackend, WorkspaceMutationContext } from './types'

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false }) as AgentTool['parameters']

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: 'single' | 'double' | null = null
  let escaping = false

  const finishToken = () => {
    if (!token) return
    tokens.push(token)
    token = ''
  }

  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (escaping) {
      token += character
      escaping = false
      continue
    }
    if (character === '\\' && quote !== 'single') {
      escaping = true
      continue
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single'
      continue
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double'
      continue
    }
    if (!quote && /\s/.test(character)) {
      finishToken()
      continue
    }
    if (!quote && [';', '&', '|', '<', '>', '`'].includes(character)) {
      throw new Error('Pipes, redirection, command substitution and command chaining are unavailable on mobile.')
    }
    if (!quote && character === '$' && command[index + 1] === '(') {
      throw new Error('Command substitution is unavailable on mobile.')
    }
    token += character
  }

  if (escaping || quote) throw new Error('The mobile command contains an unfinished escape or quote.')
  finishToken()
  if (tokens.length === 0) throw new Error('bash requires a command.')
  return tokens
}

function parseCount(args: string[], fallback: number): { count: number; rest: string[] } {
  if (args[0] === '-n') {
    const count = Number(args[1])
    if (!Number.isInteger(count) || count < 1 || count > 2_000) {
      throw new Error('-n must be an integer between 1 and 2000.')
    }
    return { count, rest: args.slice(2) }
  }
  const compact = /^-(\d+)$/.exec(args[0] ?? '')
  if (compact) return { count: Math.min(2_000, Math.max(1, Number(compact[1]))), rest: args.slice(1) }
  return { count: fallback, rest: args }
}

function requireArgs(command: string, args: string[], count: number): void {
  if (args.length !== count) throw new Error(`${command} expects ${count} argument(s).`)
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/**
 * Compatibility surface for Pi's fourth primitive. It never invokes an OS
 * shell: each accepted command is translated into the structured workspace
 * backend, and all other syntax fails closed.
 */
export function createMobileBashTool(backend: WorkspaceBackend, baseContext: WorkspaceMutationContext = {}): AgentTool {
  return {
    name: 'bash',
    label: 'bash',
    description:
      'Run one allowlisted mobile workspace command without an OS shell. Supported: pwd, ls, tree, find, cat, head, tail, grep/rg, wc, stat, mkdir, touch, cp, mv, rm. Pipes, redirects, processes, scripts, package managers, network commands and arbitrary executables are unavailable.',
    parameters: objectSchema(
      {
        command: {
          type: 'string',
          description: 'One allowlisted command operating only on logical Agent workspace paths'
        }
      },
      ['command']
    ),
    executionMode: 'sequential',
    execute: async (callId, rawArgs) => {
      const { command } = rawArgs as { command: string }
      if (typeof command !== 'string' || command.length > 4_000) {
        throw new Error('bash command must be a string no longer than 4000 characters.')
      }
      const [program, ...argv] = tokenize(command)
      const context = { ...baseContext, toolCallId: callId }
      let result: unknown

      switch (program) {
        case 'pwd':
          requireArgs(program, argv, 0)
          result = { path: '.', mounts: ['inputs', 'state', 'scratch', 'outputs'] }
          break
        case 'ls': {
          const filtered = argv.filter(argument => !/^-[a-zA-Z]+$/.test(argument))
          if (filtered.length > 1) throw new Error('ls accepts at most one path.')
          result = await backend.list({ path: filtered[0] ?? '.', maxEntries: 500 })
          break
        }
        case 'tree':
        case 'find': {
          const filtered = argv.filter(argument => argument !== '-type' && argument !== 'f')
          if (filtered.length > 1) throw new Error(`${program} accepts at most one path.`)
          result = await backend.list({
            path: filtered[0] ?? '.',
            recursive: true,
            maxDepth: 20,
            maxEntries: 2_000
          })
          break
        }
        case 'cat': {
          if (argv.length === 0 || argv.length > 20) throw new Error('cat expects between 1 and 20 files.')
          const parts: string[] = []
          for (const path of argv) {
            const read = await backend.readText(path)
            parts.push(argv.length > 1 ? `==> ${read.path} <==\n${read.content}` : read.content)
            if (read.truncated) parts.push(`[${read.path} truncated; continue with read offset=${read.endLine + 1}]`)
          }
          result = parts.join('\n')
          break
        }
        case 'head': {
          const parsed = parseCount(argv, 10)
          requireArgs(program, parsed.rest, 1)
          result = (await backend.readText(parsed.rest[0], 1, parsed.count)).content
          break
        }
        case 'tail': {
          const parsed = parseCount(argv, 10)
          requireArgs(program, parsed.rest, 1)
          const probe = await backend.readText(parsed.rest[0], 1, 1)
          const offset = Math.max(1, probe.totalLines - parsed.count + 1)
          result = (await backend.readText(parsed.rest[0], offset, parsed.count)).content
          break
        }
        case 'grep':
        case 'rg': {
          const filtered = argv.filter(argument => argument !== '-n' && argument !== '-i')
          if (filtered.length < 1 || filtered.length > 2)
            throw new Error(`${program} expects a query and optional path.`)
          result = await backend.search(filtered[0], { path: filtered[1] ?? '.', maxResults: 100 })
          break
        }
        case 'wc': {
          const mode = argv[0]?.startsWith('-') ? argv.shift() : undefined
          requireArgs(program, argv, 1)
          const stat = await backend.stat(argv[0])
          if (stat.kind !== 'file') throw new Error('wc requires a file.')
          const probe = await backend.readText(argv[0], 1, 1)
          result =
            mode === '-c'
              ? { bytes: stat.size ?? probe.size, path: probe.path }
              : { lines: probe.totalLines, bytes: stat.size ?? probe.size, path: probe.path }
          break
        }
        case 'stat':
          requireArgs(program, argv, 1)
          result = await backend.stat(argv[0])
          break
        case 'mkdir': {
          const filtered = argv.filter(argument => argument !== '-p')
          requireArgs(program, filtered, 1)
          result = await backend.mkdir(filtered[0], context)
          break
        }
        case 'touch': {
          requireArgs(program, argv, 1)
          try {
            result = await backend.stat(argv[0])
          } catch {
            result = await backend.writeText(argv[0], '', undefined, context)
          }
          break
        }
        case 'cp':
          requireArgs(program, argv, 2)
          result = await backend.copy(argv[0], argv[1], context)
          break
        case 'mv':
          requireArgs(program, argv, 2)
          result = await backend.move(argv[0], argv[1], context)
          break
        case 'rm': {
          const filtered = argv.filter(argument => !/^-[a-zA-Z]+$/.test(argument))
          requireArgs(program, filtered, 1)
          result = await backend.trash(filtered[0], context)
          break
        }
        default:
          throw new Error(`UNSUPPORTED_COMMAND: ${program}`)
      }

      const output = typeof result === 'string' ? result : json(result)
      return { content: [{ type: 'text', text: output }], details: result }
    }
  }
}
