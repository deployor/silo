#!/bin/sh
set -eu

: "${SILO_DATABASE_NAME:?SILO_DATABASE_NAME is required}"
: "${SILO_DATABASE_USER:?SILO_DATABASE_USER is required}"
: "${SILO_DATABASE_PASSWORD:?SILO_DATABASE_PASSWORD is required}"
: "${POSTGRES_REPLICATION_USER:?POSTGRES_REPLICATION_USER is required}"
: "${POSTGRES_REPLICATION_PASSWORD:?POSTGRES_REPLICATION_PASSWORD is required}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  --set=app_user="$SILO_DATABASE_USER" \
  --set=app_password="$SILO_DATABASE_PASSWORD" \
  --set=replication_user="$POSTGRES_REPLICATION_USER" \
  --set=replication_password="$POSTGRES_REPLICATION_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('CREATE ROLE %I LOGIN REPLICATION PASSWORD %L', :'replication_user', :'replication_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'replication_user') \gexec

CREATE TABLE IF NOT EXISTS public.database_ha_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  active_region text NOT NULL DEFAULT 'eu-central',
  promoted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.database_ha_state (singleton, generation, active_region)
VALUES (true, 1, 'eu-central')
ON CONFLICT (singleton) DO NOTHING;
SQL

cat > "$PGDATA/pg_hba.conf" <<EOF
local   all             all                                      trust
hostssl all             all             10.0.0.0/8               scram-sha-256
hostssl all             all             172.16.0.0/12            scram-sha-256
hostssl all             all             192.168.0.0/16           scram-sha-256
hostssl replication     ${POSTGRES_REPLICATION_USER} ${POSTGRES_EU_PUBLIC_IP}/32 scram-sha-256
hostssl replication     ${POSTGRES_REPLICATION_USER} ${POSTGRES_US_PUBLIC_IP}/32 scram-sha-256
hostssl ${SILO_DATABASE_NAME} ${SILO_DATABASE_USER} ${POSTGRES_EU_PUBLIC_IP}/32 scram-sha-256
hostssl ${SILO_DATABASE_NAME} ${SILO_DATABASE_USER} ${POSTGRES_US_PUBLIC_IP}/32 scram-sha-256
EOF
