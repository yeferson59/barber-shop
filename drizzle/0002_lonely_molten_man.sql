ALTER TABLE `barber` ADD `invite_hash` text;--> statement-breakpoint
ALTER TABLE `barber` ADD `invite_expires_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `barber_invite_hash_unique` ON `barber` (`invite_hash`);