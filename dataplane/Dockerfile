FROM rust:1.93.1-bookworm AS builder
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /usr/src/app

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim AS release
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/* && \
    install -d -o nobody -g nogroup /var/cache/silo-dataplane

COPY --from=builder /usr/src/app/target/release/silo-dataplane /usr/local/bin/silo-dataplane

USER nobody
EXPOSE 3001/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3001/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/silo-dataplane"]
