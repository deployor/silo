CREATE TABLE IF NOT EXISTS "redemption_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"user_id" text,
	"actor_user_id" text,
	"source" text NOT NULL,
	"code_id" uuid,
	"external_id" text,
	"amount_bytes" bigint NOT NULL,
	"reason" text,
	"ip_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "redemption_codes" ADD COLUMN "quota_credit_bytes" bigint;--> statement-breakpoint
ALTER TABLE "redemption_programs" ADD COLUMN "api_key_hash" text;--> statement-breakpoint
ALTER TABLE "redemption_programs" ADD COLUMN "api_key_suffix" text;--> statement-breakpoint
ALTER TABLE "redemption_programs" ADD COLUMN "api_key_created_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_transaction_program_idx" ON "redemption_transactions" ("program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_transaction_user_id_idx" ON "redemption_transactions" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_transaction_created_at_idx" ON "redemption_transactions" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "redemption_transaction_external_id_idx" ON "redemption_transactions" ("program_id","external_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redemption_transactions" ADD CONSTRAINT "redemption_transactions_program_id_redemption_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "redemption_programs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redemption_transactions" ADD CONSTRAINT "redemption_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redemption_transactions" ADD CONSTRAINT "redemption_transactions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redemption_transactions" ADD CONSTRAINT "redemption_transactions_code_id_redemption_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "redemption_codes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
