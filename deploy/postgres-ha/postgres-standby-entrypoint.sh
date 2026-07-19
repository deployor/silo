#!/bin/sh
set -eu

: "${PRIMARY_DATABASE_HOST:?PRIMARY_DATABASE_HOST is required}"
: "${POSTGRES_REPLICATION_USER:?POSTGRES_REPLICATION_USER is required}"
: "${POSTGRES_REPLICATION_PASSWORD:?POSTGRES_REPLICATION_PASSWORD is required}"
: "${POSTGRES_REPLICATION_SLOT:?POSTGRES_REPLICATION_SLOT is required}"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  rm -rf "${PGDATA:?}"/*
  export PGPASSWORD="$POSTGRES_REPLICATION_PASSWORD"
  until pg_isready -h "$PRIMARY_DATABASE_HOST" -p "${PRIMARY_DATABASE_PORT:-25432}" -U "$POSTGRES_REPLICATION_USER"; do
    sleep 2
  done
  pg_basebackup \
    --host="$PRIMARY_DATABASE_HOST" \
    --port="${PRIMARY_DATABASE_PORT:-25432}" \
    --username="$POSTGRES_REPLICATION_USER" \
    --pgdata="$PGDATA" \
    --wal-method=stream \
    --checkpoint=fast \
    --write-recovery-conf \
    --create-slot \
    --slot="$POSTGRES_REPLICATION_SLOT" \
    --progress
  chmod 700 "$PGDATA"
fi

touch "$PGDATA/postgresql.auto.conf"
sed -i '/^default_transaction_read_only[[:space:]]*=/d' "$PGDATA/postgresql.auto.conf"
printf "default_transaction_read_only = 'on'\n" >> "$PGDATA/postgresql.auto.conf"

exec docker-entrypoint.sh postgres "$@"
