export type AgentRunStatus = 'running' | 'success' | 'error' | 'aborted' | 'interrupted'

export type AgentRunRecord = {
  id: string
  topicId: string
  userMessageId: string
  assistantMessageId: string
  status: AgentRunStatus
  error?: string | null
  byteUsage: number
  startedAt: number
  finishedAt?: number | null
  cleanupAfter?: number | null
  cacheCleanedAt?: number | null
}

export type AgentArtifactRecord = {
  id: string
  runId: string
  fileId: string
  messageId: string
  sourcePath: string
  displayName: string
  createdAt: number
}
