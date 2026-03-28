CREATE TABLE "offboarding_export_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"access_key" text NOT NULL,
	"secret_key_hash" text NOT NULL,
	"allowed_prefix" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_accessed_at" timestamp,
	"used_at" timestamp,
	"revoked_at" timestamp,
	"download_completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "offboarding_export_sessions_access_key_unique" UNIQUE("access_key")
);
--> statement-breakpoint
ALTER TABLE "offboarding_export_sessions" ADD CONSTRAINT "offboarding_export_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "offboarding_export_sessions_user_id_idx" ON "offboarding_export_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "offboarding_export_sessions_access_key_idx" ON "offboarding_export_sessions" USING btree ("access_key");
--> statement-breakpoint
CREATE INDEX "offboarding_export_sessions_expires_at_idx" ON "offboarding_export_sessions" USING btree ("expires_at");
