CREATE TABLE `agent_file_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`topic_id` text,
	`tool_call_id` text,
	`action` text NOT NULL,
	`path` text NOT NULL,
	`destination` text,
	`before_revision` text,
	`after_revision` text,
	`status` text NOT NULL,
	`approval` text NOT NULL,
	`bytes_written` integer,
	`snapshot_uri` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_file_operations_id_unique` ON `agent_file_operations` (`id`);--> statement-breakpoint
CREATE INDEX `idx_agent_file_operations_workspace_id` ON `agent_file_operations` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_file_operations_topic_id` ON `agent_file_operations` (`topic_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_file_operations_created_at` ON `agent_file_operations` (`created_at`);--> statement-breakpoint
CREATE TABLE `agent_topic_workspaces` (
	`topic_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`relative_path` text DEFAULT '.' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `agent_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_topic_workspaces_topic_id_unique` ON `agent_topic_workspaces` (`topic_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_topic_workspaces_workspace_id` ON `agent_topic_workspaces` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `agent_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`root_uri` text NOT NULL,
	`read_only` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_workspaces_id_unique` ON `agent_workspaces` (`id`);--> statement-breakpoint
CREATE INDEX `idx_agent_workspaces_last_used_at` ON `agent_workspaces` (`last_used_at`);