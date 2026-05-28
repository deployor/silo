ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "ysws_quota_per_hour_bytes";--> statement-breakpoint
ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "ysws_bonus_tiers";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "is_reviewer";--> statement-breakpoint
DROP TABLE IF EXISTS "ysws_submissions" CASCADE;
