# Silo multi-region architecture

## Product contract

Silo exposes logical storage regions, not provider buckets:

| Product choice | Stable region ID | Public endpoint | Normal dataplane |
| --- | --- | --- | --- |
| Automatic / 🇩🇪 Europe | `eu-central` | `onsilo.dev` (also `eu.onsilo.dev`) | EU |
| 🇺🇸 United States | `us-east` | `us.onsilo.dev` | US |

Automatic resolves to EU when the bucket is created. The requested and
resolved values are stored separately; `resolved_region` is immutable for the
life of the bucket. Existing/legacy buckets without a value are EU. A regional
dataplane or physical provider transition never changes a bucket's logical
region, endpoint contract, object prefix, or ownership.

## Authorities and failure domains

| Layer | Scope | Authority | Failover behavior |
| --- | --- | --- | --- |
| Bun control plane | Global singleton | users, keys, buckets, dashboard/admin workflows | Restored or moved as one singleton |
| Aiven PostgreSQL | Global singleton/HA service | all metadata, quotas, accounting, writer/backend generations, replication and audit | Provider-managed HA/PITR; never split by region |
| Rust dataplane | One per region | S3 streaming and enforcement of Aiven state | Either permanent dataplane can temporarily serve any explicitly authorized region |
| Dragonfly | One per dataplane | disposable authorization, list, and object-cache acceleration | Never replicated, authoritative, or an accounting durability layer |
| Disk cache | One per dataplane | disposable large-object acceleration | Never shared across regions |
| Logical storage region | One per product region | stable object-placement identity | DNS/writer may move; identity does not |
| Physical backend | One real S3-compatible bucket | current object bytes for a logical region | Active plus zero or more asynchronous standbys |
| Status Worker + D1 | Global and independent | observations, incident history, serialized transition orchestration | Remains outside both production regions |

There is one writer lease and generation per logical storage region, and one
active physical backend and backend generation per logical region. These are
separate axes:

```text
                 logical eu-central
                         |
              Aiven writer generation
                /                  \
        EU Rust (home)       US Rust (failover)
                         |
              Aiven backend generation
          /              |               \
   B2 EU primary   provider replica 1   provider replica N
```

A regional failover changes the Rust process holding the logical writer. A
provider promotion changes the physical bucket used by that writer. Either can
happen without the other, and simultaneous transitions remain serialized by
the same region-scoped advisory lock domain.

## Normal request path

1. DNS sends `onsilo.dev`/`eu.onsilo.dev` to EU and `us.onsilo.dev` to US.
2. Rust derives the logical region from the authoritative bucket metadata, not
   from an untrusted hostname alone.
3. Authorization and quota state come from the global control plane/Aiven,
   with region-local cache acceleration.
4. A mutation acquires the shared region writer fence and proves the local
   instance owns the unexpired Aiven writer generation.
5. Rust resolves the active physical backend and backend generation from Aiven,
   using a short generation-aware in-process cache.
6. The object body streams directly between client, Rust, and the active
   provider. Bun never proxies ordinary S3 bytes and has no provider keys.
7. Accounting and durable replication state are keyed by stable event IDs.

Dashboard, admin, offboarding, deep-freeze, and bucket teardown call protected
Rust internal storage routes for the bucket's resolved region. They do not
bypass fencing with direct provider credentials.

## Regional failover and split-brain prevention

Normal dataplane bundles contain only local-region provider credentials. A
survivor is authorized through an HMAC-signed Infisical/Dokploy hook that adds
the failed logical region's complete backend registry and
`DATAPLANE_FAILOVER_REGIONS`, then restarts and proves protected readiness.

The external controller transfers a region in this order:

```text
five failed rounds
  -> temporary credential authorization
  -> protected provider/readiness proof
  -> old writer drain + accounting flush when reachable
  -> Aiven exclusive lock and new writer generation
  -> generation confirmation
  -> signed logical write canary
  -> only that region's DNS records move
```

DNS may be stale, but generation cannot be. Mutations hold a shared Aiven
advisory fence for their upstream lifetime; writer transfer takes the exclusive
form. The old process therefore finishes an accepted in-flight mutation before
transfer or returns `NotActiveWriter` after transfer. Multipart state also
binds storage region, physical backend generation, and writer generation.

