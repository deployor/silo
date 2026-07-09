ALTER TABLE "redemption_transactions" DROP CONSTRAINT IF EXISTS "redemption_transactions_program_id_redemption_programs_id_fk";
--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN IF NOT EXISTS "target_user_id" text;--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN IF NOT EXISTS "target_email" text;--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN IF NOT EXISTS "target_slack_id" text;--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN IF NOT EXISTS "api_key_suffix" text;--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN IF NOT EXISTS "request_user_agent" text;--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN IF NOT EXISTS "fulfilled_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_transaction_target_user_id_idx" ON "redemption_transactions" ("target_user_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redemption_transactions" ADD CONSTRAINT "redemption_transactions_program_id_redemption_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "redemption_programs"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
