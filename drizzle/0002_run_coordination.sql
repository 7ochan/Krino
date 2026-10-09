ALTER TABLE `runs` ADD `lease_owner` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `lease_expires_at` text;
--> statement-breakpoint
CREATE INDEX `runs_queue_idx` ON `runs` (`status`,`started_at`);
