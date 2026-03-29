#!/bin/zsh
set -euo pipefail

if ! command -v rclone >/dev/null 2>&1; then
  echo "rclone is not installed. Install it first: brew install rclone"
  exit 1
fi

TMP_CONFIG="$(mktemp -t rclone-impossibleapi-mega.XXXXXX.conf)"
cleanup() {
  rm -f "$TMP_CONFIG"
}
trap cleanup EXIT

cat > "$TMP_CONFIG" <<'EOF'
[source]
type = s3
provider = Other
access_key_id = 99372DCDE7ED092C3864
secret_access_key = c512d92d13d76be8e1b67b22e1f64576e7b4e6bf
endpoint = https://eu-central-2.storage.impossibleapi.net
region = eu-central-2
force_path_style = true
no_check_bucket = true

[destination]
type = s3
provider = Other
access_key_id = AKIAWEUXIXZA3HE7IXBUEDUCUS7TOKCNVWL5HKE7I2QM
secret_access_key = KfL9WvSHqjwY8LSiv5ajKPJwAtjyS9jGcMVE57tf
endpoint = s3.eu-central-1.s4.mega.io
region = eu-central-1
force_path_style = true
no_check_bucket = true
EOF

echo "Starting rclone copy from source:silodevtest to destination:silo"
RCLONE_CONFIG="$TMP_CONFIG" rclone copy source:silodevtest destination:silo \
  --progress \
  --transfers 32 \
  --checkers 64 \
  --metadata \
  --use-server-modtime \
  --no-update-modtime \
  --s3-copy-cutoff 1 \
  --multi-thread-streams 16 \
  --multi-thread-cutoff 16M \
  --buffer-size 32M \
  --check-first \
  --retries 10 \
  --low-level-retries 20 \
  --ignore-checksum=false
