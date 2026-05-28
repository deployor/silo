CREATE TABLE IF NOT EXISTS "app_settings" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"default_storage_limit_bytes" bigint DEFAULT 1073741824 NOT NULL,
	"egress_multiplier" bigint DEFAULT 3 NOT NULL,
	"min_egress_bytes" bigint DEFAULT 10737418240 NOT NULL,
	"default_max_buckets_per_user" bigint DEFAULT 50 NOT NULL,
	"default_max_keys_per_bucket" bigint DEFAULT 20 NOT NULL,
	"cdn_force_slack_upload" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "redemption_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"code" text NOT NULL,
	"is_redeemed" boolean DEFAULT false NOT NULL,
	"redeemed_by" text,
	"redeemed_at" timestamp,
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
ALTER TABLE "buckets" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "storage_limit_bytes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "buckets" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "marked_as_over_age" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "over_age_grace_period_ends_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "data_exported" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "files_deleted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_code_program_idx" ON "redemption_codes" ("program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_code_code_idx" ON "redemption_codes" ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_code_redeemed_by_idx" ON "redemption_codes" ("redeemed_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_log_user_id_idx" ON "redemption_logs" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_log_ip_idx" ON "redemption_logs" ("ip_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_log_created_at_idx" ON "redemption_logs" ("created_at");--> statement-breakpoint
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
 ALTER TABLE "redemption_logs" ADD CONSTRAINT "redemption_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
