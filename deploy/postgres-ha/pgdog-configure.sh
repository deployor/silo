#!/bin/sh
set -eu

: "${SILO_DATABASE_NAME:?SILO_DATABASE_NAME is required}"
: "${SILO_DATABASE_USER:?SILO_DATABASE_USER is required}"
: "${SILO_DATABASE_PASSWORD:?SILO_DATABASE_PASSWORD is required}"
: "${PGDOG_ADMIN_PASSWORD:?PGDOG_ADMIN_PASSWORD is required}"
: "${PGDOG_EU_HOST:?PGDOG_EU_HOST is required}"
: "${PGDOG_US_HOST:?PGDOG_US_HOST is required}"

umask 077
mkdir -p /config

cat > /config/pgdog.toml <<EOF
[general]
host = "0.0.0.0"
port = 6432
workers = ${PGDOG_WORKERS:-4}
default_pool_size = ${PGDOG_POOL_SIZE:-16}
min_pool_size = ${PGDOG_MIN_POOL_SIZE:-2}
pooler_mode = "transaction"
prepared_statements = "extended"
prepared_statements_limit = 500
checkout_timeout = 5000
connect_timeout = 3000
connect_attempts = 2
connect_attempt_delay = 250
rollback_timeout = 5000
idle_timeout = 300000
client_idle_in_transaction_timeout = 60000
client_login_timeout = 10000
server_lifetime = 21600000
server_lifetime_jitter = 1800000
healthcheck_interval = 5000
idle_healthcheck_delay = 5000
idle_healthcheck_interval = 5000
healthcheck_timeout = 2000
healthcheck_port = 8080
openmetrics_port = 9090
openmetrics_namespace = "silo_pgdog_"
load_balancing_strategy = "least_active_connections"
read_write_strategy = "conservative"
read_write_split = "prefer_primary"
lsn_check_delay = 0
lsn_check_interval = 1000
lsn_check_timeout = 2000
ban_timeout = 30000
auth_type = "scram"
tls_verify = "verify_full"
tls_server_ca_certificate = "/tls/ca.crt"
log_format = "json_flattened"
log_level = "info"
log_connections = false
log_disconnections = false
log_dedup_window = 5000
log_dedup_threshold = 5

[tcp]
keepalive = true
time = 60000
interval = 60000
retries = 3
user_timeout = 5000

[[databases]]
name = "${SILO_DATABASE_NAME}"
database_name = "${SILO_DATABASE_NAME}"
host = "${PGDOG_EU_HOST}"
port = ${PGDOG_EU_PORT:-25432}
role = "auto"
shard = 0
pool_size = ${PGDOG_POOL_SIZE:-16}
min_pool_size = ${PGDOG_MIN_POOL_SIZE:-2}
pooler_mode = "transaction"
lock_timeout = 10000
statement_timeout = 120000

[[databases]]
name = "${SILO_DATABASE_NAME}"
database_name = "${SILO_DATABASE_NAME}"
host = "${PGDOG_US_HOST}"
port = ${PGDOG_US_PORT:-25432}
role = "auto"
shard = 0
pool_size = ${PGDOG_POOL_SIZE:-16}
min_pool_size = ${PGDOG_MIN_POOL_SIZE:-2}
pooler_mode = "transaction"
lock_timeout = 10000
statement_timeout = 120000

[admin]
name = "admin"
password = "${PGDOG_ADMIN_PASSWORD}"
EOF

cat > /config/users.toml <<EOF
[[users]]
name = "${SILO_DATABASE_USER}"
password = "${SILO_DATABASE_PASSWORD}"
database = "${SILO_DATABASE_NAME}"
server_user = "${SILO_DATABASE_USER}"
server_password = "${SILO_DATABASE_PASSWORD}"
pool_size = ${PGDOG_POOL_SIZE:-16}
min_pool_size = ${PGDOG_MIN_POOL_SIZE:-2}
pooler_mode = "transaction"
lock_timeout = 10000
statement_timeout = 120000
EOF

chown 65532:65532 /config/pgdog.toml /config/users.toml
chmod 400 /config/pgdog.toml /config/users.toml
