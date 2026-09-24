CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`relative_path` text,
	`created_at` text NOT NULL,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_run_idx` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text,
	`test_name` text NOT NULL,
	`definition_snapshot` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`duration_ms` integer,
	`error` text,
	`incomplete_steps` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runs_test_started_idx` ON `runs` (`test_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `step_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`duration_ms` integer NOT NULL,
	`error` text,
	`position` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `step_results_run_position_uq` ON `step_results` (`run_id`,`position`);--> statement-breakpoint
CREATE INDEX `step_results_run_idx` ON `step_results` (`run_id`);--> statement-breakpoint
CREATE TABLE `tests` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`schema_version` integer NOT NULL,
	`definition` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
