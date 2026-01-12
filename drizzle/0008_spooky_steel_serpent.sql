ALTER TABLE "sessions" ADD COLUMN "impersonated_user_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonated_user_id_users_id_fk" FOREIGN KEY ("impersonated_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
