ALTER TABLE "buckets" ADD COLUMN "is_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "buckets" ADD COLUMN "pause_reason" text;