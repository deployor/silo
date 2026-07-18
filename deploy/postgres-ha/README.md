# Silo PostgreSQL HA

This stack replaces the managed database with one PostgreSQL cluster spanning
the two Silo failure domains:

- Germany starts as the primary.
- US East is a physical hot standby with a permanent replication slot.
- PgDog runs locally in both regions and is the only application database
  endpoint (`silo-db-eu:6432` or `silo-db-us:6432`).
- Both PgDog nodes monitor both PostgreSQL nodes with `role = "auto"`, one-second
  LSN checks, transaction pooling, prepared statements, health checks, and
  OpenMetrics.
- The Cloudflare status Worker is the failover controller. PgDog never promotes
  PostgreSQL by itself.
- WAL and full/differential backups are encrypted client-side by pgBackRest and
  written to two independent B2 repositories.

## Safety model

Automatic promotion is disabled until a drill succeeds. The Worker requires:

1. five consecutive failures of the active primary;
2. a previously confirmed synchronous standby;
3. exactly one current primary before the failure;
4. the candidate still being in recovery;
5. matching receive and replay LSNs;
6. replay freshness of at most 15 seconds;
7. the expected replicated generation;
8. both `AUTO_FAILOVER_DATABASE=true` and `FAILOVER_DRILL_APPROVED=true`.

Every PostgreSQL restart is fenced read-only by its entrypoint. The Worker only
unfences a node whose replicated generation and active region match the D1
controller state. A stale former primary therefore cannot return writable. If
two primaries are ever observed, the Worker revokes application access and
terminates application sessions on the stale one.

## Connection policy

Applications do not connect to PostgreSQL directly:

```text
EU DATABASE_URL=postgres://silo_app:...@silo-db-eu:6432/silo?sslmode=disable
US DATABASE_URL=postgres://silo_app:...@silo-db-us:6432/silo?sslmode=disable
```

The connection is plaintext only inside Docker's `dokploy-network`. PgDog uses
TLS 1.3 with full certificate verification for every PostgreSQL connection.
Raw PostgreSQL port 15432 must allow only the other regional server and the
Cloudflare Tunnel/VPC path. Do not expose PgDog port 6432 publicly.

Keep the application pools small even though PgDog can accept many clients.
The shipped Silo settings use 2 Bun connections, 3 ordinary Rust connections,
and 2 Rust writer-fence connections per process. PgDog multiplexes these onto a
24-connection backend pool while leaving PostgreSQL maintenance headroom.

## Deployment order

1. Create DNS-only `db-eu.onsilo.dev` and `db-us.onsilo.dev` records.
2. Generate one private CA and a separate server certificate for each node.
   Include `postgres`, the regional DB hostname, and `db-primary.onsilo.dev` as
   SANs. Store keys only in Dokploy environment values.
3. Publish the immutable `silo-postgres` image.
4. Deploy `docker-compose.eu.yml`. Do not point applications at it yet.
5. Restore a fresh Aiven dump into the new EU primary and apply every migration.
6. Deploy `docker-compose.us.yml`; it creates the physical replica with
   `pg_basebackup` and slot `silo_us`.
7. Create two Cloudflare Hyperdrive configurations using the PostgreSQL
   superuser through a Workers VPC/Tunnel, bind them as `DATABASE_EU` and
   `DATABASE_US` to the status Worker, then redeploy the Worker.
8. Run `enableSynchronousReplication()` through the protected admin operation.
   Confirm `silo_us` is `streaming` and `sync`, and receive/replay/current LSNs
   match.
9. Create pgBackRest stanzas in both repositories, take a full backup, restore
   it to a disposable volume, and verify row counts and checksums.
10. Put Silo in maintenance, take the final Aiven dump, restore it, re-seed the
    US standby, then change all three Silo processes to their local PgDog URL.
11. Exercise EU→US promotion, S3 PUT/HEAD/GET/DELETE in both logical regions,
    stale-primary fencing, EU rewind/rejoin, and US→EU failback.
12. Only then enable database automation. Keep Aiven read-only for a rollback
    window before deletion.

## Backups

Run these as Dokploy schedules against the `postgres` service in both database
composes. The standby invocation safely fails while it is not primary; after a
promotion the same schedule becomes active without editing credentials.

```sh
pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=silo stanza-create
pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=silo --type=full backup
pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=silo --type=diff backup
pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=silo check
```

Recommended schedule: differential every 6 hours, full every Sunday, `check`
hourly, and a real disposable restore every week. B2 bucket versioning/object
lock should be enabled where available. Backup keys must be dedicated and
limited to the `/postgres-ha` prefix; do not reuse Silo object-serving keys in
the final setup.

## Request logs

Full request logs are not correctness-critical relational data and should not
share the synchronous OLTP path. Keep these in PostgreSQL:

- users, sessions, bucket/key metadata and quotas;
- mutation intents, accounting events, writer leases and replication state;
- low-volume security/admin audit events.

Move high-volume per-request telemetry to a regional ClickHouse pair (or a
managed log backend) through the existing OpenTelemetry collectors, dual-write
asynchronously, retain a short local window, and archive compressed partitions
to both B2 regions. Never make S3 request success depend on the log backend.
