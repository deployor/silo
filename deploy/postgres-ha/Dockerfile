FROM postgres:17.5-bookworm AS pgpool-builder

ARG PGPOOL_VERSION=4.7.2
ARG PGPOOL_SHA256=e72b9d0ff3620f7da7e33a58dda44b77919d056752dc9bd86b2985c4988d1938

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates curl libpq-dev libssl-dev \
    && curl --fail --location --silent --show-error \
      "https://www.pgpool.net/source/pgpool-II-${PGPOOL_VERSION}.tar.gz" \
      -o /tmp/pgpool.tar.gz \
    && echo "${PGPOOL_SHA256}  /tmp/pgpool.tar.gz" | sha256sum --check --strict \
    && mkdir /tmp/pgpool \
    && tar --extract --gzip --file /tmp/pgpool.tar.gz --strip-components=1 --directory /tmp/pgpool \
    && cd /tmp/pgpool \
    && ./configure --prefix=/usr/local/pgpool --with-openssl \
    && make -j"$(nproc)" \
    && make install

FROM postgres:17.5-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq pgbackrest \
    && rm -rf /var/lib/apt/lists/*

COPY --from=pgpool-builder /usr/local/pgpool /usr/local/pgpool
ENV PATH="/usr/local/pgpool/bin:${PATH}"

COPY postgres-init-primary.sh /docker-entrypoint-initdb.d/10-silo-primary.sh
COPY postgres-standby-entrypoint.sh /usr/local/bin/silo-standby-entrypoint
COPY postgres-primary-entrypoint.sh /usr/local/bin/silo-primary-entrypoint
COPY pgpool-configure.sh /usr/local/bin/silo-pgpool-configure
COPY tls-configure.sh /usr/local/bin/silo-tls-configure
COPY pgbackrest-configure.sh /usr/local/bin/silo-pgbackrest-configure
RUN chmod 0755 \
    /docker-entrypoint-initdb.d/10-silo-primary.sh \
    /usr/local/bin/silo-standby-entrypoint \
    /usr/local/bin/silo-primary-entrypoint \
    /usr/local/bin/silo-pgpool-configure \
    /usr/local/bin/silo-tls-configure \
    /usr/local/bin/silo-pgbackrest-configure
