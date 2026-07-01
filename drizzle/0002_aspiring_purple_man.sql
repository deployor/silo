ALTER TABLE "buckets" ADD COLUMN IF NOT EXISTS "is_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "buckets" ADD COLUMN IF NOT EXISTS "pause_reason" text;