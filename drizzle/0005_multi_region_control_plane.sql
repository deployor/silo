ALTER TABLE "buckets" ADD COLUMN IF NOT EXISTS "requested_region" text;
--> statement-breakpoint
ALTER TABLE "buckets" ADD COLUMN IF NOT EXISTS "resolved_region" text;
--> statement-breakpoint
UPDATE "buckets"
SET "requested_region" = CASE
  WHEN "region" IN ('auto', 'eu-central', 'us-east') THEN "region"
  ELSE 'auto'
END
WHERE "requested_region" IS NULL;
--> statement-breakpoint
UPDATE "buckets" SET "resolved_region" = 'eu-central' WHERE "resolved_region" IS NULL;
--> statement-breakpoint
ALTER TABLE "buckets" ALTER COLUMN "requested_region" SET DEFAULT 'auto';
--> statement-breakpoint
ALTER TABLE "buckets" ALTER COLUMN "requested_region" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "buckets" ALTER COLUMN "resolved_region" SET DEFAULT 'eu-central';
--> statement-breakpoint
ALTER TABLE "buckets" ALTER COLUMN "resolved_region" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buckets" ADD CONSTRAINT "buckets_requested_region_check" CHECK ("requested_region" ~ '^[a-z0-9][a-z0-9-]*$');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buckets" ADD CONSTRAINT "buckets_resolved_region_check" CHECK ("resolved_region" ~ '^[a-z0-9][a-z0-9-]*$');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION silo_keep_bucket_resolved_region_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."resolved_region" IS DISTINCT FROM NEW."resolved_region" THEN
    RAISE EXCEPTION 'Bucket storage region is immutable; use an explicit migration workflow.' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS buckets_resolved_region_immutable ON "buckets";
