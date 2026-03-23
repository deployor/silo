CREATE TABLE "deep_freeze_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"archive_key" text,
	"manifest_key" text,
	"lock_token" text,
	"worker_id" text,
	"total_objects" bigint DEFAULT 0 NOT NULL,
	"processed_objects" bigint DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"processed_bytes" bigint DEFAULT 0 NOT NULL,
	"archive_bytes" bigint DEFAULT 0 NOT NULL,
	"progress_percent" double precision DEFAULT 0 NOT NULL,
	"checksum_sha256" text,
	"manifest_json" text DEFAULT '[]' NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"retry_count" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"heartbeat_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deep_freeze_jobs" ADD CONSTRAINT "deep_freeze_jobs_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deep_freeze_jobs" ADD CONSTRAINT "deep_freeze_jobs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "deep_freeze_jobs_bucket_idx" ON "deep_freeze_jobs" USING btree ("bucket_id");
--> statement-breakpoint
CREATE INDEX "deep_freeze_jobs_status_idx" ON "deep_freeze_jobs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "deep_freeze_jobs_action_idx" ON "deep_freeze_jobs" USING btree ("action");
--> statement-breakpoint
CREATE INDEX "deep_freeze_jobs_heartbeat_idx" ON "deep_freeze_jobs" USING btree ("heartbeat_at");
