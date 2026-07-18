#!/bin/sh
set -eu

# Every restart is fenced by default. The Cloudflare status controller removes
# the fence only when this node still owns the replicated generation. A stale
# former primary can therefore never return from a reboot accepting writes.
if [ -s "$PGDATA/PG_VERSION" ]; then
  touch "$PGDATA/postgresql.auto.conf"
  sed -i '/^default_transaction_read_only[[:space:]]*=/d' "$PGDATA/postgresql.auto.conf"
  printf "default_transaction_read_only = 'on'\n" >> "$PGDATA/postgresql.auto.conf"
fi

exec docker-entrypoint.sh "$@"
