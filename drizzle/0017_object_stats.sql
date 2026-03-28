CREATE TABLE IF NOT EXISTS "object_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL REFERENCES "buckets"("id") ON DELETE cascade,
	"object_key" text NOT NULL,
	"hit_count" bigint DEFAULT 0 NOT NULL,
	"error_count" bigint DEFAULT 0 NOT NULL,
	"egress_bytes" bigint DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "object_stats_bucket_object_idx" ON "object_stats" USING btree ("bucket_id","object_key");
CREATE INDEX IF NOT EXISTS "object_stats_bucket_hits_idx" ON "object_stats" USING btree ("bucket_id","hit_count");

DROP TABLE IF EXISTS "bucket_analytics_snapshot";
DROP TABLE IF EXISTS "bucket_analytics_minute";
DROP TABLE IF EXISTS "bucket_object_analytics";
