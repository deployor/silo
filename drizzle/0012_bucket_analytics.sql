CREATE TABLE "bucket_analytics_minute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL,
	"minute_start" timestamp NOT NULL,
	"request_count" bigint DEFAULT 0 NOT NULL,
	"get_count" bigint DEFAULT 0 NOT NULL,
	"put_count" bigint DEFAULT 0 NOT NULL,
	"delete_count" bigint DEFAULT 0 NOT NULL,
	"head_count" bigint DEFAULT 0 NOT NULL,
	"status_2xx" bigint DEFAULT 0 NOT NULL,
	"status_3xx" bigint DEFAULT 0 NOT NULL,
	"status_4xx" bigint DEFAULT 0 NOT NULL,
	"status_5xx" bigint DEFAULT 0 NOT NULL,
	"status_401" bigint DEFAULT 0 NOT NULL,
	"status_403" bigint DEFAULT 0 NOT NULL,
	"status_404" bigint DEFAULT 0 NOT NULL,
	"status_429" bigint DEFAULT 0 NOT NULL,
	"error_count" bigint DEFAULT 0 NOT NULL,
	"ingress_bytes" bigint DEFAULT 0 NOT NULL,
	"egress_bytes" bigint DEFAULT 0 NOT NULL,
	"latency_total_ms" bigint DEFAULT 0 NOT NULL,
	"latency_max_ms" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bucket_object_analytics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"hit_count" bigint DEFAULT 0 NOT NULL,
	"error_count" bigint DEFAULT 0 NOT NULL,
	"ingress_bytes" bigint DEFAULT 0 NOT NULL,
	"egress_bytes" bigint DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bucket_analytics_snapshot" (
	"bucket_id" uuid PRIMARY KEY NOT NULL,
	"window_start" timestamp NOT NULL,
	"window_end" timestamp NOT NULL,
	"request_count_24h" bigint DEFAULT 0 NOT NULL,
	"egress_bytes_24h" bigint DEFAULT 0 NOT NULL,
	"ingress_bytes_24h" bigint DEFAULT 0 NOT NULL,
	"error_count_24h" bigint DEFAULT 0 NOT NULL,
	"status_429_24h" bigint DEFAULT 0 NOT NULL,
	"avg_latency_ms_24h" double precision DEFAULT 0 NOT NULL,
	"peak_minute_requests_24h" bigint DEFAULT 0 NOT NULL,
	"peak_minute_at_24h" timestamp,
	"hot_objects_json" text DEFAULT '[]' NOT NULL,
	"status_breakdown_json" text DEFAULT '{}' NOT NULL,
	"method_breakdown_json" text DEFAULT '{}' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bucket_analytics_minute" ADD CONSTRAINT "bucket_analytics_minute_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bucket_object_analytics" ADD CONSTRAINT "bucket_object_analytics_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bucket_analytics_snapshot" ADD CONSTRAINT "bucket_analytics_snapshot_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "bucket_analytics_minute_bucket_minute_idx" ON "bucket_analytics_minute" USING btree ("bucket_id","minute_start");
--> statement-breakpoint
CREATE INDEX "bucket_analytics_minute_minute_idx" ON "bucket_analytics_minute" USING btree ("minute_start");
--> statement-breakpoint
CREATE INDEX "bucket_object_analytics_bucket_object_idx" ON "bucket_object_analytics" USING btree ("bucket_id","object_key");
--> statement-breakpoint
CREATE INDEX "bucket_object_analytics_bucket_hits_idx" ON "bucket_object_analytics" USING btree ("bucket_id","hit_count");
--> statement-breakpoint
CREATE INDEX "bucket_object_analytics_bucket_egress_idx" ON "bucket_object_analytics" USING btree ("bucket_id","egress_bytes");
