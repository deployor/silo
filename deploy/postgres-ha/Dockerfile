FROM postgres:17.5-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq pgbackrest \
    && rm -rf /var/lib/apt/lists/*

COPY postgres-init-primary.sh /docker-entrypoint-initdb.d/10-silo-primary.sh
COPY postgres-standby-entrypoint.sh /usr/local/bin/silo-standby-entrypoint
COPY postgres-primary-entrypoint.sh /usr/local/bin/silo-primary-entrypoint
COPY pgdog-configure.sh /usr/local/bin/silo-pgdog-configure
COPY tls-configure.sh /usr/local/bin/silo-tls-configure
COPY pgbackrest-configure.sh /usr/local/bin/silo-pgbackrest-configure
RUN chmod 0755 \
    /docker-entrypoint-initdb.d/10-silo-primary.sh \
    /usr/local/bin/silo-standby-entrypoint \
    /usr/local/bin/silo-primary-entrypoint \
    /usr/local/bin/silo-pgdog-configure \
    /usr/local/bin/silo-tls-configure \
    /usr/local/bin/silo-pgbackrest-configure
