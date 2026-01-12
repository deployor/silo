ALTER TABLE "sessions" ADD COLUMN "impersonator_user_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "impersonation_expires_at" timestamp;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonator_user_id_users_id_fk" FOREIGN KEY ("impersonator_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
