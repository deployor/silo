# Production multi-region setup

This checklist provisions the production shape Silo expects:

- one global Bun control plane, normally deployed with the EU stack;
- one global Aiven PostgreSQL service and no regional metadata database;
- permanent Rust dataplanes in `eu-central` and `us-east`;
- an independent Dragonfly and disk cache in each region;
- one logical object-storage region per product region, with one or more real
  S3-compatible physical buckets behind it;
- an independent Cloudflare Worker + D1 status controller; and
- Infisical/Dokploy hooks that temporarily grant a surviving dataplane access
  to the failed logical region.

`onsilo.dev` and `eu.onsilo.dev` are EU endpoints. `us.onsilo.dev` is the US
endpoint. Bucket `resolved_region` is immutable, and a missing/automatic region
resolves to `eu-central`.

Keep `AUTO_ACTIVATE_FAILOVER=false`, `AUTO_PROMOTE_STORAGE=false`,
`AUTO_REDIRECT_DASHBOARD=false`, and `FAILOVER_DRILL_APPROVED=false` until the
final section is complete.

## 1. Reserve identities and failure domains

Before creating infrastructure, freeze these stable identities in the change
record:

- logical region IDs: `eu-central`, `us-east`;
- dataplane instance IDs such as `eu-central-a`, `us-east-a`;
- fixed origins: `eu-origin.onsilo.dev`, `us-origin.onsilo.dev`, and
  `control-origin.onsilo.dev`;
- public endpoints owned by each logical region;
- physical backend IDs such as `primary`, `replica-1`, `replica-2`; and
- the immutable physical bucket name attached to each region/backend pair.

Backend IDs are database identities, not display names. Replacing a provider or
bucket requires a new backend ID; do not silently point an existing ID at a new
bucket. Keep EU and US compute, network, power, provider accounts, and cache
volumes in separate failure domains. Prefer physical replicas in a different
provider and account from the active backend.

## 2. Provision physical S3-compatible buckets

Create at least the initial Backblaze B2 bucket for each logical region:

```text
eu-central / primary -> dedicated EU physical bucket
us-east   / primary -> dedicated US physical bucket
```

For provider failover, create one or more additional physical buckets per
logical region. A replica is a complete copy of that logical region's object
namespace; it is not another Silo user bucket and must never be shared between
EU and US. Providers may differ as long as their S3 compatibility passes the
multipart, conditional request, range request, metadata, copy, and delete
drills.

For every physical backend:

1. Enable encryption, audit logs, billing/usage alerts, and the retention or
   versioning policy approved for Silo. Confirm lifecycle rules do not delete
   live objects or canaries.
2. Create a dataplane application key scoped only to that physical bucket and
   required object operations. Create a separate status-canary key restricted
   to its health prefix.
3. Record endpoint host, HTTPS scheme, signing region, path-style requirement,
   bucket name, provider, account, and secret version in the password manager.
4. Test HEAD bucket and PUT/GET/range/DELETE/multipart operations from the home
   regional host before adding the backend to Silo.
5. Configure provider egress allowlists so both the home dataplane and an
   explicitly activated peer can reach it during a regional incident.

Provider-native replication may be a defense-in-depth copy, but it does not
satisfy Silo's promotion gate by itself. Only Silo's Aiven-backed replication
checkpoint, delivery state, freshness timestamps, and direct canary authorize
promotion.

## 3. Provision Aiven PostgreSQL

Create one TLS-only, highly available Aiven PostgreSQL service with PITR,
tested backups, connection and storage alerts, and enough connections for the
control plane plus every dataplane during failover. Allow both regional hosts
and the control plane. There must be no per-region database and no SQLite/local
Postgres fallback.

Before migration, verify globally unique S3 bucket names:

```sql
SELECT name, count(*)
FROM buckets
GROUP BY name
HAVING count(*) > 1;
```

Resolve any result before continuing. During a published maintenance window,
back up the old database, apply every root migration in lexical order, and
stop on the first error:

```sh
pg_dump --format=custom "$OLD_DATABASE_URL" > silo-before-multiregion.dump
for migration in drizzle/*.sql; do
  psql "$AIVEN_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration" || exit 1
done
```

`0005_multi_region_control_plane.sql` backfills legacy buckets to EU, makes
resolved region immutable, seeds each region's `primary` backend and backend
generation, creates writer/provider/replication state, and preserves deletion
tombstones independently of live bucket rows. Verify at minimum:

