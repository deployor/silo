ALTER TABLE "app_settings" ADD COLUMN "s3_maintenance_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "full_maintenance_mode" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
INSERT INTO "app_settings" ("id") VALUES ('global') ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION silo_block_writes_during_maintenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE((SELECT full_maintenance_mode FROM app_settings WHERE id = 'global'), false)
     AND TG_TABLE_NAME <> 'app_settings' THEN
    RAISE EXCEPTION 'Planned maintenance is in progress.' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOR table_name IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'app_settings'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS silo_maintenance_write_guard ON %I; CREATE TRIGGER silo_maintenance_write_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION silo_block_writes_during_maintenance();',
      table_name, table_name
    );
  END LOOP;
END;
$$;
