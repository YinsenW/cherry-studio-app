import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'

import { presentDialog } from '@/componentsV2/base/Dialog/useDialogManager'
import i18n from '@/i18n'
import { loggerService } from '@/services/LoggerService'

const logger = loggerService.withContext('ToolApprovalCoordinator')

type ApprovalDecision = 'allow' | 'deny'

type ApprovalRequest = {
  toolName: string
  args: unknown
  workspaceId: string
  destructive: boolean
}

function isReadOnlyTool(name: string, args: any): boolean {
  if (name === 'read') return true
  if (name !== 'workspace') return false
  return ['pwd', 'list', 'tree', 'stat', 'search'].includes(args?.action)
}

function isMobileWorkspaceTool(name: string): boolean {
  return name === 'read' || name === 'write' || name === 'edit' || name === 'workspace'
}

function isDestructiveTool(name: string, args: any): boolean {
  return name === 'workspace' && ['move', 'trash', 'restore'].includes(args?.action)
}

/**
 * One approval gate for mobile workspace mutations. The coordinator uses the
 * lightweight dialog state API; the visual DialogManager remains mounted by
 * the app shell, while agent/backend modules stay independent of heavy UI
 * component imports.
 */
export class ToolApprovalCoordinator {
  private readonly sessionAllowances = new Set<string>()
  private pending: Promise<ApprovalDecision> | null = null

  clearSessionAllowances(): void {
    this.sessionAllowances.clear()
  }

  async beforeToolCall(
    context: BeforeToolCallContext,
    signal?: AbortSignal
  ): Promise<BeforeToolCallResult | undefined> {
    const name = context.toolCall.name
    const args = context.args as any
    if (!isMobileWorkspaceTool(name)) return undefined
    if (isReadOnlyTool(name, args)) return undefined

    const workspaceId = this.workspaceIdFromContext(context) ?? 'default-mobile-workspace'
    const destructive = isDestructiveTool(name, args)
    const allowanceKey = `${workspaceId}:${destructive ? 'destructive' : 'mutation'}`
    if (!destructive && this.sessionAllowances.has(allowanceKey)) return undefined

    const decision = await this.request({ toolName: name, args, workspaceId, destructive }, signal)
    if (decision === 'allow') {
      if (!destructive) this.sessionAllowances.add(allowanceKey)
      return undefined
    }
    return { block: true, reason: 'The user declined this mobile workspace operation.' }
  }

  private workspaceIdFromContext(context: BeforeToolCallContext): string | undefined {
    const systemPrompt = context.context.systemPrompt
    const match = /workspace-id:([a-zA-Z0-9_-]+)/.exec(systemPrompt)
    return match?.[1]
  }

  private async request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (signal?.aborted) return 'deny'
    if (this.pending) return this.pending

    this.pending = new Promise<ApprovalDecision>(resolve => {
      let settled = false
      const settle = (decision: ApprovalDecision) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve(decision)
      }
      const onAbort = () => settle('deny')

      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        if (settled) return
        const operation = request.destructive
          ? i18n.t('agent.workspace.destructiveOperation')
          : i18n.t('agent.workspace.fileChange')
        const requestedPath = typeof (request.args as any)?.path === 'string' ? (request.args as any).path : ''
        const path = requestedPath ? ` on ${requestedPath}` : ''
        presentDialog('warning', {
          title: i18n.t('agent.workspace.approvalTitle'),
          content: i18n.t('agent.workspace.approvalContent', { operation, path }),
          confirmText: i18n.t('common.confirm'),
          cancelText: i18n.t('common.cancel'),
          showCancel: true,
          onConfirm: async () => settle('allow'),
          onCancel: () => settle('deny')
        })
      } catch (error) {
        logger.error('Unable to show workspace approval dialog:', error as Error)
        settle('deny')
      }
    }).finally(() => {
      this.pending = null
    })

    return this.pending
  }
}

export const toolApprovalCoordinator = new ToolApprovalCoordinator()