```sql
SELECT requested_region, resolved_region, count(*)
FROM buckets
GROUP BY requested_region, resolved_region;

SELECT region_id, active_backend_id, backend_generation,
       required_replication_checkpoint
FROM storage_region_state
ORDER BY region_id;

SELECT region_id, backend_id, provider, status, promotion_authorized
FROM storage_region_backends
ORDER BY region_id, backend_id;

SELECT name, holder_id, generation, lease_expires_at
FROM dataplane_writer_lease
ORDER BY name;
```

Both Bun and both Rust processes receive the identical Aiven TLS
`DATABASE_URL`. Rotate it through Infisical. Test restore into a separate Aiven
service before enabling unattended failover.

## 4. DNS, TLS, and fixed origins

Create DNS-only records with 60-second TTL:

```text
onsilo.dev             -> eu-origin.onsilo.dev
eu.onsilo.dev          -> eu-origin.onsilo.dev
us.onsilo.dev          -> us-origin.onsilo.dev
dash.onsilo.dev        -> control-origin.onsilo.dev
eu-origin.onsilo.dev   -> permanent EU ingress
us-origin.onsilo.dev   -> permanent US ingress
control-origin.onsilo.dev -> the global Bun control plane
```

Fixed origins never move. The status controller changes only the public
endpoint record(s) owned by the failed logical region. Provision certificates
for every endpoint on both regional ingress stacks before an incident; DNS-01
issuance is preferred so the standby can hold valid certificates before DNS
moves. Configure the proxy for streaming request and response bodies, S3-sized
timeouts, disabled response buffering, and no caching of S3 or protected
internal routes.

The public dashboard and fixed control origin must be independently routable.
The status controller checks the fixed origin because `dash.onsilo.dev` may be
redirected during an outage.

Create a narrowly scoped Cloudflare API token that can edit only these Silo DNS
records. Store record IDs for all three S3 endpoint hosts and the dashboard.

## 5. Prepare hosts, Dokploy, and regional caches

Provision one always-on host in each region. Install a supported Docker Engine
and Compose plugin, enable automatic security updates and time synchronization,
restrict SSH, and attach persistent fast storage for the dataplane cache. Do
not expose Dragonfly or OTLP receivers publicly.

Each host runs this same `docker-compose.prod.yml`:

- EU: `COMPOSE_PROFILES=control-plane` runs Bun, EU Rust, EU Dragonfly, and EU
  OpenTelemetry Collector.
- US: an empty `COMPOSE_PROFILES` runs US Rust, US Dragonfly, and US collector.

Dragonfly passwords, volumes, and disk-cache volumes are region-specific.
Caches are disposable accelerators and are never replicated or treated as
authoritative. The cache namespace contains serving region, logical region,
active backend, backend generation, and writer generation so writer transfer,
failover, or promotion cannot serve a stale object from another topology.

Copy the host examples outside Git and fill reviewed image digests:

```sh
cp deploy/eu-central.env.example /secure/silo-eu-host.env
cp deploy/us-east.env.example /secure/silo-us-host.env

docker compose --env-file /secure/silo-eu-host.env -f docker-compose.prod.yml config
docker compose --env-file /secure/silo-us-host.env -f docker-compose.prod.yml config
```

Use Dokploy to deploy the EU and US projects independently. A rollout in one
region must not restart the other. Pin production images by digest or reviewed
immutable version, retain the previous digest for rollback, set resource
limits, and alert on restart loops, disk pressure, cache eviction, connection
pool exhaustion, and `/ready` degradation.

## 6. Render secret files from Infisical

Use separate Infisical paths and service identities for global control-plane,
EU dataplane, US dataplane, and failover-only provider credentials. Dokploy may
fetch/render and restart services; it must not become the source of truth for
secrets. Render files mode `0600`, never place provider credentials in Compose
interpolation, and prevent rendered values from entering deployment logs.

The Bun file contains global auth/integration secrets, Aiven, its local
Dragonfly URL, `DATAPLANE_INTERNAL_SECRET`, and logical per-region dataplane
URLs. These intentionally use public regional endpoints so protected control
calls follow DNS to the current writer after failover; the status Worker alone
uses fixed origins for health and transitions:

```text
NODE_ENV=production
S3_DOMAIN=onsilo.dev
DASHBOARD_DOMAIN=dash.onsilo.dev
DASHBOARD_ORIGIN_DOMAINS=control-origin.onsilo.dev
DATABASE_URL=<Aiven TLS URL>
REDIS_URL=<EU Dragonfly URL>
DATAPLANE_INTERNAL_SECRET=<32+ random characters>
DATAPLANE_REGION_URLS_JSON={"eu-central":"https://onsilo.dev","us-east":"https://us.onsilo.dev"}
HC_AUTH_CLIENT_ID=...
HC_AUTH_CLIENT_SECRET=...
HC_AUTH_REDIRECT_URI=https://dash.onsilo.dev/auth/callback
OFFBOARDING_EXPORT_DERIVATION_SECRET=<same independent 24+ character secret used by every dataplane>
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
```

