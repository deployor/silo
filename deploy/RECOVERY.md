# Multi-region incident and recovery runbook

This runbook covers regional dataplane loss, physical provider loss, Aiven or
control-plane loss, and safe failback. It assumes the production topology in
`SETUP.md` is complete and the status controller is independent of both Silo
regions.

The central rule is simple: DNS is not a writer lock. Aiven writer generation
and backend generation are the only authorities. Never move DNS first, never
promote a backend from provider console state alone, and never bypass an
accounting or replication safety gate to make the status page green.

## 1. Declare and classify the incident

Open the status incident and preserve the first-failure timestamp. Check the
protected operations view before changing anything:

```sh
curl --fail --silent --show-error \
  -H "Authorization: Bearer $STATUS_ADMIN_SECRET" \
  https://status-api.onsilo.dev/api/admin/operations
```

Classify the failing layer:

- **Control plane:** `control-origin`/dashboard fails while dataplanes,
  providers, and Aiven are healthy.
- **Aiven:** both dataplanes report PostgreSQL/schema or writer-lease failure.
- **Regional dataplane:** one fixed regional origin fails while its active
  physical backend passes direct canaries.
- **Physical provider:** the home dataplane remains reachable but one direct
  provider canary fails; the logical region may also fail.
- **Replication:** active storage works, but a standby checkpoint is behind,
  stale, has prepared events, or has failed deliveries.
- **Cache/telemetry:** Dragonfly, disk cache, or SigNoz fails without an
  authoritative dependency failure.

Do not turn a provider incident into a regional DNS move: both dataplanes would
still reach the same failed physical backend. Do not turn an Aiven incident
into either kind of failover: both safety mechanisms depend on Aiven.

For planned work, create a status-only maintenance window first, then enable
the Silo Admin Settings S3/full-maintenance switch only when traffic must be
restricted. Keep the window narrow; an active planned window suppresses new
automatic transitions.

## 2. Regional dataplane failure

### Automatic sequence

After five consecutive failed one-minute rounds, the controller:

1. selects a healthy peer that already proves authorization or has a configured
   activation hook;
2. calls the HMAC-signed hook and waits up to 55 seconds for the peer to report
   the failed logical region in protected readiness;
3. drains the home region and flushes its accounting disk spool if it is reachable;
4. clears drain on the peer and claims a new region-specific writer generation
   under the Aiven advisory lock;
5. re-reads protected readiness and verifies the exact generation;
6. performs signed HEAD/PUT/GET/DELETE against the logical region through the
   target fixed origin; and
7. changes only that logical region's public endpoint records to the peer.

If the old host is unreachable, its lease must expire before the peer can
claim. Stale DNS clients can read only where dependencies permit; mutations on
the non-holder fail closed. A long mutation that already holds a shared fence
finishes before the exclusive generation transfer completes.

### Manual activation

Automatic flags may remain disabled while an operator invokes the same guarded
path:

```sh
curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $STATUS_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  --data '{"region":"eu-central"}' \
  https://status-api.onsilo.dev/api/admin/activate-failover
```

Use `us-east` to move the US logical region to EU. A manual request cannot skip
hook authorization, readiness, drain, accounting flush when reachable, writer
claim, signed canary, or DNS order. A 409 or 5xx is a blocked transition, not an
instruction to edit DNS by hand.

After activation, verify:

- the incident names the logical region and peer;
- Aiven shows exactly one unexpired writer holder for that region and an
  incremented generation;
- the failed region's endpoint record(s) point to the peer fixed origin;
- the other logical region's DNS and active backend are unchanged;
- a signed client receives the new writer generation and correct object data;
- status shows failover active rather than silently resolved; and
- Infisical/Dokploy audit identifies the temporary credential version.

If both dataplanes are unavailable, leave DNS unchanged or use the explicit
503 Worker fallback. There is no safe regional target.

## 3. Regional recovery and failback

The recovered home dataplane must pass its fixed-origin health/readiness,
read-only logical canary, active-provider canary, and Aiven checks for ten
rounds and at least ten continuous minutes. Hold automatic recovery while
repair or verification continues:

```sh
curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $STATUS_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  --data '{"region":"eu-central"}' \
  https://status-api.onsilo.dev/api/admin/hold-auto-recovery
```

Resume with `/api/admin/resume-auto-recovery`, or request the guarded failback
with `/api/admin/force-failback`. Failback order is:

