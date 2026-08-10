import { clearAllTables as _clearAllTables, resetDatabase as _resetDatabase } from '@db/queries/reset.queries'

export async function clearAllTables() {
  await _clearAllTables()
  const { agentRuntimeService } = await import('@/agent/workspace/AgentRuntimeService')
  await agentRuntimeService.clearAllStorage()
}

export async function resetDatabase() {
  await _resetDatabase()
  const { agentRuntimeService } = await import('@/agent/workspace/AgentRuntimeService')
  await agentRuntimeService.clearAllStorage()
}

export const databaseMaintenance = {
  clearAllTables,
  resetDatabase
}
