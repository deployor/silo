#!/bin/sh
set -eu

: "${CLICKHOUSE_INGEST_PASSWORD:?CLICKHOUSE_INGEST_PASSWORD is required}"
: "${CLICKHOUSE_QUERY_PASSWORD:?CLICKHOUSE_QUERY_PASSWORD is required}"
: "${CLICKHOUSE_ADMIN_PASSWORD:?CLICKHOUSE_ADMIN_PASSWORD is required}"

case "${CLICKHOUSE_INGEST_PASSWORD}${CLICKHOUSE_QUERY_PASSWORD}" in
  *"'"*) echo "ClickHouse passwords must not contain single quotes" >&2; exit 1 ;;
esac

clickhouse client --host "${CLICKHOUSE_HOST:-localhost}" --user silo_admin --password "$CLICKHOUSE_ADMIN_PASSWORD" --multiquery --query "
CREATE USER IF NOT EXISTS silo_ingest IDENTIFIED WITH sha256_password BY '${CLICKHOUSE_INGEST_PASSWORD}';
ALTER USER silo_ingest IDENTIFIED WITH sha256_password BY '${CLICKHOUSE_INGEST_PASSWORD}';
GRANT INSERT ON silo_logs.request_logs TO silo_ingest;
GRANT INSERT ON silo_logs.ingest_heartbeats TO silo_ingest;

CREATE USER IF NOT EXISTS silo_query IDENTIFIED WITH sha256_password BY '${CLICKHOUSE_QUERY_PASSWORD}';
ALTER USER silo_query IDENTIFIED WITH sha256_password BY '${CLICKHOUSE_QUERY_PASSWORD}';
GRANT SELECT ON silo_logs.* TO silo_query;
"
