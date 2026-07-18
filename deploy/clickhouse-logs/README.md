# Redundant request-log plane

Silo keeps correctness-critical state in PostgreSQL and stores high-volume,
append-only access telemetry in two independent ClickHouse nodes. One copy runs
in `eu-central`; the other runs in `us-east`.

Each regional Vector collector tails structured `silo.request` events from the
local Docker log files and sends every event to both ClickHouse nodes. Both
sinks have independent 10 GiB disk buffers and retry indefinitely. A request
never waits for Vector or ClickHouse. `request_id` is immutable and the
`ReplacingMergeTree` removes retry duplicates.

This intentionally does not use a two-member ClickHouse Keeper cluster. Two
consensus voters cannot safely elect a primary after a network partition.
Append-only, idempotent dual delivery gives Silo the required availability
without a log-database split-brain protocol:

- either node can answer the complete admin log query workload;
- the control plane rotates/fails over between both query endpoints;
- a failed destination is caught up from the collector's durable buffer;
- the Cloudflare status controller checks both nodes and recent-event parity;
- each node writes independent backups to both B2 regions.

## Dokploy layout

Create two Git-backed Compose services from the same file:

| Service | Environment | Server | Domain | Local alias |
|---|---|---|---|---|
| `SILO-Logs-EU` | `eu-central-v2` | Dokploy default (Germany) | `logs-eu.onsilo.dev` | `silo-clickhouse-eu` |
| `SILO-Logs-US` | `us-east` | `SILO US` | `logs-us.onsilo.dev` | `silo-clickhouse-us` |

Use repository `deployor/silo`, the release branch/commit, and Compose path
`./deploy/clickhouse-logs/docker-compose.yml`. Add a Dokploy Compose domain for
service `clickhouse`, internal port `8123`, HTTPS enabled, and Let's Encrypt.
No ClickHouse or Vector host port is published.

EU environment differences:

```text
SILO_REGION=eu-central
SILO_INSTANCE_ID=eu-central-logs-a
CLICKHOUSE_NETWORK_ALIAS=silo-clickhouse-eu
CLICKHOUSE_LOCAL_URL=http://silo-clickhouse-eu:8123
CLICKHOUSE_REMOTE_URL=https://logs-us.onsilo.dev
```

US environment differences:

```text
SILO_REGION=us-east
SILO_INSTANCE_ID=us-east-logs-a
CLICKHOUSE_NETWORK_ALIAS=silo-clickhouse-us
CLICKHOUSE_LOCAL_URL=http://silo-clickhouse-us:8123
CLICKHOUSE_REMOTE_URL=https://logs-eu.onsilo.dev
```

The admin, ingest, and query passwords are shared between the two nodes so
each regional collector can authenticate to either destination. Use distinct
random values for each role. The control plane and status Worker receive only
the read-only query credential.

Backups need dedicated B2 application keys limited to the configured backup
prefixes. Do not reuse object-serving keys after rollout. Each node backs up to
both `CLICKHOUSE_BACKUP_EU_URL` and `CLICKHOUSE_BACKUP_US_URL` every six hours.

## Rollout order

1. Deploy both ClickHouse services without changing the Silo app images.
2. Confirm both HTTPS domains answer `SELECT 1` with the query credential.
3. Deploy the new dataplane/control-plane images so structured access events
   begin flowing. PostgreSQL is still retained as the migration source.
4. Confirm the same live request ID appears on both nodes and test one-node
   query failover.
5. Run `tools/migrate-request-logs-to-clickhouse.ts`. It stops on any failed
   replica and verifies `uniqExact(request_id)` independently on both nodes.
6. Point the control plane at both query URLs and verify admin logs/aggregates.
7. Bind the status Worker health URLs and read-only query secret.
8. Take a PostgreSQL backup. Only then run the confirmation-gated finalize
   tool, which renames the old table for a rollback window instead of deleting
   it.

Never enable cleanup merely because the total row counts match. Also compare
oldest/newest timestamps, sample request IDs from multiple dates, per-method
counts, byte sums, and both ClickHouse replicas.

## Failure behavior

- **One ClickHouse node fails:** local S3 traffic and the surviving log query
  endpoint continue. Both collectors buffer the failed sink independently.
- **One entire Silo region fails:** requests served by the surviving dataplane
  are still delivered locally and buffered for the failed region.
- **A collector restarts:** its checkpoints and sink buffers live in the
  persistent `vector-data` volume.
- **Both ClickHouse nodes fail:** S3 continues. Collectors buffer until their
  bounded disks fill; status reports an outage. Correctness/accounting remains
  in PostgreSQL and its durable dataplane spool.
- **A duplicate is retried:** `ReplacingMergeTree(version)` converges on one
  request ID; admin queries use `FINAL` for exact results.

At the current volume, `FINAL` provides simple exact behavior. Before the table
reaches sustained tens of millions of rows, benchmark projections/materialized
views and replace offset pagination with an event-time/request-ID cursor.
