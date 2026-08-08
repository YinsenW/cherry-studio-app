import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { topics } from './topics'

/**
 * A user-visible workspace that can be mounted into the mobile agent.
 *
 * `root_uri` is an implementation detail and is never exposed to the model.
 * For app-sandbox workspaces it is derived from the workspace id; for an
 * Android Storage Access Framework workspace it is the persisted content URI.
 */
export const agentWorkspaces = sqliteTable(
  'agent_workspaces',
  {
    id: text('id').notNull().unique().primaryKey(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    root_uri: text('root_uri').notNull(),
    read_only: integer('read_only', { mode: 'boolean' }).notNull().default(false),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    last_used_at: integer('last_used_at')
  },
  table => [index('idx_agent_workspaces_last_used_at').on(table.last_used_at)]
)

/**
 * Topic-to-workspace binding. A topic can keep a different working directory
 * without changing the existing Topic model or its backup format.
 */
export const agentTopicWorkspaces = sqliteTable(
  'agent_topic_workspaces',
  {
    topic_id: text('topic_id')
      .notNull()
      .unique()
      .primaryKey()
      .references(() => topics.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id')
      .notNull()
      .references(() => agentWorkspaces.id, { onDelete: 'cascade' }),
    relative_path: text('relative_path').notNull().default('.'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull()
  },
  table => [index('idx_agent_topic_workspaces_workspace_id').on(table.workspace_id)]
)

/**
 * Metadata-only audit trail for agent filesystem operations. File contents are
 * intentionally not stored here; small reversible snapshots live on disk.
 */
export const agentFileOperations = sqliteTable(
  'agent_file_operations',
  {
    id: text('id').notNull().unique().primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    topic_id: text('topic_id'),
    tool_call_id: text('tool_call_id'),
    action: text('action').notNull(),
    path: text('path').notNull(),
    destination: text('destination'),
    before_revision: text('before_revision'),
    after_revision: text('after_revision'),
    status: text('status').notNull(),
    approval: text('approval').notNull(),
    bytes_written: integer('bytes_written'),
    snapshot_uri: text('snapshot_uri'),
    created_at: integer('created_at').notNull()
  },
  table => [
    index('idx_agent_file_operations_workspace_id').on(table.workspace_id),
    index('idx_agent_file_operations_topic_id').on(table.topic_id),
    index('idx_agent_file_operations_created_at').on(table.created_at)
  ]
)
