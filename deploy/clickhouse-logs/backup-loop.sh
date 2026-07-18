#!/bin/sh
set -eu

: "${CLICKHOUSE_ADMIN_PASSWORD:?CLICKHOUSE_ADMIN_PASSWORD is required}"
: "${CLICKHOUSE_BACKUP_EU_URL:?CLICKHOUSE_BACKUP_EU_URL is required}"
: "${CLICKHOUSE_BACKUP_EU_KEY_ID:?CLICKHOUSE_BACKUP_EU_KEY_ID is required}"
: "${CLICKHOUSE_BACKUP_EU_KEY_SECRET:?CLICKHOUSE_BACKUP_EU_KEY_SECRET is required}"
: "${CLICKHOUSE_BACKUP_US_URL:?CLICKHOUSE_BACKUP_US_URL is required}"
: "${CLICKHOUSE_BACKUP_US_KEY_ID:?CLICKHOUSE_BACKUP_US_KEY_ID is required}"
: "${CLICKHOUSE_BACKUP_US_KEY_SECRET:?CLICKHOUSE_BACKUP_US_KEY_SECRET is required}"

case "${CLICKHOUSE_BACKUP_EU_URL}${CLICKHOUSE_BACKUP_EU_KEY_ID}${CLICKHOUSE_BACKUP_EU_KEY_SECRET}${CLICKHOUSE_BACKUP_US_URL}${CLICKHOUSE_BACKUP_US_KEY_ID}${CLICKHOUSE_BACKUP_US_KEY_SECRET}" in
  *"'"*) echo "backup settings must not contain single quotes" >&2; exit 1 ;;
esac

interval="${CLICKHOUSE_BACKUP_INTERVAL_SECONDS:-21600}"
case "$interval" in *[!0-9]*|'') echo "invalid backup interval" >&2; exit 1 ;; esac

sleep "${CLICKHOUSE_BACKUP_INITIAL_DELAY_SECONDS:-300}"
while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  for repository in eu us; do
    if [ "$repository" = eu ]; then
      url="$CLICKHOUSE_BACKUP_EU_URL/$SILO_REGION/$stamp.zip"
      key_id="$CLICKHOUSE_BACKUP_EU_KEY_ID"
      key_secret="$CLICKHOUSE_BACKUP_EU_KEY_SECRET"
    else
      url="$CLICKHOUSE_BACKUP_US_URL/$SILO_REGION/$stamp.zip"
      key_id="$CLICKHOUSE_BACKUP_US_KEY_ID"
      key_secret="$CLICKHOUSE_BACKUP_US_KEY_SECRET"
    fi
    if ! clickhouse client \
      --host clickhouse \
      --user silo_admin \
      --password "$CLICKHOUSE_ADMIN_PASSWORD" \
      --query "BACKUP DATABASE silo_logs TO S3('$url', '$key_id', '$key_secret') SETTINGS compression_method='zstd'"; then
      echo "backup to $repository repository failed; the other repository remains independent" >&2
    fi
  done
  sleep "$interval"
done