Do not give Bun provider access keys. All dashboard/offboarding/deep-freeze
storage operations travel through the protected regional Rust endpoint and are
therefore subject to the same writer and backend fences as public S3.

Each normal Rust file contains only its local logical region and all physical
backends that replicate that region. Example EU registry:

```text
DATABASE_URL=<same Aiven TLS URL>
DATAPLANE_INTERNAL_SECRET=<same internal secret>
S3_DOMAIN=onsilo.dev
DASHBOARD_DOMAIN=dash.onsilo.dev
DATAPLANE_STORAGE_REGIONS={"eu-central":{"defaultBackend":"primary","backends":{"primary":{"endpoint":"<host>","endpointScheme":"https","bucket":"<eu-primary-bucket>","accessKeyId":"...","secretAccessKey":"...","signingRegion":"auto","forcePathStyle":false},"replica-1":{"endpoint":"<host>","endpointScheme":"https","bucket":"<eu-replica-bucket>","accessKeyId":"...","secretAccessKey":"...","signingRegion":"auto","forcePathStyle":true}}}}
DATAPLANE_FAILOVER_REGIONS=
DATAPLANE_REGION_PEERS=
OFFBOARDING_EXPORT_DERIVATION_SECRET=<independent 24+ character secret>
DATAPLANE_ACCOUNTING_SPOOL_DIR=/var/cache/silo-dataplane/accounting
DATAPLANE_ACCOUNTING_UNSAFE_MARKER=/var/cache/silo-dataplane/accounting/UNSAFE
```

Accounting commits to Aiven or to the fsync-backed persistent disk spool;
Dragonfly is never a durable accounting queue. If both Aiven and the spool are
unavailable, the dataplane enters unsafe state and teardown remains blocked
until the event is reconciled.

`OFFBOARDING_EXPORT_DERIVATION_SECRET` is a shared credential-derivation key,
not a regional or provider secret. Production startup fails closed unless Bun
has it, and every dataplane must receive the exact same value. To migrate from
the legacy `HC_AUTH_CLIENT_SECRET` fallback without breaking existing export
credentials, first set the new variable to the current HC secret everywhere.
To rotate to an independent value, revoke or let all active export sessions
expire (their maximum lifetime is seven days), invalidate their auth caches,
then deploy the new value atomically to Bun and every dataplane. A mixed-secret
rollout deliberately rejects `ox_` credentials; never rotate one region at a
time.

The US file has the same shape keyed by `us-east`. `DATAPLANE_REGION`, ingress
domains, writer instance ID, Dragonfly URL, disk path, and OTLP destination are
set by the regional Compose deployment. See `.env.production.example` for all
tuning variables.

Normal bundles must not contain remote-region credentials. The activation hook
temporarily renders a combined registry on the surviving dataplane, adds the
failed region ID to `DATAPLANE_FAILOVER_REGIONS`, restarts it, and waits for
protected readiness. Deactivation removes both the region authorization and
credentials after DNS grace.

## 7. Deploy and validate regional dataplanes

Deploy EU first, then US. On each fixed origin:

1. `/health` returns success without disclosing protected state.
2. `/ready` with `x-dataplane-secret` reports Aiven schema healthy, the correct
   local `region`, local Dragonfly status, all configured physical backend
   probes, active backend ID/generation, and the local writer generation.
3. `failoverRegions` is empty during normal operation.
4. A signed logical canary succeeds through the home fixed origin.
5. A signed canary for the other region is rejected or routed to its peer; it
   must never be accepted as a local mutation without authorization.
6. Restarting Dragonfly or clearing the disk cache changes latency only, not
   correctness, quotas, bucket metadata, writer generation, or provider state.

Keep `DATAPLANE_WRITER_AUTO_CLAIM=true`. Startup claims only the local logical
region. Remote writer ownership is claimed explicitly by the status controller
after temporary authorization and drain/flush ordering.

## 8. Register additional physical backends

The migration already registers `primary` as active for EU and US. Its runtime
bucket binding must match the configured physical bucket. For each additional
backend, use this order:

1. Add the backend and credentials to the home dataplane's
   `DATAPLANE_STORAGE_REGIONS`, plus the sealed failover template for the peer.
2. Restart the home dataplane and verify `/ready.storageBackends` contains the
   exact region/backend ID.
3. Add the same public backend ID/provider/canary reference to the status
   `REGION_REGISTRY`, add its direct canary secret, and redeploy the Worker.
