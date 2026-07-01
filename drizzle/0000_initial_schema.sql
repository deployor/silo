CREATE TABLE IF NOT EXISTS "app_settings" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"default_storage_limit_bytes" bigint DEFAULT 1073741824 NOT NULL,
	"egress_multiplier" bigint DEFAULT 3 NOT NULL,
	"min_egress_bytes" bigint DEFAULT 10737418240 NOT NULL,
	"default_max_buckets_per_user" bigint DEFAULT 50 NOT NULL,
	"default_max_keys_per_bucket" bigint DEFAULT 20 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bucket_collaborators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL,
	"invitee_user_id" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"permissions" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp,
	"accepted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bucket_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL,
	"access_key" text NOT NULL,
	"secret_key" text NOT NULL,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"note" text,
	"is_paused" boolean DEFAULT false NOT NULL,
	"pause_reason" text,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "bucket_keys_access_key_unique" UNIQUE("access_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"user_id" text,
	"region" text DEFAULT 'auto',
	"is_public" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"pause_reason" text,
	"deep_freeze_state" text DEFAULT 'active' NOT NULL,
	"deep_freeze_reason" text,
	"deep_freeze_requested_at" timestamp,
	"deep_freeze_started_at" timestamp,
	"deep_freeze_completed_at" timestamp,
	"deep_freeze_archive_key" text,
	"deep_freeze_archive_bytes" bigint DEFAULT 0 NOT NULL,
	"deep_freeze_progress" double precision DEFAULT 0 NOT NULL,
	"deep_freeze_estimated_freeze_seconds" bigint DEFAULT 0 NOT NULL,
	"deep_freeze_estimated_unfreeze_seconds" bigint DEFAULT 0 NOT NULL,
	"deep_freeze_last_updated_at" timestamp,
	"cors_config" text,
	"custom_domains" text,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"total_requests" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deep_freeze_jobs" (
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
CREATE TABLE IF NOT EXISTS "object_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"hit_count" bigint DEFAULT 0 NOT NULL,
	"error_count" bigint DEFAULT 0 NOT NULL,
	"egress_bytes" bigint DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "offboarding_export_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"access_key" text NOT NULL,
	"secret_key_hash" text NOT NULL,
	"allowed_prefix" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_accessed_at" timestamp,
	"used_at" timestamp,
	"revoked_at" timestamp,
	"download_completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "offboarding_export_sessions_access_key_unique" UNIQUE("access_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "redemption_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"code" text NOT NULL,
	"is_redeemed" boolean DEFAULT false NOT NULL,
	"redeemed_by" text,
	"redeemed_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "redemption_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "redemption_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"ip_address" text,
	"code_attempted" text,
	"success" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "redemption_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"description" text,
	"quota_credit_bytes" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "redemption_programs_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid,
	"bucket_name" text,
	"owner_id" text,
	"requester_id" text,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status_code" bigint NOT NULL,
	"ingress_bytes" bigint DEFAULT 0,
	"egress_bytes" bigint DEFAULT 0,
	"ip_address" text,
	"user_agent" text,
	"latency_ms" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp,
	"scope" text,
	"user_agent" text,
	"ip_address" text,
	"impersonator_user_id" text,
	"impersonated_user_id" text,
	"impersonation_expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"slack_id" text,
	"storage_limit_bytes" bigint,
	"storage_usage_bytes" bigint DEFAULT 0 NOT NULL,
	"egress_limit_bytes" bigint,
	"ingress_bytes" bigint DEFAULT 0 NOT NULL,
	"egress_bytes" bigint DEFAULT 0 NOT NULL,
	"egress_period" text,
	"total_requests" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"is_admin" boolean DEFAULT false NOT NULL,
	"is_immortal" boolean DEFAULT false NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"lock_reason" text,
	"onboarded" boolean DEFAULT false NOT NULL,
	"marked_as_over_age" boolean DEFAULT false NOT NULL,
	"over_age_grace_period_ends_at" timestamp,
	"data_exported" boolean DEFAULT false NOT NULL,
	"files_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bucket_collaborator_bucket_user_idx" ON "bucket_collaborators" ("bucket_id","invitee_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bucket_collaborator_invitee_idx" ON "bucket_collaborators" ("invitee_user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bucket_collaborator_inviter_idx" ON "bucket_collaborators" ("invited_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bucket_collaborator_status_idx" ON "bucket_collaborators" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bucket_id_idx" ON "bucket_keys" ("bucket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_key_idx" ON "bucket_keys" ("access_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "name_idx" ON "buckets" ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_id_idx" ON "buckets" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_freeze_jobs_bucket_idx" ON "deep_freeze_jobs" ("bucket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_freeze_jobs_status_idx" ON "deep_freeze_jobs" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_freeze_jobs_action_idx" ON "deep_freeze_jobs" ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_freeze_jobs_heartbeat_idx" ON "deep_freeze_jobs" ("heartbeat_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "object_stats_bucket_object_idx" ON "object_stats" ("bucket_id","object_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "object_stats_bucket_hits_idx" ON "object_stats" ("bucket_id","hit_count");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offboarding_export_sessions_user_id_idx" ON "offboarding_export_sessions" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offboarding_export_sessions_access_key_idx" ON "offboarding_export_sessions" ("access_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offboarding_export_sessions_expires_at_idx" ON "offboarding_export_sessions" ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_code_program_idx" ON "redemption_codes" ("program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_code_code_idx" ON "redemption_codes" ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_code_redeemed_by_idx" ON "redemption_codes" ("redeemed_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_code_created_by_idx" ON "redemption_codes" ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_log_user_id_idx" ON "redemption_logs" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_log_ip_idx" ON "redemption_logs" ("ip_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_log_created_at_idx" ON "redemption_logs" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_owner_idx" ON "request_logs" ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_bucket_idx" ON "request_logs" ("bucket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_created_at_idx" ON "request_logs" ("created_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bucket_collaborators" ADD CONSTRAINT "bucket_collaborators_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "buckets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bucket_collaborators" ADD CONSTRAINT "bucket_collaborators_invitee_user_id_users_id_fk" FOREIGN KEY ("invitee_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bucket_collaborators" ADD CONSTRAINT "bucket_collaborators_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bucket_keys" ADD CONSTRAINT "bucket_keys_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "buckets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buckets" ADD CONSTRAINT "buckets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deep_freeze_jobs" ADD CONSTRAINT "deep_freeze_jobs_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "buckets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deep_freeze_jobs" ADD CONSTRAINT "deep_freeze_jobs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "object_stats" ADD CONSTRAINT "object_stats_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "buckets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "offboarding_export_sessions" ADD CONSTRAINT "offboarding_export_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redemption_codes" ADD CONSTRAINT "redemption_codes_program_id_redemption_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "redemption_programs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redemption_codes" ADD CONSTRAINT "redemption_codes_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redemption_codes" ADD CONSTRAINT "redemption_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redemption_logs" ADD CONSTRAINT "redemption_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "buckets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonator_user_id_users_id_fk" FOREIGN KEY ("impersonator_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonated_user_id_users_id_fk" FOREIGN KEY ("impersonated_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
