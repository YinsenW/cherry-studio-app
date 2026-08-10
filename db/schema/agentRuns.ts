import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

import { files } from './files'
import { messages } from './messages'
import { topics } from './topics'

/** App-owned control-plane records. These rows are never mounted into Agent VFS. */
export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').notNull().unique().primaryKey(),
    topic_id: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    user_message_id: text('user_message_id').notNull(),
    assistant_message_id: text('assistant_message_id').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    byte_usage: integer('byte_usage').notNull().default(0),
    started_at: integer('started_at').notNull(),
    finished_at: integer('finished_at'),
    cleanup_after: integer('cleanup_after'),
    cache_cleaned_at: integer('cache_cleaned_at')
  },
  table => [
    index('idx_agent_runs_topic_id').on(table.topic_id),
    index('idx_agent_runs_status').on(table.status),
    index('idx_agent_runs_cleanup_after').on(table.cleanup_after)
  ]
)

/** Provenance and de-duplication for files published from a run. */
export const agentArtifacts = sqliteTable(
  'agent_artifacts',
  {
    id: text('id').notNull().unique().primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    file_id: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    message_id: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    source_path: text('source_path').notNull(),
    display_name: text('display_name').notNull(),
    created_at: integer('created_at').notNull()
  },
  table => [
    index('idx_agent_artifacts_run_id').on(table.run_id),
    index('idx_agent_artifacts_file_id').on(table.file_id),
    index('idx_agent_artifacts_message_id').on(table.message_id),
    uniqueIndex('idx_agent_artifacts_run_source').on(table.run_id, table.source_path)
  ]
)
