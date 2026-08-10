import { AgentRuntimeBackend } from '../AgentRuntimeBackend'
import type { WorkspaceBackend } from '../types'

const makeBackend = (id: string, readOnly = false) =>
  ({
    descriptor: {
      id,
      name: id,
      kind: 'app_sandbox',
      rootUri: '',
      readOnly,
      createdAt: 1,
      updatedAt: 1
    },
    capabilities: { persistent: true, readOnly, supportsMove: true, supportsTrash: true },
    ensureReady: jest.fn(async () => undefined),
    readText: jest.fn(async (path: string) => ({
      path,
      content: 'hello',
      revision: { value: 'rev-1', size: 5, modificationTime: null },
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
      size: 5
    })),
    writeText: jest.fn(async (path: string, content: string) => ({
      path,
      revision: { value: 'rev-2', size: content.length, modificationTime: null },
      bytesWritten: content.length,
      operationId: 'write-1'
    })),
    editText: jest.fn(),
    list: jest.fn(async () => []),
    stat: jest.fn(async (path: string) => ({ path, name: path, kind: 'file', size: 5, exists: true })),
    search: jest.fn(async (query: string) => ({ query, matches: [], truncated: false, scannedFiles: 0 })),
    mkdir: jest.fn(async (path: string) => ({ path, operationId: 'mkdir-1' })),
    copy: jest.fn(),
    move: jest.fn(),
    trash: jest.fn(),
    restore: jest.fn()
  }) as unknown as WorkspaceBackend

describe('AgentRuntimeBackend mounts', () => {
  it('routes bare files to durable state and keeps inputs read-only', async () => {
    const inputs = makeBackend('inputs', true)
    const state = makeBackend('state')
    const scratch = makeBackend('scratch')
    const outputs = makeBackend('outputs')
    const backend = new AgentRuntimeBackend({
      runId: 'run-test',
      inputs: inputs as never,
      state: state as never,
      scratch: scratch as never,
      outputs: outputs as never
    })

    const write = await backend.writeText('plan.md', 'hello')
    expect(state.writeText).toHaveBeenCalledWith('plan.md', 'hello', undefined, undefined)
    expect(write.path).toBe('state/plan.md')

    await expect(backend.writeText('inputs/current/source.txt', 'changed')).rejects.toThrow('read-only')
    expect(inputs.writeText).not.toHaveBeenCalled()
  })

  it('exposes only logical mount paths when listing and searching', async () => {
    const inputs = makeBackend('inputs', true)
    const state = makeBackend('state')
    const scratch = makeBackend('scratch')
    const outputs = makeBackend('outputs')
    ;(outputs.list as jest.Mock).mockResolvedValue([{ path: 'report.txt', name: 'report.txt', kind: 'file', size: 10 }])
    ;(state.search as jest.Mock).mockResolvedValue({
      query: 'todo',
      matches: [{ path: 'plan.md', line: 1, text: 'todo' }],
      truncated: false,
      scannedFiles: 1
    })
    const backend = new AgentRuntimeBackend({
      runId: 'run-test',
      inputs: inputs as never,
      state: state as never,
      scratch: scratch as never,
      outputs: outputs as never
    })

    expect((await backend.list()).map(entry => entry.path)).toEqual(['inputs', 'state', 'scratch', 'outputs'])
    expect(await backend.listOutputFiles()).toEqual(['outputs/report.txt'])
    expect((await backend.search('todo')).matches).toContainEqual({
      path: 'state/plan.md',
      line: 1,
      text: 'todo'
    })
    expect(JSON.stringify(await backend.list())).not.toContain('file://')
  })
})