4. As a logged-in Silo admin, register it with
   `POST /api/admin/storage/backends`:

   ```json
   {
     "regionId": "eu-central",
     "backendId": "replica-1",
     "provider": "provider-name",
     "bucketName": "immutable-physical-bucket",
     "role": "replica"
   }
   ```

5. Wait for Silo replication to copy the namespace, drain every delivery up to
   `requiredReplicationCheckpoint`, and publish fresh caught-up and verification
   times in `/ready.replication`.
6. Run the provider drills. Only then explicitly authorize the standby with
   `POST /api/admin/storage/backends/{region}/{backend}/authorize`.

Registration fails unless the dataplane already proves the backend exists.
Authorization fails if the backend is not a standby, any prepared mutation
needs reconciliation, an outstanding delivery exists, or checkpoint/freshness
evidence is unsafe. Authorization is one-shot and is consumed by promotion.
Never update the provider state tables manually.

## 9. Configure the independent status plane

Publish the static status site at `status.onsilo.dev`. Create D1, apply every
`status-controller/migrations/*.sql` migration, configure the registry,
canaries, DNS record IDs, and secrets, then deploy the Worker at
`status-api.onsilo.dev`. Follow `status-controller/README.md` for exact JSON and
the signed hook protocol.

The controller must have:

- a distinct logical Silo canary bucket/key in every region;
- a direct least-privilege canary for every physical backend;
- protected reachability to both fixed dataplane origins;
- the same `DATAPLANE_INTERNAL_SECRET` as Bun/Rust;
- a DNS token scoped only to the expected records; and
- separate incident-desk, operator, and hook secrets.

Verify D1 state, component history, incidents, alert delivery, status-only
maintenance, and production-maintenance mirroring before enabling mutations.

## 10. Implement the activation/deactivation hooks

The two directions are independent and must both exist:

```text
eu-central logical storage -> us-east dataplane
us-east logical storage    -> eu-central dataplane
```

The hook must validate the HMAC and freshness before touching Infisical or
Dokploy. Activation fetches the failed logical region's complete physical
backend registry, creates a new immutable secret version for the target,
renders it, adds `DATAPLANE_FAILOVER_REGIONS=<failed-region>`, rolls the target,
and waits for signed `/ready`. If any step fails, keep DNS and writer ownership
unchanged and roll back the partial credential grant.

Deactivation is called only after failback and DNS grace. Verify the target is
not the writer, remove the failed region from both authorization and storage
registry, rotate/revoke the temporary provider grants, roll the target, and
wait until protected readiness no longer lists the region. Make both actions
idempotent and auditable by request ID.

## 11. Observability and alerting

Send regional structured container logs, host metrics, and application OTLP to
SigNoz with `silo.region` and `SILO_INSTANCE_ID` attributes. The collector is
intentionally not given the Docker socket, so Docker API container-resource
metrics are absent; use application OTLP plus host metrics for service and
capacity alerting. Bun defaults to `parentbased_traceidratio` at `0.05` for new
root traces and a 10-second metric export interval; tune
`OTEL_TRACES_SAMPLER_ARG` and `OTEL_METRIC_EXPORT_INTERVAL` only with ingestion
volume and latency evidence. Alert on:

- Aiven reachability, lease renewal, or advisory-lock latency;
- readiness failures and writer/backend generation changes;
- replication prepared age, delivery retry age, checkpoint lag, and freshness;
- provider canary failure by backend;
- accounting disk-spool depth or persistent unsafe marker;
- auth-cache invalidation failure;
- Dragonfly/disk pressure and cache eviction;
- regional p95/p99 latency, HTTP 5xx, S3 error code, and throughput; and
- status hook, DNS API, D1 lease, or alert-webhook failures.

Provider keys, authorization headers, raw S3 paths, user object names, and
rendered secret JSON must be redacted at collection and destination.

## 12. Drill and enable automation

Run every scenario in `FAILOVER_DRILLS.md` against real Aiven, regional hosts,
DNS, Infisical/Dokploy hooks, and every configured provider. Retain timestamps,
incident IDs, writer and backend generations, DNS answers, image digests,
replication checkpoints, canary results, alerts, and accounting totals.

After an independent review:

1. Set `FAILOVER_DRILL_APPROVED=true` while all automatic flags remain false.
2. Enable `AUTO_REDIRECT_DASHBOARD` and observe it in a planned exercise.
3. Enable `AUTO_ACTIVATE_FAILOVER` and observe both regional directions.
4. Enable `AUTO_PROMOTE_STORAGE` only after every backend pair has completed
   promotion, reverse replication, and failback drills.

Use separate reviewed changes. Leave manual controls available, keep rollback
digests and database backups current, and repeat the full drill set after any
change to regions, providers, fencing, replication, DNS, secrets automation, or
status logic.
