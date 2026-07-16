CREATE TABLE IF NOT EXISTS "dataplane_writer_lease" (
	"name" text PRIMARY KEY NOT NULL,
	"holder_id" text NOT NULL,
	"generation" bigint NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dataplane_writer_lease_generation_positive" CHECK ("generation" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "multipart_upload_generations" (
	"upload_id" text PRIMARY KEY NOT NULL,
	"bucket_id" uuid NOT NULL,
	"writer_generation" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "multipart_upload_generations_created_at_idx" ON "multipart_upload_generations" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataplane_accounting_events" (
	"id" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
