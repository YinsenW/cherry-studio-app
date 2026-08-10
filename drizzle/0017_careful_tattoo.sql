CREATE TABLE `agent_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`file_id` text NOT NULL,
	`message_id` text NOT NULL,
	`source_path` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_artifacts_id_unique` ON `agent_artifacts` (`id`);--> statement-breakpoint
CREATE INDEX `idx_agent_artifacts_run_id` ON `agent_artifacts` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_artifacts_file_id` ON `agent_artifacts` (`file_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_artifacts_message_id` ON `agent_artifacts` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_artifacts_run_source` ON `agent_artifacts` (`run_id`,`source_path`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	`assistant_message_id` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`byte_usage` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`cleanup_after` integer,
	`cache_cleaned_at` integer,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_id_unique` ON `agent_runs` (`id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runs_topic_id` ON `agent_runs` (`topic_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runs_status` ON `agent_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_runs_cleanup_after` ON `agent_runs` (`cleanup_after`);