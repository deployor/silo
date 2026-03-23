ALTER TABLE "buckets"
	ADD COLUMN "deep_freeze_state" text DEFAULT 'active' NOT NULL,
	ADD COLUMN "deep_freeze_reason" text,
	ADD COLUMN "deep_freeze_requested_at" timestamp,
	ADD COLUMN "deep_freeze_started_at" timestamp,
	ADD COLUMN "deep_freeze_completed_at" timestamp,
	ADD COLUMN "deep_freeze_archive_key" text,
	ADD COLUMN "deep_freeze_archive_bytes" bigint DEFAULT 0 NOT NULL,
	ADD COLUMN "deep_freeze_progress" double precision DEFAULT 0 NOT NULL,
	ADD COLUMN "deep_freeze_estimated_freeze_seconds" bigint DEFAULT 0 NOT NULL,
	ADD COLUMN "deep_freeze_estimated_unfreeze_seconds" bigint DEFAULT 0 NOT NULL,
	ADD COLUMN "deep_freeze_last_updated_at" timestamp;
