import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm'

import type { AgentArtifactRecord, AgentRunRecord, AgentRunStatus } from '@/agent/workspace/runtimeTypes'
import type { FileMetadata } from '@/types/file'
import type { MessageBlock } from '@/types/message'

import { db } from '..'
import { transformFileToDb, transformMessageBlockToDb } from '../mappers'
import { agentArtifacts, agentRuns, files, messageBlocks } from '../schema'

function toRun(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  return {
    id: row.id,
    topicId: row.topic_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status as AgentRunStatus,
    error: row.error,
    byteUsage: row.byte_usage,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cleanupAfter: row.cleanup_after,
    cacheCleanedAt: row.cache_cleaned_at
  }
}

function toArtifact(row: typeof agentArtifacts.$inferSelect): AgentArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    fileId: row.file_id,
    messageId: row.message_id,
    sourcePath: row.source_path,
    displayName: row.display_name,
    createdAt: row.created_at
  }
}

export async function createAgentRun(run: AgentRunRecord): Promise<void> {
  await db.insert(agentRuns).values({
    id: run.id,
    topic_id: run.topicId,
    user_message_id: run.userMessageId,
    assistant_message_id: run.assistantMessageId,
    status: run.status,
    error: run.error ?? null,
    byte_usage: run.byteUsage,
    started_at: run.startedAt,
    finished_at: run.finishedAt ?? null,
    cleanup_after: run.cleanupAfter ?? null,
    cache_cleaned_at: run.cacheCleanedAt ?? null
  })
}

export async function updateAgentRun(
  id: string,
  changes: Partial<
    Pick<AgentRunRecord, 'status' | 'error' | 'byteUsage' | 'finishedAt' | 'cleanupAfter' | 'cacheCleanedAt'>
  >
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.error !== undefined ? { error: changes.error } : {}),
      ...(changes.byteUsage !== undefined ? { byte_usage: changes.byteUsage } : {}),
      ...(changes.finishedAt !== undefined ? { finished_at: changes.finishedAt } : {}),
      ...(changes.cleanupAfter !== undefined ? { cleanup_after: changes.cleanupAfter } : {}),
      ...(changes.cacheCleanedAt !== undefined ? { cache_cleaned_at: changes.cacheCleanedAt } : {})
    })
    .where(eq(agentRuns.id, id))
}

export async function interruptRunningAgentRuns(now: number): Promise<void> {
  await db
    .update(agentRuns)
    .set({ status: 'interrupted', finished_at: now, cleanup_after: now + 24 * 60 * 60 * 1_000 })
    .where(eq(agentRuns.status, 'running'))
}

export async function getAgentRunsDueForCleanup(now: number): Promise<AgentRunRecord[]> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(
      and(isNotNull(agentRuns.cleanup_after), lte(agentRuns.cleanup_after, now), isNull(agentRuns.cache_cleaned_at))
    )
  return rows.map(toRun)
}

export async function recordAgentArtifact(artifact: AgentArtifactRecord): Promise<void> {
  await db.insert(agentArtifacts).values({
    id: artifact.id,
    run_id: artifact.runId,
    file_id: artifact.fileId,
    message_id: artifact.messageId,
    source_path: artifact.sourcePath,
    display_name: artifact.displayName,
    created_at: artifact.createdAt
  })
}

export async function publishAgentArtifact(
  file: FileMetadata,
  artifact: AgentArtifactRecord,
  block: MessageBlock
): Promise<void> {
  await db.transaction(async tx => {
    await tx.insert(files).values(transformFileToDb(file))
    await tx.insert(agentArtifacts).values({
      id: artifact.id,
      run_id: artifact.runId,
      file_id: artifact.fileId,
      message_id: artifact.messageId,
      source_path: artifact.sourcePath,
      display_name: artifact.displayName,
      created_at: artifact.createdAt
    })
    await tx.insert(messageBlocks).values(transformMessageBlockToDb(block))
  })
}

export async function getAgentArtifact(runId: string, sourcePath: string): Promise<AgentArtifactRecord | null> {
  const rows = await db
    .select()
    .from(agentArtifacts)
    .where(and(eq(agentArtifacts.run_id, runId), eq(agentArtifacts.source_path, sourcePath)))
    .limit(1)
  return rows[0] ? toArtifact(rows[0]) : null
}

export async function getAgentArtifactsForRun(runId: string): Promise<AgentArtifactRecord[]> {
  const rows = await db.select().from(agentArtifacts).where(eq(agentArtifacts.run_id, runId))
  return rows.map(toArtifact)
}

export async function getAgentArtifactsForTopic(topicId: string): Promise<AgentArtifactRecord[]> {
  const rows = await db
    .select({ artifact: agentArtifacts })
    .from(agentArtifacts)
    .innerJoin(agentRuns, eq(agentArtifacts.run_id, agentRuns.id))
    .where(eq(agentRuns.topic_id, topicId))
  return rows.map(row => toArtifact(row.artifact))
}

export async function deleteAgentArtifact(id: string): Promise<void> {
  await db.delete(agentArtifacts).where(eq(agentArtifacts.id, id))
}

export const agentRunQueries = {
  createAgentRun,
  updateAgentRun,
  interruptRunningAgentRuns,
  getAgentRunsDueForCleanup,
  recordAgentArtifact,
  publishAgentArtifact,
  getAgentArtifact,
  getAgentArtifactsForRun,
  getAgentArtifactsForTopic,
  deleteAgentArtifact
}
