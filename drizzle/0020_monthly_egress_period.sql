ALTER TABLE "users" ADD COLUMN "egress_period" text;

UPDATE "users"
SET
  "egress_bytes" = 0,
  "egress_period" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
