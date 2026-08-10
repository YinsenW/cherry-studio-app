const mockPresentDialog = jest.fn()

jest.mock('@/componentsV2/base/Dialog/useDialogManager', () => ({
  presentDialog: (...args: unknown[]) => mockPresentDialog(...args)
}))

// The dialog mock must be registered before this module is evaluated.
// eslint-disable-next-line import/first
import { ToolApprovalCoordinator } from '../ToolApprovalCoordinator'

const context = (name: string, args: unknown, isPrivate = false) =>
  ({
    toolCall: { name },
    args,
    context: {
      systemPrompt: `mobile contract workspace-id:workspace-test workspace-private:${isPrivate ? 'true' : 'false'}`
    }
  }) as any

const flushDynamicImport = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('ToolApprovalCoordinator', () => {
  beforeEach(() => mockPresentDialog.mockReset())

  it('allows reads without prompting and scopes mutation approval to one session', async () => {
    const coordinator = new ToolApprovalCoordinator()

    await expect(coordinator.beforeToolCall(context('read', { path: 'notes.md' }))).resolves.toBeUndefined()
    await expect(coordinator.beforeToolCall(context('getCurrentTime', {}))).resolves.toBeUndefined()
    expect(mockPresentDialog).not.toHaveBeenCalled()

    const firstWrite = coordinator.beforeToolCall(context('write', { path: 'notes.md' }))
    await flushDynamicImport()
    expect(mockPresentDialog).toHaveBeenCalledTimes(1)
    await mockPresentDialog.mock.calls[0][1].onConfirm()
    await expect(firstWrite).resolves.toBeUndefined()

    await expect(coordinator.beforeToolCall(context('edit', { path: 'notes.md' }))).resolves.toBeUndefined()
    expect(mockPresentDialog).toHaveBeenCalledTimes(1)

    coordinator.clearSessionAllowances()
    const nextWrite = coordinator.beforeToolCall(context('write', { path: 'notes.md' }))
    await flushDynamicImport()
    expect(mockPresentDialog).toHaveBeenCalledTimes(2)
    await mockPresentDialog.mock.calls[1][1].onCancel()
    await expect(nextWrite).resolves.toMatchObject({ block: true })
  })

  it('always prompts destructive workspace actions', async () => {
    const coordinator = new ToolApprovalCoordinator()
    const trash = coordinator.beforeToolCall(context('workspace', { action: 'trash', path: 'notes.md' }))
    await flushDynamicImport()
    expect(mockPresentDialog.mock.calls[0][1]).toMatchObject({
      title: expect.any(String),
      confirmText: expect.any(String),
      cancelText: expect.any(String)
    })
    await mockPresentDialog.mock.calls[0][1].onConfirm()
    await expect(trash).resolves.toBeUndefined()

    const move = coordinator.beforeToolCall(context('workspace', { action: 'move', path: 'notes.md' }))
    await flushDynamicImport()
    expect(mockPresentDialog).toHaveBeenCalledTimes(2)
    await mockPresentDialog.mock.calls[1][1].onCancel()
    await expect(move).resolves.toMatchObject({ block: true })
  })

  it('does not interrupt private runtime mutations with user-facing folder approvals', async () => {
    const coordinator = new ToolApprovalCoordinator()
    await expect(coordinator.beforeToolCall(context('write', { path: 'state/plan.md' }, true))).resolves.toBeUndefined()
    await expect(
      coordinator.beforeToolCall(context('bash', { command: 'rm scratch/temp.txt' }, true))
    ).resolves.toBeUndefined()
    await expect(
      coordinator.beforeToolCall(context('publish_file', { path: 'outputs/report.txt' }, true))
    ).resolves.toBeUndefined()
    expect(mockPresentDialog).not.toHaveBeenCalled()
  })
})
