#!/bin/sh
set -eu

: "${SILO_REGION:?SILO_REGION is required}"
: "${CLICKHOUSE_BACKUP_EU_URL:?CLICKHOUSE_BACKUP_EU_URL is required}"
: "${CLICKHOUSE_BACKUP_EU_KEY_ID:?CLICKHOUSE_BACKUP_EU_KEY_ID is required}"
: "${CLICKHOUSE_BACKUP_EU_KEY_SECRET:?CLICKHOUSE_BACKUP_EU_KEY_SECRET is required}"
: "${CLICKHOUSE_BACKUP_US_URL:?CLICKHOUSE_BACKUP_US_URL is required}"
: "${CLICKHOUSE_BACKUP_US_KEY_ID:?CLICKHOUSE_BACKUP_US_KEY_ID is required}"
: "${CLICKHOUSE_BACKUP_US_KEY_SECRET:?CLICKHOUSE_BACKUP_US_KEY_SECRET is required}"

keep="${CLICKHOUSE_BACKUP_RETENTION_COUNT:-28}"
interval="${CLICKHOUSE_BACKUP_RETENTION_INTERVAL_SECONDS:-21600}"
initial_delay="${CLICKHOUSE_BACKUP_RETENTION_INITIAL_DELAY_SECONDS:-30}"
export RCLONE_CONFIG=/dev/null

for value in "$keep" "$interval" "$initial_delay"; do
  case "$value" in
    *[!0-9]*|'') echo "retention settings must be non-negative integers" >&2; exit 1 ;;
  esac
done
[ "$keep" -gt 0 ] || { echo "backup retention count must be greater than zero" >&2; exit 1; }
[ "$interval" -gt 0 ] || { echo "retention interval must be greater than zero" >&2; exit 1; }

prune_repository() {
  repository="$1"
  url="$2"
  key_id="$3"
  key_secret="$4"

  case "$url" in
    https://*/*) ;;
    *) echo "$repository backup URL must include an HTTPS endpoint and bucket path" >&2; return 1 ;;
  esac

  endpoint_and_path="${url#https://}"
  endpoint="${endpoint_and_path%%/*}"
  bucket_path="${endpoint_and_path#*/}"
  remote_path="retention:${bucket_path%/}/${SILO_REGION}"
  endpoint_without_prefix="${endpoint#s3.}"
  signing_region="${endpoint_without_prefix%%.*}"
  [ "$signing_region" != "$endpoint" ] || {
    echo "cannot derive the S3 signing region from $repository backup URL" >&2
    return 1
  }

  export RCLONE_CONFIG_RETENTION_TYPE=s3
  export RCLONE_CONFIG_RETENTION_PROVIDER=Other
  export RCLONE_CONFIG_RETENTION_ACCESS_KEY_ID="$key_id"
  export RCLONE_CONFIG_RETENTION_SECRET_ACCESS_KEY="$key_secret"
  export RCLONE_CONFIG_RETENTION_ENDPOINT="https://$endpoint"
  export RCLONE_CONFIG_RETENTION_REGION="$signing_region"
  export RCLONE_CONFIG_RETENTION_NO_CHECK_BUCKET=true

  old_files="$(
    rclone lsf "$remote_path" \
      --files-only \
      --max-depth 1 \
      --include '*.zip' \
      --checkers 4 \
      --retries 5 \
      --low-level-retries 10 |
      LC_ALL=C sort -r |
      awk -v keep="$keep" 'NR > keep'
  )"

  [ -n "$old_files" ] || {
    echo "$repository backup retention is within the $keep-snapshot cap for $SILO_REGION"
    return 0
  }
  printf '%s\n' "$old_files" | while IFS= read -r file; do
    [ -n "$file" ] || continue
    case "$file" in
      */*) echo "refusing to remove unexpected nested backup path: $file" >&2; return 1 ;;
      *.zip) ;;
      *) echo "refusing to remove unexpected backup object: $file" >&2; return 1 ;;
    esac
    rclone deletefile "$remote_path/$file" \
      --retries 5 \
      --low-level-retries 10
    echo "removed expired $repository backup $SILO_REGION/$file"
  done
  echo "$repository backup retention enforced at $keep snapshots for $SILO_REGION"
}

sleep "$initial_delay"
while :; do
  prune_repository eu "$CLICKHOUSE_BACKUP_EU_URL" "$CLICKHOUSE_BACKUP_EU_KEY_ID" "$CLICKHOUSE_BACKUP_EU_KEY_SECRET" ||
    echo "failed to enforce retention in the EU backup repository" >&2
  prune_repository us "$CLICKHOUSE_BACKUP_US_URL" "$CLICKHOUSE_BACKUP_US_KEY_ID" "$CLICKHOUSE_BACKUP_US_KEY_SECRET" ||
    echo "failed to enforce retention in the US backup repository" >&2
  sleep "$interval"
done
