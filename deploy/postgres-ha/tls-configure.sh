#!/bin/sh
set -eu

: "${POSTGRES_TLS_CA_B64:?POSTGRES_TLS_CA_B64 is required}"
: "${POSTGRES_TLS_CERT_B64:?POSTGRES_TLS_CERT_B64 is required}"
: "${POSTGRES_TLS_KEY_B64:?POSTGRES_TLS_KEY_B64 is required}"

umask 077
mkdir -p /tls
printf '%s' "$POSTGRES_TLS_CA_B64" | base64 -d > /tls/ca.crt
printf '%s' "$POSTGRES_TLS_CERT_B64" | base64 -d > /tls/server.crt
printf '%s' "$POSTGRES_TLS_KEY_B64" | base64 -d > /tls/server.key
chown 999:999 /tls/server.crt /tls/server.key
chmod 0644 /tls/ca.crt /tls/server.crt
chmod 0600 /tls/server.key