1. drain the peer's mutations;
2. flush peer and home accounting disk spools;
3. clear the home drain and claim a new home writer generation;
4. verify generation and pass the home signed write canary;
5. return the logical region's DNS to its fixed home origin;
6. retain remote credentials for a ten-minute stale-DNS grace; and
7. call the signed deactivation hook, remove remote credentials and
   authorization, restart the peer, and confirm `failoverRegions` no longer
   lists the recovered region.

Do not close the incident while phase is `credential_cleanup`. If home relapses
during DNS grace, the controller can transfer the generation back to the still
authorized peer without reacquiring secrets. After cleanup, verify the remote
provider grants are revoked—not merely removed from the environment file.

## 4. Active physical-provider failure

Provider promotion is independent for each logical region. The controller
starts investigating after the first direct canary failure and considers a
target after five failed rounds. A target is eligible only when all of these
are true:

- it is configured in the serving dataplane and registered as `standby` in
  Aiven;
- direct HEAD/PUT/GET/DELETE canaries pass;
- its replication checkpoint covers
  `storage_region_state.required_replication_checkpoint`;
- caught-up and last-verified timestamps are within the configured freshness
  window;
- no prepared mutation requires reconciliation;
- no delivery through the required checkpoint remains outstanding; and
- an operator explicitly authorized this target.

Authorization is one-shot. In the Silo admin session:

```text
POST /api/admin/storage/backends/{region}/{backend}/authorize
```

Then use the status controller so the direct and logical canaries remain part
of the transition:

```sh
curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $STATUS_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  --data '{"region":"eu-central","backendId":"replica-1"}' \
  https://status-api.onsilo.dev/api/admin/promote-backend
```

Under the same regional advisory lock, Rust verifies it still owns the writer,
checks expected backend generation, validates the physical bucket binding,
rechecks checkpoint/freshness and the target with a signed HEAD, marks the old
active backend standby, marks the target active, consumes authorization,
increments backend generation, and records the promotion reason/audit row. The
controller then runs a logical S3 canary. Public DNS and bucket region do not
change.

If no target passes every gate, accept the storage outage and restore or
reconcile the source. Never advance a checkpoint, mark a delivery complete, or
set `promotion_authorized` directly in SQL.

### Reverse replication and provider failback

After promotion, all new mutations originate on the new active backend. The
recovered old backend is now a standby and must be rebuilt or reverse-replicated
from the new active source. Keep it `unavailable` until a full inventory plus
incremental stream is complete. Wait for a fresh checkpoint through the
current required sequence and direct canaries, change it to `standby`, run the
provider drills, explicitly authorize it, and promote it through the same path
if returning to the preferred provider is desired.

Never copy the stale old provider over the new active provider. Preserve the
promotion audit, generation, event/delivery history, and reconciliation report
with the incident.

## 5. Replication lag or uncertainty

Healthy active storage with unhealthy replication is degraded, not an
immediate public outage. Stop provider promotion authorization and inspect:

```sql
SELECT region_id, sequence, source_backend_id, object_key, operation, state,
       created_at, finalized_at, failure_reason
FROM storage_replication_events
WHERE state = 'prepared'
   OR finalized_at IS NULL
ORDER BY sequence;

SELECT region_id, target_backend_id, sequence, status, attempts, last_error,
       next_attempt_at, locked_at, completed_at
FROM storage_replication_deliveries
WHERE status <> 'complete'
ORDER BY region_id, target_backend_id, sequence;
```

Restore provider/network access and let the idempotent worker retry. Reconcile
stale `prepared` events by comparing the authoritative active object and event
outcome through approved tooling; do not guess based only on an HTTP timeout.
Checkpoints may advance only in contiguous, durably delivered order. Run a
full key/version/size/hash inventory before reauthorizing a repaired replica.

Replication freshness is an availability control. Do not lengthen the
freshness window during an incident merely to make a candidate eligible.

## 6. Aiven PostgreSQL failure

Aiven is the global metadata, quota, accounting, writer, backend, and
replication authority. On loss of Aiven:

1. both dataplanes must report not ready and writer leases must expire;
2. mutations fail closed; do not claim or move a writer;
3. do not move region DNS or promote a provider;
4. verify Aiven service status, network allowlists, TLS certificate, connection
   limits, disk, and recent maintenance;
