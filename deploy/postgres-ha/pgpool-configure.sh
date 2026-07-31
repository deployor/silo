#!/bin/sh
set -eu

: "${SILO_DATABASE_NAME:?SILO_DATABASE_NAME is required}"
: "${SILO_DATABASE_USER:?SILO_DATABASE_USER is required}"
: "${SILO_DATABASE_PASSWORD:?SILO_DATABASE_PASSWORD is required}"
: "${PGPOOL_ADMIN_PASSWORD:?PGPOOL_ADMIN_PASSWORD is required}"
: "${POSTGRES_EU_HOST:?POSTGRES_EU_HOST is required}"
: "${POSTGRES_US_HOST:?POSTGRES_US_HOST is required}"

umask 077
mkdir -p /config

cat > /config/pgpool.conf <<EOF
listen_addresses = '*'
port = 6432
socket_dir = '/tmp'
reserved_connections = 2
num_init_children = ${PGPOOL_NUM_INIT_CHILDREN:-16}
max_pool = ${PGPOOL_MAX_POOL:-2}
child_life_time = ${PGPOOL_CHILD_LIFE_TIME:-300}
child_max_connections = ${PGPOOL_CHILD_MAX_CONNECTIONS:-1000}
connection_life_time = ${PGPOOL_CONNECTION_LIFE_TIME:-1800}
client_idle_limit = 0
connection_cache = on
reset_query_list = 'ABORT; DISCARD ALL'

backend_clustering_mode = 'streaming_replication'
backend_hostname0 = '${POSTGRES_EU_HOST}'
backend_port0 = ${POSTGRES_EU_PORT:-25432}
backend_weight0 = 1
backend_data_directory0 = ''
backend_flag0 = 'ALLOW_TO_FAILOVER'
backend_application_name0 = 'silo_eu'
backend_hostname1 = '${POSTGRES_US_HOST}'
backend_port1 = ${POSTGRES_US_PORT:-25432}
backend_weight1 = 1
backend_data_directory1 = ''
backend_flag1 = 'ALLOW_TO_FAILOVER'
backend_application_name1 = 'silo_us'

load_balance_mode = off
statement_level_load_balance = off
disable_load_balance_on_write = 'transaction'
sr_check_period = 2
sr_check_user = '${SILO_DATABASE_USER}'
sr_check_password = ''
sr_check_database = '${SILO_DATABASE_NAME}'
delay_threshold_by_time = 3

health_check_period = 2
health_check_timeout = 2
health_check_user = '${SILO_DATABASE_USER}'
health_check_password = ''
health_check_database = '${SILO_DATABASE_NAME}'
health_check_max_retries = 2
health_check_retry_delay = 1
connect_timeout = 3000

# Cloudflare is the only authority allowed to promote PostgreSQL. Pgpool may
# detach an unreachable backend and rediscover roles, but never runs promotion.
failover_command = ''
follow_primary_command = ''
failover_on_backend_error = off
failover_on_backend_shutdown = off
search_primary_node_timeout = 10
auto_failback = on
auto_failback_interval = 60
detach_false_primary = off

enable_pool_hba = on
pool_passwd = '/config/pool_passwd'
allow_clear_text_frontend_auth = off
authentication_timeout = 10

ssl = ${PGPOOL_SSL:-on}
ssl_key = '/tls/server.key'
ssl_cert = '/tls/server.crt'
ssl_ca_cert = '/tls/ca.crt'

pcp_listen_addresses = '127.0.0.1'
pcp_port = 9898
pcp_socket_dir = '/tmp'

log_destination = 'stderr'
logging_collector = off
log_connections = on
log_disconnections = on
log_per_node_statement = off
log_client_messages = off
log_standby_delay = 'if_over_threshold'
pid_file_name = '/tmp/pgpool.pid'
logdir = '/tmp'
EOF

cat > /config/pool_hba.conf <<'EOF'
host all all 0.0.0.0/0 scram-sha-256
host all all ::/0 scram-sha-256
EOF

key_file=/config/.pgpoolkey
password_input=/tmp/pgpool-passwords
printf '%s\n' "${PGPOOL_ADMIN_PASSWORD}" > "$key_file"
printf '%s:%s\n' "${SILO_DATABASE_USER}" "${SILO_DATABASE_PASSWORD}" > "$password_input"
PGPOOLKEYFILE="$key_file" pg_enc -m -f /config/pgpool.conf -i "$password_input"
rm -f "$password_input"

admin_hash="$(pg_md5 "${PGPOOL_ADMIN_PASSWORD}")"
printf 'admin:%s\n' "$admin_hash" > /config/pcp.conf

chmod 600 /config/pgpool.conf /config/pool_hba.conf /config/pool_passwd \
  /config/pcp.conf "$key_file"
chown postgres:postgres /config/pgpool.conf /config/pool_hba.conf \
  /config/pool_passwd /config/pcp.conf "$key_file"
