ALTER TABLE "buckets" ADD COLUMN "is_cdn" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "bucket_name" text;