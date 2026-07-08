ALTER TABLE "redemption_transactions" DROP CONSTRAINT "redemption_transactions_program_id_redemption_programs_id_fk";
--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN "target_user_id" text;--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN "target_email" text;--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN "target_slack_id" text;--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN "api_key_suffix" text;--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN "request_user_agent" text;--> statement-breakpoint
ALTER TABLE "redemption_transactions" ADD COLUMN "fulfilled_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_transaction_target_user_id_idx" ON "redemption_transactions" ("target_user_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redemption_transactions" ADD CONSTRAINT "redemption_transactions_program_id_redemption_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "redemption_programs"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
