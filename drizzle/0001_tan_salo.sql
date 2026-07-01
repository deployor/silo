CREATE TABLE IF NOT EXISTS "request_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid,
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
ALTER TABLE "bucket_keys" ADD COLUMN IF NOT EXISTS "is_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bucket_keys" ADD COLUMN IF NOT EXISTS "pause_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "slack_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_owner_idx" ON "request_logs" ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_bucket_idx" ON "request_logs" ("bucket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_created_at_idx" ON "request_logs" ("created_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "buckets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