Recovery reverses the order after ten checks and ten stable minutes. Remote
credentials survive a ten-minute DNS grace, then the signed deactivation hook
revokes them and readiness must stop advertising the remote region.

## Multiple physical buckets and replication

Each logical region can configure any number of real S3-compatible physical
buckets. IDs are stable (`primary`, `replica-1`, and so on); provider, endpoint,
bucket, signing region, and path-style behavior are configuration. The Aiven
row binds an ID to its physical bucket name so an accidental secret/config
change cannot silently redirect an established identity.

The active backend is the only synchronous object authority. Replication is an
ordered, durable state machine:

1. Before an active-provider mutation, insert a `prepared` event containing
   region, source backend, backend generation, stable bucket ID, object key, and
   PUT/delete operation. Its sequence advances the required checkpoint.
2. Execute the provider mutation under writer/backend fencing.
3. Mark the event `committed` only after provider success, or `cancelled` with
   a reason when the provider definitely rejected it. An ambiguous prepared
   event requires reconciliation.
4. Create one delivery per eligible standby. Workers claim deliveries with
   bounded leases, preserve sequence order, stream PUT bytes from the active
   source to the target, apply delete tombstones, and retry idempotently with
   backoff.
5. A standby checkpoint advances only through a contiguous sequence whose
   committed events are complete and whose cancelled events are reconciled.
   Caught-up and direct-verification timestamps must remain fresh.

Copy and completed multipart uploads reduce to committed object PUT state;
deletes remain tombstones until every required standby has observed them.
Physical multipart parts are generation-bound and are not treated as complete
objects before completion.

Automatic promotion favors correctness over availability. It refuses a target
with lag, stale evidence, prepared uncertainty, failed delivery, wrong bucket
binding, unhealthy direct canary, missing explicit authorization, expired
writer lease, or changed expected generation. This means automatic provider
failover does not knowingly discard an acknowledged mutation; if no replica is
provably current, the logical region remains unavailable until repair.

Promotion demotes the old active backend to standby, promotes the target,
increments backend generation, consumes one-shot authorization, and writes an
audit record. New replication then flows from the new active backend back to
every standby—including the recovered old provider. Provider failback is just
another fully gated promotion after reverse replication and inventory proof.

## Global quotas and accounting

User quotas are global across EU and US. Aiven reservations prevent concurrent
uploads in different regions from each spending the same remaining capacity.
Multipart reservations are durable by upload/part and release on completion,
abort, or expiry. Dragonfly may accelerate decisions but cannot independently
grant global storage.

Usage and request accounting is idempotent by event ID. Each event commits
directly to Aiven or, when Aiven is unavailable, is serialized and fsynced to
the regional persistent-disk spool before the request is considered safely
accounted. Dragonfly is never in this durability path. If neither Aiven nor the
disk spool can accept an event, the dataplane enters an unsafe accounting state
and attempts to persist a sticky disk marker. Bucket deletion, regional
credential cleanup, and host/volume teardown require a successful Aiven round
trip, an empty spool, and unsafe false.

## Cache model and performance

Normal data traffic stays local: regional client to regional Rust to the
logical region's active provider. Object bodies are streamed, HTTP connections
are pooled, and Bun stays off the data path. Dragonfly handles hot small-object
and authorization entries; the admission-controlled disk cache handles larger
objects on persistent fast storage.

Cache keys include serving dataplane region, logical storage region, active
backend ID, backend generation, and writer generation. Regional failover starts
from the survivor's independent cache; a writer transfer or provider promotion
makes old-generation entries unreachable without a synchronous cache purge.
Neither cache can change writer ownership, backend state, quota, or accounting.

Production capacity must assume one dataplane serves all logical regions with
cold caches while replication is active. Size CPU, memory, network, file
descriptors, Aiven pools, provider rate limits, and ingress bandwidth for that
case. Monitor per-region and per-backend p50/p95/p99, throughput, error codes,
queue age, replication lag, lock latency, cache admission/eviction, and disk
pressure.

## Registry synchronization

The design is registry-driven, but several authorities intentionally validate
one another:

- `src/lib/regions.ts`: product-visible choices, default, labels, endpoints,
  and TypeScript region type;
- Aiven schema/state: allowed persisted regions, immutable bucket placement,
  active writer/backend generations, physical backend registration;
