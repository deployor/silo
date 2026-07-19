CREATE TABLE IF NOT EXISTS "database_ha_state" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"active_region" text DEFAULT 'eu-central' NOT NULL,
	"promoted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_ha_state_singleton_check" CHECK ("singleton"),
	CONSTRAINT "database_ha_state_generation_check" CHECK ("generation" > 0)
);
--> statement-breakpoint
INSERT INTO "database_ha_state" ("singleton", "generation", "active_region")
VALUES (true, 1, 'eu-central')
ON CONFLICT ("singleton") DO NOTHING;
