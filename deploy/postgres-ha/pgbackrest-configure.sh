#!/bin/sh
set -eu

: "${PGBACKREST_REPO1_ENDPOINT:?PGBACKREST_REPO1_ENDPOINT is required}"
: "${PGBACKREST_REPO1_BUCKET:?PGBACKREST_REPO1_BUCKET is required}"
: "${PGBACKREST_REPO1_KEY:?PGBACKREST_REPO1_KEY is required}"
: "${PGBACKREST_REPO1_KEY_SECRET:?PGBACKREST_REPO1_KEY_SECRET is required}"
: "${PGBACKREST_REPO2_ENDPOINT:?PGBACKREST_REPO2_ENDPOINT is required}"
: "${PGBACKREST_REPO2_BUCKET:?PGBACKREST_REPO2_BUCKET is required}"
: "${PGBACKREST_REPO2_KEY:?PGBACKREST_REPO2_KEY is required}"
: "${PGBACKREST_REPO2_KEY_SECRET:?PGBACKREST_REPO2_KEY_SECRET is required}"
: "${PGBACKREST_CIPHER_PASS:?PGBACKREST_CIPHER_PASS is required}"

umask 077
mkdir -p /config
mkdir -p /spool/archive
cat > /config/pgbackrest.conf <<EOF
[silo]
pg1-path=/var/lib/postgresql/data
pg1-port=5432

[global]
process-max=${PGBACKREST_PROCESS_MAX:-4}
start-fast=y
stop-auto=y
archive-async=y
spool-path=/var/spool/pgbackrest
repo1-type=s3
repo1-path=/postgres-ha
repo1-s3-bucket=${PGBACKREST_REPO1_BUCKET}
repo1-s3-endpoint=${PGBACKREST_REPO1_ENDPOINT}
repo1-s3-region=${PGBACKREST_REPO1_REGION:-auto}
repo1-s3-key=${PGBACKREST_REPO1_KEY}
repo1-s3-key-secret=${PGBACKREST_REPO1_KEY_SECRET}
repo1-s3-uri-style=path
repo1-bundle=y
repo1-block=y
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=${PGBACKREST_CIPHER_PASS}
repo1-retention-full=4
repo1-retention-diff=14
repo1-retention-archive-type=diff
repo1-retention-archive=14
repo2-type=s3
repo2-path=/postgres-ha
repo2-s3-bucket=${PGBACKREST_REPO2_BUCKET}
repo2-s3-endpoint=${PGBACKREST_REPO2_ENDPOINT}
repo2-s3-region=${PGBACKREST_REPO2_REGION:-auto}
repo2-s3-key=${PGBACKREST_REPO2_KEY}
repo2-s3-key-secret=${PGBACKREST_REPO2_KEY_SECRET}
repo2-s3-uri-style=path
repo2-bundle=y
repo2-block=y
repo2-cipher-type=aes-256-cbc
repo2-cipher-pass=${PGBACKREST_CIPHER_PASS}
repo2-retention-full=4
repo2-retention-diff=14
repo2-retention-archive-type=diff
repo2-retention-archive=14

[global:archive-push]
compress-type=zst
compress-level=3
process-max=${PGBACKREST_ARCHIVE_PROCESS_MAX:-2}
EOF
chown 999:999 /config/pgbackrest.conf /spool /spool/archive
chmod 600 /config/pgbackrest.conf
chmod 750 /spool /spool/archive
