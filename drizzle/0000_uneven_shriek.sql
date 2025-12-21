CREATE TABLE IF NOT EXISTS "bucket_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL,
	"access_key" text NOT NULL,
	"secret_key" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "bucket_keys_access_key_unique" UNIQUE("access_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"user_id" text NOT NULL,
	"region" text DEFAULT 'auto',
	"is_public" boolean DEFAULT false NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"total_requests" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"storage_limit_bytes" bigint DEFAULT 1073741824,
	"storage_usage_bytes" bigint DEFAULT 0 NOT NULL,
	"ingress_bytes" bigint DEFAULT 0 NOT NULL,
	"egress_bytes" bigint DEFAULT 0 NOT NULL,
	"total_requests" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bucket_id_idx" ON "bucket_keys" ("bucket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_key_idx" ON "bucket_keys" ("access_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "name_idx" ON "buckets" ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_id_idx" ON "buckets" ("user_id");--> statement-breakpoint
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
