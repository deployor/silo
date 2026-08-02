CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text,
	"target_user_id" text,
	"action" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_logs_actor_user_id_users_id_fk"
		FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE set null,
	CONSTRAINT "admin_audit_logs_target_user_id_users_id_fk"
		FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE set null
);
CREATE INDEX IF NOT EXISTS "admin_audit_actor_created_idx"
	ON "admin_audit_logs" ("actor_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "admin_audit_target_created_idx"
	ON "admin_audit_logs" ("target_user_id", "created_at");
