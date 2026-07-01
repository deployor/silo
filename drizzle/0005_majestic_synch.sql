ALTER TABLE "buckets" ADD COLUMN IF NOT EXISTS "is_cdn" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN IF NOT EXISTS "bucket_name" text;