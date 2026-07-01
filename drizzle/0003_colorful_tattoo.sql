ALTER TABLE "request_logs" DROP CONSTRAINT "request_logs_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "egress_limit_bytes" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lock_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
