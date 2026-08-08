import type { AgentTool } from '@earendil-works/pi-agent-core'

import type { WorkspaceBackend, WorkspaceMutationContext } from './types'

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false }) as AgentTool['parameters']

const text = (value: unknown) => JSON.stringify(value, null, 2)

// Native file URIs are implementation details. Keep them in the local audit
// record, but never put them in a model-visible tool result.
const publicMutationResult = <T extends { snapshotPath?: string }>(result: T) => {
  const { snapshotPath: _snapshotPath, ...safeResult } = result
  return safeResult
}

function actionError(action: string): never {
  throw new Error(`Unsupported workspace action: ${action}`)
}

export function createMobileWorkspaceTools(
  backend: WorkspaceBackend,
  baseContext: WorkspaceMutationContext = {}
): AgentTool[] {
  const read: AgentTool = {
    name: 'read',
    label: 'read',
    description:
      'Read a UTF-8 text file in the active mobile workspace. Use offset and limit for large files. Binary files are not supported by this text tool.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: 'Path relative to the active workspace' },
        offset: { type: 'number', description: '1-based line number to start reading from' },
        limit: { type: 'number', description: 'Maximum number of lines to return' }
      },
      ['path']
    ),
    executionMode: 'parallel',
    execute: async (_callId, args) => {
      const input = args as { path: string; offset?: number; limit?: number }
      const result = await backend.readText(input.path, input.offset, input.limit)
      const continuation = result.truncated ? `\n\n[Output truncated. Continue with offset=${result.endLine + 1}.]` : ''
      return {
        content: [{ type: 'text', text: result.content + continuation }],
        details: result
      }
    }
  }

  const write: AgentTool = {
    name: 'write',
    label: 'write',
    description:
      'Create or fully rewrite a UTF-8 text file in the active mobile workspace. Parent directories are created automatically. Use edit for targeted changes.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: 'Path relative to the active workspace' },
        content: { type: 'string', description: 'Complete file content' },
        expectedRevision: { type: 'string', description: 'Optional revision returned by read' }
      },
      ['path', 'content']
    ),
    executionMode: 'sequential',
    execute: async (callId, args) => {
      const input = args as { path: string; content: string; expectedRevision?: string }
      const result = await backend.writeText(input.path, input.content, input.expectedRevision, {
        ...baseContext,
        toolCallId: callId
      })
      const safeResult = publicMutationResult(result)
      return {
        content: [
          {
            type: 'text',
            text: `Successfully wrote ${result.bytesWritten} bytes to ${result.path}. Operation: ${result.operationId}`
          }
        ],
        details: safeResult
      }
    }
  }

  const edit: AgentTool = {
    name: 'edit',
    label: 'edit',
    description:
      'Edit one workspace file using exact, unique text replacements. Every oldText must match exactly once and edits must not overlap. The operation is all-or-nothing.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: 'Path relative to the active workspace' },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' }
            },
            required: ['oldText', 'newText'],
            additionalProperties: false
          }
        },
        expectedRevision: { type: 'string', description: 'Optional revision returned by read' }
      },
      ['path', 'edits']
    ),
    executionMode: 'sequential',
    execute: async (callId, args) => {
      const input = args as {
        path: string
        edits: { oldText: string; newText: string }[]
        expectedRevision?: string
      }
      const result = await backend.editText(input.path, input.edits, input.expectedRevision, {
        ...baseContext,
        toolCallId: callId
      })
      const safeResult = publicMutationResult(result)
      return {
        content: [
          {
            type: 'text',
            text: `Successfully applied ${input.edits.length} exact replacement(s) to ${result.path}. Operation: ${result.operationId}${
              result.diff ? `\n${result.diff.slice(0, 20_000)}` : ''
            }`
          }
        ],
        details: safeResult
      }
    }
  }

  const workspace: AgentTool = {
    name: 'workspace',
    label: 'workspace',
    description:
      'Inspect and manage the active mobile workspace without a shell. Actions: pwd, list, tree, stat, search, mkdir, copy, move, trash, restore. Paths are always relative to the workspace; pipes, commands, processes, npm, Python and Git are unavailable.',
    parameters: objectSchema(
      {
        action: {
          type: 'string',
          enum: ['pwd', 'list', 'tree', 'stat', 'search', 'mkdir', 'copy', 'move', 'trash', 'restore']
        },
        path: { type: 'string', description: 'Workspace-relative path' },
        destination: { type: 'string', description: 'Workspace-relative destination path' },
        query: { type: 'string', description: 'Text or regular expression for search' },
        mode: { type: 'string', enum: ['literal', 'regex'] },
        recursive: { type: 'boolean' },
        maxDepth: { type: 'number' },
        maxEntries: { type: 'number' },
        maxResults: { type: 'number' },
        includeHidden: { type: 'boolean' },
        trashPath: { type: 'string', description: 'Trash token returned by a previous trash action' }
      },
      ['action']
    ),
    executionMode: 'sequential',
    execute: async (callId, args) => {
      const input = args as {
        action: string
        path?: string
        destination?: string
        query?: string
        mode?: 'literal' | 'regex'
        recursive?: boolean
        maxDepth?: number
        maxEntries?: number
        maxResults?: number
        includeHidden?: boolean
        trashPath?: string
      }

      switch (input.action) {
        case 'pwd':
          return {
            content: [{ type: 'text', text: text({ path: '.', workspace: backend.descriptor.name }) }],
            details: { path: '.' }
          }
        case 'list':
        case 'tree': {
          const result = await backend.list({
            path: input.path,
            recursive: input.action === 'tree' || input.recursive,
            maxDepth: input.maxDepth,
            maxEntries: input.maxEntries,
            includeHidden: input.includeHidden
          })
          return { content: [{ type: 'text', text: text(result) }], details: { entries: result } }
        }
        case 'stat': {
          const result = await backend.stat(input.path)
          return { content: [{ type: 'text', text: text(result) }], details: result }
        }
        case 'search': {
          if (!input.query) throw new Error('workspace search requires query.')
          const result = await backend.search(input.query, {
            path: input.path,
            mode: input.mode,
            maxResults: input.maxResults,
            includeHidden: input.includeHidden
          })
          return { content: [{ type: 'text', text: text(result) }], details: result }
        }
        case 'mkdir': {
          if (!input.path) throw new Error('workspace mkdir requires path.')
          const result = await backend.mkdir(input.path, { ...baseContext, toolCallId: callId })
          return { content: [{ type: 'text', text: text(result) }], details: result }
        }
        case 'copy': {
          if (!input.path || !input.destination) throw new Error('workspace copy requires path and destination.')
          const result = await backend.copy(input.path, input.destination, { ...baseContext, toolCallId: callId })
          return { content: [{ type: 'text', text: text(result) }], details: result }
        }
        case 'move': {
          if (!input.path || !input.destination) throw new Error('workspace move requires path and destination.')
          const result = await backend.move(input.path, input.destination, { ...baseContext, toolCallId: callId })
          return { content: [{ type: 'text', text: text(result) }], details: result }
        }
        case 'trash': {
          if (!input.path) throw new Error('workspace trash requires path.')
          const result = await backend.trash(input.path, { ...baseContext, toolCallId: callId })
          return { content: [{ type: 'text', text: text(result) }], details: result }
        }
        case 'restore': {
          if (!input.trashPath) throw new Error('workspace restore requires trashPath.')
          const result = await backend.restore(input.trashPath, input.destination, {
            ...baseContext,
            toolCallId: callId
          })
          return { content: [{ type: 'text', text: text(result) }], details: result }
        }
        default:
          return actionError(input.action)
      }
    }
  }

  return [read, write, edit, workspace]
}
