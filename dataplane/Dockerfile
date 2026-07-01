FROM rust:1-bookworm AS builder
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /usr/src/app

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim AS release
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/src/app/target/release/silo-dataplane /usr/local/bin/silo-dataplane

USER nobody
EXPOSE 3001/tcp
ENTRYPOINT ["/usr/local/bin/silo-dataplane"]