- `DATAPLANE_INGRESS_DOMAINS`: hostname to logical region;
- `DATAPLANE_STORAGE_REGIONS`: physical provider configuration and credentials;
- `DATAPLANE_FAILOVER_REGIONS`: temporary remote-serving authorization;
- `DATAPLANE_REGION_URLS_JSON`: Bun's logical regional endpoints, which follow
  the current writer through DNS; and
- status `REGION_REGISTRY`: fixed origins, endpoint DNS ownership, backend
  display/canary references.

Deployment order is configuration, runtime readiness, Aiven registration,
status monitoring, replication catch-up, explicit authorization, then drills.
A mismatch fails closed; it must not be repaired by weakening validation.

## Adding a physical provider

For an existing logical region:

1. provision a new physical bucket and least-privilege dataplane/canary keys;
2. choose a never-before-used stable backend ID;
3. add it to the home runtime registry and sealed peer failover template;
4. restart and verify protected physical readiness;
5. add public metadata/canary reference to status and its direct secret;
6. register the backend through the Silo admin API;
7. complete baseline plus incremental replication and inventory verification;
8. run every provider compatibility, uncertainty, promotion, reverse
   replication, and load drill; and
9. explicitly authorize it only while it is current and intended as a
   promotion candidate.

Provider keys remain dataplane-only. The status Worker has separate prefix-
scoped canary keys. Bun stores only provider labels/state.

## Adding a logical region

The Rust and status registries accept stable region IDs, but product types and
database checks are deliberately explicit. Adding a region is a reviewed
product/schema deployment, not merely an environment edit:

1. Add the region to `src/lib/regions.ts` without changing the EU default.
2. Add a forward-only migration that widens every region check, seeds the
   region's `primary` backend/state, and preserves legacy EU backfill. Do not
   edit an already-applied migration.
3. Provision regional compute, an independent Dragonfly, persistent disk
   cache, collector, fixed origin, public endpoint, certificates, and all
   physical provider buckets.
4. Add the fixed URL to the global Bun registry and the host to every ingress
   registry. Deploy Bun and each regional dataplane with compatible config.
5. Decide and provision explicit failover peers. Create activation and
   deactivation hook entries for every allowed directed pair; do not assume a
   full mesh when capacity or data-access policy does not permit one.
6. Add status topology, direct/logical canaries, Cloudflare record IDs,
   components, and alerts.
7. Run schema backfill, endpoint placement, both failover directions for every
   allowed peer, split-brain, provider matrix, accounting, security, and
   survivor-capacity drills.
8. Enable user selection only after the full path is operational. A region
   visible in UI without provider replication, failover authorization, status,
   and drills is not complete.

## Security boundaries

- All public and fixed origins use TLS; provider connections use HTTPS.
- Provider credentials exist only in region-specific Rust secret bundles.
- Remote credentials are short-lived failover grants, not permanent full-mesh
  copies.
- `DATAPLANE_INTERNAL_SECRET` protects readiness and mutation controls; use an
  independent HMAC secret for Infisical/Dokploy hooks.
- Hooks validate exact body signature, timestamp, idempotency key, and allowed
  source/target before deploying anything.
- Cloudflare tokens edit only expected DNS records. Status canary keys operate
  only on dedicated prefixes.
- Auth revocation fans out to every regional Dragonfly. A partial invalidation
  is security degradation, not success.
- Structured logs include request/incident IDs, region, backend and generation,
  status, duration, and cache outcome, while redacting authorization, provider
  keys, secret JSON, and user object names.
- Aiven backups/PITR, provider audit/version policy, D1 incident history,
  Infisical versions, and Dokploy deployment audit are tested and retained
  according to policy.

## Operational truth

The public status page distinguishes global control/Aiven, each regional
dataplane, each logical storage region, every physical backend, and replication
health. `/health` only proves the process is alive. Protected `/ready`, signed
logical and physical canaries, Aiven generations/checkpoints, and accounting
safety determine whether traffic or storage may move.

Use `SETUP.md` to provision, `RECOVERY.md` during incidents, and
`FAILOVER_DRILLS.md` before enabling automation. If those procedures and live
state disagree, stop the transition and preserve the authoritative state; do
not improvise around a fence.
