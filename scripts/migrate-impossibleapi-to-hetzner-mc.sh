#!/bin/zsh
set -euo pipefail

SRC_ENDPOINT="https://eu-central-2.storage.impossibleapi.net"
SRC_ACCESS_KEY="99372DCDE7ED092C3864"
SRC_SECRET_KEY="c512d92d13d76be8e1b67b22e1f64576e7b4e6bf"
SRC_BUCKET="silodevtest"

DST_ENDPOINT="https://fsn1.your-objectstorage.com"
DST_ACCESS_KEY="FUSNFCBNTWL68LLKIHUW"
DST_SECRET_KEY="oHaL0sfNNQqKVHBPR979KeVrd19QuPYIDJO55n9t"
DST_BUCKET="hcsilodev"

if ! command -v rclone >/dev/null 2>&1; then
  echo "rclone is not installed. Install it first: brew install rclone"
  exit 1
fi

echo "Starting recursive copy from $SRC_BUCKET to $DST_BUCKET"
rclone copy \
  ":s3:${SRC_BUCKET}" \
  ":s3:${DST_BUCKET}" \
  --s3-provider Other \
  --s3-access-key-id "$SRC_ACCESS_KEY" \
  --s3-secret-access-key "$SRC_SECRET_KEY" \
  --s3-endpoint "$SRC_ENDPOINT" \
  --s3-region eu-central-2 \
  --s3-force-path-style \
  --s3-no-check-bucket \
  --s3-destination-provider Other \
  --s3-destination-access-key-id "$DST_ACCESS_KEY" \
  --s3-destination-secret-access-key "$DST_SECRET_KEY" \
  --s3-destination-endpoint "$DST_ENDPOINT" \
  --s3-destination-region fsn1 \
  --s3-destination-force-path-style \
  --s3-destination-no-check-bucket \
  --transfers 64 \
  --checkers 128 \
  --multi-thread-streams 16 \
  --multi-thread-cutoff 16M \
  --buffer-size 32M \
  --progress