--> statement-breakpoint
CREATE TRIGGER buckets_resolved_region_immutable
BEFORE UPDATE OF "resolved_region" ON "buckets"
FOR EACH ROW EXECUTE FUNCTION silo_keep_bucket_resolved_region_immutable();
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "buckets" GROUP BY "name" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce global bucket names: duplicate bucket rows exist';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "buckets_name_unique_idx" ON "buckets" ("name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bucket_deletion_tombstones" (
  "bucket_id" uuid PRIMARY KEY NOT NULL,
  "bucket_name" text NOT NULL,
  "owner_user_id" text,
  "requested_region" text NOT NULL,
  "resolved_region" text NOT NULL,
  "root_prefix" text,
  "deleted_by_user_id" text,
  "deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bucket_deletion_tombstones_resolved_region_check" CHECK ("resolved_region" ~ '^[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT "bucket_deletion_tombstones_requested_region_check" CHECK ("requested_region" ~ '^[a-z0-9][a-z0-9-]*$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bucket_deletion_tombstones_region_deleted_at_idx" ON "bucket_deletion_tombstones" ("resolved_region", "deleted_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_region_backends" (
  "region_id" text NOT NULL,
  "backend_id" text NOT NULL,
  "provider" text NOT NULL,
  "bucket_name" text,
  "role" text DEFAULT 'primary' NOT NULL,
  "status" text DEFAULT 'standby' NOT NULL,
  "promotion_authorized" boolean DEFAULT false NOT NULL,
  "replication_checkpoint" bigint DEFAULT 0 NOT NULL,
  "replication_caught_up_at" timestamp with time zone,
  "last_verified_at" timestamp with time zone,
  "bootstrap_state" text DEFAULT 'pending' NOT NULL,
  "bootstrap_barrier_sequence" bigint,
  "bootstrap_cursor" text,
  "bootstrap_objects_copied" bigint DEFAULT 0 NOT NULL,
  "bootstrap_bytes_copied" bigint DEFAULT 0 NOT NULL,
  "bootstrap_source_backend_id" text,
  "bootstrap_source_generation" bigint,
  "bootstrap_started_at" timestamp with time zone,
  "bootstrap_heartbeat_at" timestamp with time zone,
  "bootstrap_completed_at" timestamp with time zone,
  "bootstrap_verified_at" timestamp with time zone,
  "bootstrap_last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("region_id", "backend_id"),
  CONSTRAINT "storage_region_backends_role_check" CHECK ("role" IN ('primary', 'replica')),
  CONSTRAINT "storage_region_backends_status_check" CHECK ("status" IN ('active', 'standby', 'unavailable', 'disabled')),
  CONSTRAINT "storage_region_backends_checkpoint_check" CHECK ("replication_checkpoint" >= 0),
  CONSTRAINT "storage_region_backends_bootstrap_state_check" CHECK ("bootstrap_state" IN ('pending', 'running', 'verifying', 'complete', 'failed')),
  CONSTRAINT "storage_region_backends_bootstrap_progress_check" CHECK (
    ("bootstrap_barrier_sequence" IS NULL OR "bootstrap_barrier_sequence" >= 0)
    AND "bootstrap_objects_copied" >= 0
    AND "bootstrap_bytes_copied" >= 0
    AND ("bootstrap_source_generation" IS NULL OR "bootstrap_source_generation" > 0)
  ),
  CONSTRAINT "storage_region_backends_bootstrap_complete_check" CHECK (
    "bootstrap_state" <> 'complete' OR (
      "bootstrap_barrier_sequence" IS NOT NULL
      AND "bootstrap_started_at" IS NOT NULL
      AND "bootstrap_completed_at" IS NOT NULL
      AND "bootstrap_verified_at" IS NOT NULL
      AND "bootstrap_last_error" IS NULL
      AND "replication_checkpoint" >= "bootstrap_barrier_sequence"
    )
  ),
  CONSTRAINT "storage_region_backends_promotion_bootstrap_check" CHECK (
    "promotion_authorized" = false OR (
      "bootstrap_state" = 'complete'
      AND "bootstrap_verified_at" IS NOT NULL
      AND "bootstrap_barrier_sequence" IS NOT NULL
      AND "replication_checkpoint" >= "bootstrap_barrier_sequence"
    )
  ),
  CONSTRAINT "storage_region_backends_bootstrap_source_fk" FOREIGN KEY ("region_id", "bootstrap_source_backend_id")
    REFERENCES "storage_region_backends" ("region_id", "backend_id"),
  CONSTRAINT "storage_region_backends_region_id_check" CHECK ("region_id" ~ '^[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT "storage_region_backends_backend_id_check" CHECK ("backend_id" ~ '^[a-z0-9][a-z0-9-]*$')
);
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_state" text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_barrier_sequence" bigint;
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_cursor" text;
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_objects_copied" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_bytes_copied" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_source_backend_id" text;
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_source_generation" bigint;
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_heartbeat_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "storage_region_backends" ADD COLUMN IF NOT EXISTS "bootstrap_last_error" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_region_backends" ADD CONSTRAINT "storage_region_backends_bootstrap_state_check" CHECK ("bootstrap_state" IN ('pending', 'running', 'verifying', 'complete', 'failed'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_region_backends" ADD CONSTRAINT "storage_region_backends_bootstrap_progress_check" CHECK (
   ("bootstrap_barrier_sequence" IS NULL OR "bootstrap_barrier_sequence" >= 0)
   AND "bootstrap_objects_copied" >= 0
   AND "bootstrap_bytes_copied" >= 0
   AND ("bootstrap_source_generation" IS NULL OR "bootstrap_source_generation" > 0)
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_region_backends_region_status_idx" ON "storage_region_backends" ("region_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storage_region_backends_one_active_idx" ON "storage_region_backends" ("region_id") WHERE "status" = 'active';
--> statement-breakpoint
INSERT INTO "storage_region_backends" (
  "region_id", "backend_id", "provider", "bucket_name", "role", "status",
  "promotion_authorized", "replication_checkpoint", "replication_caught_up_at", "last_verified_at",
  "bootstrap_state", "bootstrap_barrier_sequence", "bootstrap_objects_copied", "bootstrap_bytes_copied",
  "bootstrap_started_at", "bootstrap_completed_at", "bootstrap_verified_at"
) VALUES
  ('eu-central', 'primary', 'backblaze-b2', NULL, 'primary', 'active', false, 0, now(), now(), 'complete', 0, 0, 0, now(), now(), now()),
  ('us-east', 'primary', 'backblaze-b2', NULL, 'primary', 'active', false, 0, now(), now(), 'complete', 0, 0, 0, now(), now(), now())
ON CONFLICT ("region_id", "backend_id") DO NOTHING;
--> statement-breakpoint
UPDATE "storage_region_backends"
SET "bootstrap_state" = 'complete',
    "bootstrap_barrier_sequence" = COALESCE("bootstrap_barrier_sequence", "replication_checkpoint"),
    "bootstrap_started_at" = COALESCE("bootstrap_started_at", "created_at"),
    "bootstrap_completed_at" = COALESCE("bootstrap_completed_at", now()),
    "bootstrap_verified_at" = COALESCE("bootstrap_verified_at", "last_verified_at", now()),
    "bootstrap_last_error" = NULL
WHERE "status" = 'active';
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_region_backends" ADD CONSTRAINT "storage_region_backends_bootstrap_complete_check" CHECK (
   "bootstrap_state" <> 'complete' OR (
     "bootstrap_barrier_sequence" IS NOT NULL
     AND "bootstrap_started_at" IS NOT NULL
     AND "bootstrap_completed_at" IS NOT NULL
     AND "bootstrap_verified_at" IS NOT NULL
     AND "bootstrap_last_error" IS NULL
     AND "replication_checkpoint" >= "bootstrap_barrier_sequence"
   )
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_region_backends" ADD CONSTRAINT "storage_region_backends_promotion_bootstrap_check" CHECK (
   "promotion_authorized" = false OR (
     "bootstrap_state" = 'complete'
     AND "bootstrap_verified_at" IS NOT NULL
     AND "bootstrap_barrier_sequence" IS NOT NULL
     AND "replication_checkpoint" >= "bootstrap_barrier_sequence"
   )
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_region_backends" ADD CONSTRAINT "storage_region_backends_bootstrap_source_fk" FOREIGN KEY ("region_id", "bootstrap_source_backend_id")
   REFERENCES "storage_region_backends" ("region_id", "backend_id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_region_state" (
  "region_id" text PRIMARY KEY NOT NULL,
  "active_backend_id" text NOT NULL,
  "backend_generation" bigint DEFAULT 1 NOT NULL,
  "required_replication_checkpoint" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "storage_region_state_generation_check" CHECK ("backend_generation" > 0),
  CONSTRAINT "storage_region_state_checkpoint_check" CHECK ("required_replication_checkpoint" >= 0),
  CONSTRAINT "storage_region_state_region_id_check" CHECK ("region_id" ~ '^[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT "storage_region_state_active_backend_fk" FOREIGN KEY ("region_id", "active_backend_id")
    REFERENCES "storage_region_backends" ("region_id", "backend_id")
);
--> statement-breakpoint
INSERT INTO "storage_region_state" (
  "region_id", "active_backend_id", "backend_generation", "required_replication_checkpoint"
) VALUES
  ('eu-central', 'primary', 1, 0),
  ('us-east', 'primary', 1, 0)
ON CONFLICT ("region_id") DO NOTHING;
--> statement-breakpoint
UPDATE "storage_region_backends" SET "promotion_authorized" = false WHERE "status" = 'active' AND "promotion_authorized" = true;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storage_region_backends_one_authorized_idx" ON "storage_region_backends" ("region_id") WHERE "promotion_authorized" = true;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buckets" ADD CONSTRAINT "buckets_resolved_region_fk" FOREIGN KEY ("resolved_region") REFERENCES "storage_region_state" ("region_id") ON DELETE restrict;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_backend_promotions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "region_id" text NOT NULL,
  "from_backend_id" text NOT NULL,
  "to_backend_id" text NOT NULL,
  "old_backend_generation" bigint NOT NULL,
  "new_backend_generation" bigint NOT NULL,
  "required_replication_checkpoint" bigint NOT NULL,
  "observed_replication_checkpoint" bigint NOT NULL,
  "actor" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "storage_backend_promotions_from_backend_fk" FOREIGN KEY ("region_id", "from_backend_id")
    REFERENCES "storage_region_backends" ("region_id", "backend_id"),
  CONSTRAINT "storage_backend_promotions_to_backend_fk" FOREIGN KEY ("region_id", "to_backend_id")
    REFERENCES "storage_region_backends" ("region_id", "backend_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_backend_promotions_region_created_at_idx" ON "storage_backend_promotions" ("region_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_backend_admin_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "region_id" text NOT NULL,
  "backend_id" text NOT NULL,
  "action" text NOT NULL,
  "actor" text NOT NULL,
  "details_json" text DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "storage_backend_admin_events_backend_fk" FOREIGN KEY ("region_id", "backend_id")
    REFERENCES "storage_region_backends" ("region_id", "backend_id"),
  CONSTRAINT "storage_backend_admin_events_action_check" CHECK ("action" IN ('register', 'status', 'bootstrap', 'bootstrap_retry', 'authorize', 'revoke'))
);
--> statement-breakpoint
ALTER TABLE "storage_backend_admin_events" DROP CONSTRAINT IF EXISTS "storage_backend_admin_events_action_check";
--> statement-breakpoint
ALTER TABLE "storage_backend_admin_events" ADD CONSTRAINT "storage_backend_admin_events_action_check" CHECK ("action" IN ('register', 'status', 'bootstrap', 'bootstrap_retry', 'authorize', 'revoke'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_backend_admin_events_region_created_at_idx" ON "storage_backend_admin_events" ("region_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_replication_events" (
  "sequence" bigserial PRIMARY KEY NOT NULL,
  "event_id" uuid DEFAULT gen_random_uuid() NOT NULL UNIQUE,
  "region_id" text NOT NULL,
  "source_backend_id" text NOT NULL,
  "backend_generation" bigint NOT NULL,
  "bucket_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"operation" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
  "finalized_at" timestamp with time zone,
	CONSTRAINT "storage_replication_events_sequence_region_unique" UNIQUE ("sequence", "region_id"),
  CONSTRAINT "storage_replication_events_source_backend_fk" FOREIGN KEY ("region_id", "source_backend_id")
    REFERENCES "storage_region_backends" ("region_id", "backend_id"),
  CONSTRAINT "storage_replication_events_backend_generation_check" CHECK ("backend_generation" > 0),
  CONSTRAINT "storage_replication_events_operation_check" CHECK ("operation" IN ('put', 'delete')),
  CONSTRAINT "storage_replication_events_state_check" CHECK ("state" IN ('prepared', 'committed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_replication_events_region_sequence_idx" ON "storage_replication_events" ("region_id", "sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_replication_events_committed_sequence_idx" ON "storage_replication_events" ("region_id", "sequence") WHERE "state" = 'committed';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_replication_deliveries" (
	"sequence" bigint NOT NULL,
	"region_id" text NOT NULL,
	"target_backend_id" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("sequence", "target_backend_id"),
	CONSTRAINT "storage_replication_deliveries_event_fk" FOREIGN KEY ("sequence", "region_id")
	  REFERENCES "storage_replication_events" ("sequence", "region_id") ON DELETE cascade,
	CONSTRAINT "storage_replication_deliveries_target_backend_fk" FOREIGN KEY ("region_id", "target_backend_id")
	  REFERENCES "storage_region_backends" ("region_id", "backend_id"),
  CONSTRAINT "storage_replication_deliveries_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "storage_replication_deliveries_status_check" CHECK ("status" IN ('pending', 'running', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_replication_deliveries_pending_idx" ON "storage_replication_deliveries" ("status", "next_attempt_at", "sequence") WHERE "status" IN ('pending', 'failed');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION silo_advance_required_replication_checkpoint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "storage_region_state"
  SET "required_replication_checkpoint" = GREATEST("required_replication_checkpoint", NEW."sequence"),
      "updated_at" = now()
  WHERE "region_id" = NEW."region_id";
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS storage_replication_event_checkpoint ON "storage_replication_events";
--> statement-breakpoint
CREATE TRIGGER storage_replication_event_checkpoint
AFTER INSERT ON "storage_replication_events"
FOR EACH ROW EXECUTE FUNCTION silo_advance_required_replication_checkpoint();
--> statement-breakpoint
ALTER TABLE "multipart_upload_generations" ADD COLUMN IF NOT EXISTS "storage_region" text DEFAULT 'eu-central' NOT NULL;
--> statement-breakpoint
ALTER TABLE "multipart_upload_generations" ADD COLUMN IF NOT EXISTS "backend_id" text DEFAULT 'primary' NOT NULL;
--> statement-breakpoint
ALTER TABLE "multipart_upload_generations" ADD COLUMN IF NOT EXISTS "backend_generation" bigint DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "multipart_upload_generations_storage_region_idx" ON "multipart_upload_generations" ("storage_region");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "multipart_upload_generations" ADD CONSTRAINT "multipart_upload_generations_storage_region_check" CHECK ("storage_region" ~ '^[a-z0-9][a-z0-9-]*$');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "multipart_upload_generations" ADD CONSTRAINT "multipart_upload_generations_backend_generation_check" CHECK ("backend_generation" > 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "multipart_upload_generations" ADD CONSTRAINT "multipart_upload_generations_storage_backend_fk" FOREIGN KEY ("storage_region", "backend_id") REFERENCES "storage_region_backends" ("region_id", "backend_id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
INSERT INTO "dataplane_writer_lease" (
  "name",
  "holder_id",
  "generation",
  "lease_expires_at",
  "updated_at"
)
SELECT
  's3:eu-central',
  "holder_id",
  "generation",
  "lease_expires_at",
  "updated_at"
FROM "dataplane_writer_lease"
WHERE "name" = 's3'
ON CONFLICT ("name") DO UPDATE SET
  "holder_id" = CASE
    WHEN EXCLUDED."generation" > "dataplane_writer_lease"."generation" THEN EXCLUDED."holder_id"
    ELSE "dataplane_writer_lease"."holder_id"
  END,
  "generation" = GREATEST(EXCLUDED."generation", "dataplane_writer_lease"."generation"),
  "lease_expires_at" = CASE
    WHEN EXCLUDED."generation" > "dataplane_writer_lease"."generation" THEN EXCLUDED."lease_expires_at"
    ELSE "dataplane_writer_lease"."lease_expires_at"
  END,
  "updated_at" = GREATEST(EXCLUDED."updated_at", "dataplane_writer_lease"."updated_at");
--> statement-breakpoint
DELETE FROM "dataplane_writer_lease" WHERE "name" = 's3';
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dataplane_writer_lease" ADD CONSTRAINT "dataplane_writer_lease_region_name_check" CHECK ("name" ~ '^s3:[a-z0-9][a-z0-9-]*$');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataplane_quota_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE cascade,
  "kind" text DEFAULT 'storage' NOT NULL,
  "bytes" bigint NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "dataplane_quota_reservations_kind_check" CHECK ("kind" = 'storage'),
  CONSTRAINT "dataplane_quota_reservations_bytes_check" CHECK ("bytes" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataplane_quota_reservations_user_kind_expiry_idx" ON "dataplane_quota_reservations" ("user_id", "kind", "expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataplane_mutation_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "region_id" text NOT NULL REFERENCES "storage_region_state" ("region_id") ON DELETE restrict,
  "bucket_id" uuid NOT NULL REFERENCES "buckets" ("id") ON DELETE restrict,
  "user_id" text REFERENCES "users" ("id") ON DELETE restrict,
  "object_key" text NOT NULL,
  "operation" text NOT NULL,
  "old_size" bigint NOT NULL,
  "new_size" bigint NOT NULL,
  "quota_reservation_id" uuid REFERENCES "dataplane_quota_reservations" ("id") ON DELETE set null,
  "replication_event_id" uuid REFERENCES "storage_replication_events" ("event_id") ON DELETE restrict,
  "state" text DEFAULT 'prepared' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "committed_at" timestamp with time zone,
  "applied_at" timestamp with time zone,
  "last_error" text,
  CONSTRAINT "dataplane_mutation_intents_operation_check" CHECK ("operation" IN ('put', 'delete')),
  CONSTRAINT "dataplane_mutation_intents_state_check" CHECK ("state" IN ('prepared', 'committed', 'cancelled', 'applied')),
  CONSTRAINT "dataplane_mutation_intents_size_check" CHECK ("old_size" >= 0 AND "new_size" >= 0),
  CONSTRAINT "dataplane_mutation_intents_state_timestamps_check" CHECK (
    ("state" NOT IN ('committed', 'applied') OR "committed_at" IS NOT NULL)
    AND ("state" <> 'applied' OR "applied_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataplane_mutation_intents_state_created_at_idx" ON "dataplane_mutation_intents" ("state", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataplane_mutation_intents_region_bucket_state_idx" ON "dataplane_mutation_intents" ("region_id", "bucket_id", "state");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dataplane_mutation_intents_replication_event_unique_idx" ON "dataplane_mutation_intents" ("replication_event_id") WHERE "replication_event_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataplane_multipart_quota_uploads" (
  "upload_id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE cascade,
  "bucket_id" uuid NOT NULL REFERENCES "buckets" ("id") ON DELETE cascade,
  "storage_region" text NOT NULL,
  "backend_id" text NOT NULL,
  "backend_generation" bigint NOT NULL,
  "existing_credit" bigint DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "dataplane_multipart_quota_uploads_backend_fk" FOREIGN KEY ("storage_region", "backend_id")
    REFERENCES "storage_region_backends" ("region_id", "backend_id"),
  CONSTRAINT "dataplane_multipart_quota_uploads_region_check" CHECK ("storage_region" ~ '^[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT "dataplane_multipart_quota_uploads_generation_check" CHECK ("backend_generation" > 0),
  CONSTRAINT "dataplane_multipart_quota_uploads_credit_check" CHECK ("existing_credit" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataplane_multipart_quota_uploads_expires_at_idx" ON "dataplane_multipart_quota_uploads" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataplane_multipart_quota_parts" (
  "upload_id" text NOT NULL REFERENCES "dataplane_multipart_quota_uploads" ("upload_id") ON DELETE cascade,
  "part_number" integer NOT NULL,
  "part_bytes" bigint DEFAULT 0 NOT NULL,
  PRIMARY KEY ("upload_id", "part_number"),
  CONSTRAINT "dataplane_multipart_quota_parts_part_number_check" CHECK ("part_number" BETWEEN 1 AND 10000),
  CONSTRAINT "dataplane_multipart_quota_parts_bytes_check" CHECK ("part_bytes" >= 0)
);