5. restore the existing service or execute the tested Aiven PITR procedure; and
6. verify migrations, region/backend state, lease generations, pending
   replication, quota reservations, and accounting before clearing maintenance.

Dragonfly and disk cache cannot replace Aiven. If PITR changes the database
timeline, hold all writers and compare provider object state to the restored
event/accounting timeline before reopening mutations. Never run two independent
database restores as regional primaries.

## 7. Global Bun control-plane failure

The Bun control plane is a singleton, not a regional pair. Existing dataplane
caches may soften a short outage, but new authorization, dashboard, admin,
offboarding, and background operations can degrade; do not promise S3
continuity from cache alone.

Restore the pinned Bun image on the EU host. If EU compute is unavailable for
an extended incident, move the **single** control-plane deployment to approved
US compute using the same Aiven database and global secrets, then point
`control-origin.onsilo.dev` and `dash.onsilo.dev` to it. Do not run competing
background-worker instances unless their leader/idempotency behavior has been
explicitly verified. Physical provider credentials still do not belong in Bun.

After recovery, fan out auth/list cache invalidation to both regional
dataplanes, verify dashboard storage calls use the bucket's resolved region,
and restore the singleton to its intended home in a planned change.

## 8. Accounting or teardown safety failure

Before removing a bucket, revoking failover compute, or deleting a regional
volume, protected teardown must prove:

- Aiven accounting flush returned `pending: 0`;
- `unsafeState`/`unsafe_state` is false;
- no durable accounting-unsafe marker exists; and
- the final provider listing/deletion proof and bucket tombstone are durable.

Inspect a regional queue with:

```sh
curl --fail --silent --show-error \
  -X POST \
  -H "x-dataplane-secret: $DATAPLANE_INTERNAL_SECRET" \
  -H 'Content-Type: application/json' \
  --data '{"region":"eu-central"}' \
  https://eu-origin.onsilo.dev/api/internal/accounting/flush
```

Accounting commits directly to Aiven or falls back to the fsync-backed
`DATAPLANE_ACCOUNTING_SPOOL_DIR` on persistent regional disk. Dragonfly is not
part of this durability path. If Aiven and the disk spool were both unavailable,
the dataplane enters unsafe state and attempts to persist
`DATAPLANE_ACCOUNTING_UNSAFE_MARKER`. Keep the host and disk, restore durable
storage, replay/reconcile usage by event ID, and obtain review before clearing
unsafe state through approved tooling. Deleting the marker manually is not
reconciliation.

## 9. Cache, observability, or auth-invalidation failure

Dragonfly and disk cache are independent per region. Restart or clear only the
affected regional cache; never copy cache volumes across regions. Backend
generation and writer generation namespaces make old entries unreachable after
provider promotion or writer transfer, but disk pressure and evictions should
still be investigated.

Credential/key revocation is global metadata and must invalidate both regional
auth caches. If fan-out partially fails, treat the failed region as security
degraded: drain or stop it until invalidation succeeds or the cached entry
expires. Do not restore traffic based only on a healthy `/health` response.

Loss of SigNoz does not justify traffic movement, but it removes evidence. Keep
Cloudflare/D1 incidents, Aiven audit rows, Dokploy changes, and provider audit
logs until telemetry is restored.

## 10. Application rollback

For a bad regional dataplane release, prefer a fenced logical-region failover
to the healthy peer when its authorization path is proven, then redeploy the
previous immutable image digest at home. For a provider-independent bug present
in both regions, enable S3 maintenance and roll both dataplanes back one at a
time, verifying readiness, generation, multipart behavior, and signed canaries
between them.

Do not roll database migrations backward during an incident. Deploy code that
is compatible with the widened schema, restore service, and schedule a reviewed
forward repair. Do not reuse old secret bundles or image tags whose digest has
changed.

## 11. Closeout

An incident is not resolved until:

- each logical region is either home or has an explicitly documented active
  peer;
- exactly one unexpired writer exists per served region;
- every active backend and backend generation matches Aiven and readiness;
- replication direction follows the current active backend, required
  checkpoints are met, and stale authorizations are revoked;
- accounting is empty and safe;
- DNS, TLS, and signed logical/physical canaries pass from independent networks;
- temporary remote credentials are revoked after DNS grace;
- status components and incident notes accurately describe residual
  degradation; and
- follow-up actions include root cause, RPO/RTO, object/accounting
  reconciliation, secret rotation, and a repeat of affected drills.
