# Required multi-region and provider failover drills

Unattended failover is a production capability, not a configuration toggle.
Keep `AUTO_ACTIVATE_FAILOVER=false`, `AUTO_PROMOTE_STORAGE=false`,
`AUTO_REDIRECT_DASHBOARD=false`, and `FAILOVER_DRILL_APPROVED=false` until the
applicable matrix below passes against real infrastructure.

Repeat the suite after any change to region/provider registry, Aiven schema,
writer fencing, replication, accounting, auth invalidation, DNS, certificates,
Infisical/Dokploy hooks, status logic, or S3 request handling.

## Evidence required for every drill

Record in the incident/change ticket:

- UTC start/end time, operators, commit and immutable image digests;
- status incident ID and timeline, D1 component samples, and delivered alerts;
- fixed-origin and public DNS answers with TTL before/during/after;
- writer holder/generation and backend ID/generation before/during/after;
- required and observed replication checkpoints, oldest prepared event,
  outstanding deliveries, caught-up/verified timestamps;
- signed logical and direct physical canary results;
- client request IDs, S3 status/error codes, latency, and byte hashes;
- Aiven quota/accounting totals and disk-spool/unsafe state;
- Infisical secret version, hook request IDs, Dokploy deployment IDs, and proof
  of remote credential revocation; and
- measured RTO, acknowledged-write RPO, error budget impact, and any manual
  intervention.

Use dedicated drill users, logical buckets, provider prefixes, and unique
object keys. Take database/provider backups first. Monitor both fixed origins,
all physical backends, Aiven, Dragonfly, disk, and status from an independent
network. Never use customer objects as test data.

## 1. Placement, endpoints, and immutable region

Create buckets with Automatic, 🇩🇪 Europe, and 🇺🇸 United States. Confirm:

- Automatic and an omitted legacy value resolve exactly once to `eu-central`;
- EU buckets use `onsilo.dev`/`eu.onsilo.dev`, and US buckets use
  `us.onsilo.dev`;
- dashboard/API responses show the resolved region and correct endpoint;
- `resolved_region` cannot be changed by API or direct ordinary update;
- global bucket-name uniqueness holds across regions; and
- list, upload, download, copy, multipart, delete, offboarding, deep-freeze,
  and admin storage operations all reach the bucket's regional dataplane.

Send a US bucket request to the EU fixed origin and vice versa. It may be
securely proxied to the configured peer or return retry guidance, but it must
never execute as the wrong logical region or leak a provider credential.

## 2. EU dataplane loss: EU logical region moves to US

Stop/firewall the EU Rust process while leaving EU physical storage and Aiven
healthy. Confirm:

- the first failed monitor round opens investigation but moves nothing;
- exactly five consecutive failed rounds are required;
- the signed `eu-central:us-east` activation hook materializes EU provider
  credentials only on US and readiness proves `failoverRegions` authorization;
- the old lease expires or drains, accounting is flushed when reachable, and
  US claims a strictly larger EU writer generation;
- a signed EU logical PUT/GET/DELETE passes through `us-origin` before DNS;
- only `onsilo.dev` and `eu.onsilo.dev` move to US; `us.onsilo.dev` does not;
- US simultaneously serves its own and EU logical regions without cache-key,
  quota, accounting, provider, or path-prefix collision; and
- status identifies EU regional failover while both logical storage components
  remain accurate.

## 3. US dataplane loss: US logical region moves to EU

Repeat drill 2 in the opposite direction. The signed
`us-east:eu-central` hook must grant only US provider access, only
`us.onsilo.dev` may move, and EU must continue serving `onsilo.dev` without
writer or cache disruption.

No direction is production-approved merely because the reverse direction
passed.

## 4. Recovery stability, DNS grace, and relapse

For each direction, recover the home dataplane and confirm automatic failback
requires ten successful checks and at least ten continuous healthy minutes.
Verify the controller:

1. drains and flushes the peer;
2. claims a larger home generation;
3. passes the home write canary before returning DNS;
4. retains the remote credential for ten minutes of stale DNS; and
5. invokes deactivation, revokes provider grants, restarts the peer, and waits
   until the failed region disappears from `failoverRegions`.

Break home again during DNS grace. Cleanup must stop and the writer must return
to the still-authorized peer before DNS. Repeat after cleanup; a new signed
activation must be required. Exercise hold/resume automatic recovery and
confirm the hold is per logical region.

## 5. Split-brain and stale DNS fencing

Pin clients to both fixed origins while transferring each region back and
forth. Run concurrent PUT, overwrite, DELETE, multi-delete, copy, create/upload/
complete multipart, and conditional requests against identical keys.

Exactly one writer generation may accept each mutation. The stale dataplane
must return a retryable S3 failure such as HTTP 503 `NotActiveWriter`; it must
not forward a mutation after losing the fence. Reads may work only from the
authoritative active backend. Confirm a long in-flight mutation completes
before the exclusive transfer lock finishes and that no accepted mutation
overlaps generations.

Kill a process after it receives a request but before response delivery. Retry
with the same client intent and reconcile provider state, replication event,
accounting event ID, and returned result. There must be no silent double charge
or divergent replica.

## 6. Multipart across writer and backend generations

Start multipart uploads before a regional writer transfer and before a
physical backend promotion. After each transition, attempt another part,
completion, and abort from old and new paths. Stale generation operations must
return HTTP 409 `InvalidRequest` with restart guidance; no upload may combine
parts from different writer/backend generations.

Also test 1 and 10,000 parts, duplicate part numbers, aborted uploads, expired
quota reservations, and a transition while completion is in flight. Verify
global quota cannot be double-spent by simultaneous EU and US uploads for one
user.

## 7. Aiven outage and lease expiry

Block Aiven from one dataplane, then both. Confirm readiness reports PostgreSQL
failure, lease renewal stops, and mutations fail closed after lease expiry.
The controller must not move DNS, claim another writer, or promote a provider
because the same authority is unavailable everywhere.

Restore Aiven and verify schema, region/backend state, reservations,
replication, and accounting before writes resume. Perform a PITR exercise in an
isolated environment and document how provider objects written after the
restore point are reconciled. No regional database may become an alternative
source of truth.

## 8. Durable accounting and unsafe teardown

During active regional failover, generate requests, ingress, egress, bucket
bytes, overwrites, deletes, and failed operations. Block Aiven accounting so
events enter the regional fsync-backed disk spool; restore Aiven and verify
idempotent flush produces exact totals once. Restart the container while Aiven
is blocked and prove the persistent spool survives and replays exactly once.

Then block both Aiven and writes to the persistent disk spool for an accounting
event. Confirm the dataplane enters unsafe state, attempts to persist the sticky
marker, and blocks bucket teardown, credential cleanup that would destroy
evidence, and host/volume removal. Restore durable storage, reconcile the event,
clear unsafe state through the approved process, and verify teardown proceeds
only after a live Aiven round trip with `pending: 0` and unsafe false. Dragonfly
availability must not affect either accounting scenario.

## 9. Global Bun control-plane loss

Stop only Bun. Verify both dataplane `/health` endpoints remain independent,
then measure which cached and uncached S3 operations remain available without
overstating cache as authority. New dashboard, auth, admin, offboarding, and
background operations should fail safely.

Restore the singleton on EU. Separately rehearse moving the single Bun instance
to approved US compute with the same Aiven/global secrets and returning it
without running duplicate background work. Confirm Bun has no physical provider
credentials in either location.

## 10. Physical provider promotion matrix

For every logical region and every physical backend allowed to become active,
test every intended directed promotion edge. At minimum:

```text
eu-central: primary -> replica-1 -> primary
us-east:   primary -> replica-1 -> primary
```

Invalidate or firewall only the active physical provider while the dataplane
stays healthy. Confirm the status page distinguishes provider outage from
dataplane outage and does not move regional DNS. Five direct canary failures
are required. The candidate must have a direct healthy canary, current
checkpoint/freshness, no unsafe events/deliveries, and explicit one-shot
authorization.

Promotion must:

- occur on the dataplane that owns the writer lease;
- increment only backend generation;
- atomically mark old active standby and target active;
- consume authorization and write an audit row with actor/reason/checkpoints;
- invalidate old backend-generation cache entries;
- pass logical reads/writes without changing bucket region or DNS; and
- leave in-progress multipart uploads fenced to the old generation.

## 11. Reverse replication and provider failback

After every provider promotion, write and delete data on the new active
backend. Recover/rebuild the old provider and prove replication now flows from
the current active backend to the old one. Compare a complete inventory plus
content hashes, not only object counts.

The old provider must remain unavailable/standby and unauthorized until its
checkpoint is current and fresh. Reauthorize and promote it through the same
guarded path. Verify data written during the outage survives the round trip and
that stale provider data never overwrites newer active data.

## 12. Replication uncertainty blocks promotion

Independently inject each condition:

- an old `prepared` event;
- committed PUT delivery failure;
- committed delete/tombstone delivery failure;
- a gap before a later completed sequence;
- checkpoint below required;
- stale caught-up timestamp;
- stale direct verification timestamp;
- wrong physical bucket binding; and
- target marked unavailable or disabled.

The target must remain ineligible and automatic/manual promotion must return a
safe error. Restore the real delivery, reconcile the prepared event, and prove
contiguous checkpoint advancement before authorization. Direct SQL changes to
checkpoint, delivery completion, or authorization are an automatic drill
failure.

## 13. Provider and regional failure overlap

While one logical region is served by its peer, fail that region's active
physical backend. Confirm provider promotion happens on the current writer
dataplane with the same gates and does not disturb the peer's home logical
region. Then recover the regional home and verify failback uses the newly active
physical backend and generation.

Also fail the only caught-up provider while its home dataplane is down. With no
safe physical target, Silo must report the logical storage outage and refuse a
lossy promotion.

## 14. Global auth revocation and cache isolation

Warm authorization caches in both regions, then revoke an S3 key/session from
the control plane. Confirm invalidation fans out to both Dragonflies and the
revoked credential fails immediately at home and during failover. Block one
invalidation request; that region must be treated as security degraded until
invalidation or expiry, never silently healthy.

Warm identical object paths in both regional caches, transfer a writer, and
promote a backend. Inspect cache namespaces and responses to prove region,
backend ID, backend generation, and writer generation prevent collisions.
Delete Dragonfly data and the disk cache; correctness and accounting must remain
unchanged while latency recovers.

## 15. Signed hook security and idempotency

For both activation and deactivation directions, test:

- valid signature and current timestamp;
- wrong/missing signature;
- body changed after signing;
- stale/future timestamp;
- unapproved source/target pair;
- replayed request ID and idempotency key;
- concurrent duplicate delivery;
- Infisical failure, Dokploy failure, restart timeout, and readiness failure;
- partial secret render followed by rollback; and
- log inspection for provider-secret leakage.

Only the valid allowlisted request may change a secret version. Replays must
return the same outcome without duplicate rollout. The status controller must
leave writer and DNS unchanged when activation does not become ready within 55
seconds. Deactivation must refuse while the target still owns the writer.

## 16. DNS, TLS, dashboard, and independent status

From multiple resolvers, verify endpoint records are DNS-only, TTL 60, and move
only after the relevant signed canary. Test valid certificates for every public
hostname on both regional origins before failover. Confirm stale resolvers are
safe because of fencing.

Stop Bun and test optional `AUTO_REDIRECT_DASHBOARD`: `dash.onsilo.dev` should
reach the status route while `status.onsilo.dev` and D1 remain independent.
Restore Bun and verify dashboard DNS returns to `control-origin` only after its
fixed health check passes. Exercise the explicit S3 503 Worker fallback without
letting it accept or cache an S3 mutation.

Create a status-only maintenance window and confirm it publishes/suppresses
automation without stopping S3. Toggle real Silo S3/full maintenance and
confirm the fixed maintenance endpoint is mirrored and stale state expires
after three minutes.

## 17. Bucket deletion, tombstones, and internal storage paths

Delete empty and recently emptied buckets in both regions, including while one
region is served by its peer and while a physical replica is lagging. The
protected teardown must flush accounting, prove the final listing/deletion,
preserve a region-aware tombstone, and retain replication work after the live
bucket row is gone.

Run dashboard file operations, deep-freeze archival/retrieval/deletion, and
offboarding export for both regions. Confirm Bun streams through the protected
regional dataplane and cannot bypass writer/backend fences with provider
credentials.

## 18. Secret rotation

Rotate independently:

- each provider application key;
- each direct provider canary key;
- logical Silo canary keys;
- `DATAPLANE_INTERNAL_SECRET` through a coordinated overlap procedure;
- activation-hook HMAC secret; and
- Aiven credentials.

Verify both regions, Bun, and status converge without exposing secrets in
logs. Revoke old values and prove they fail. Rotate a failover-only credential
while its region is home, then activate the peer and confirm the sealed template
uses the new version.

## 19. Survivor capacity and performance

Load each home region to expected peak, then fail the other region and run the
combined workload with cold Dragonfly/disk caches while provider replication
continues. Measure p50/p95/p99 latency, throughput, CPU, memory, network,
provider throttling, Aiven pools/locks, queue age, and cache admission.

The surviving host, ingress, Aiven plan, and providers must meet the approved
two-region capacity target without loosening safety timeouts or dropping
accounting/replication. Repeat with large streaming PUT/GET, range reads,
multipart, list/delete batches, and many small objects. Record the tested limit
and alert threshold; "it stayed up" is not a performance pass.

## 20. New-region rehearsal

In staging, add a third logical region using the complete expansion checklist
in `MULTI_REGION.md`: product registry and migration constraints, physical
providers, fixed origin/endpoint TLS, regional deployment/cache, control-plane
URL, status registry/canaries/DNS IDs, every directed activation/deactivation
hook, and provider promotion matrix.

Confirm existing EU/US buckets do not move, Automatic still resolves to EU,
the new region can fail over to an explicitly selected peer, and failure of the
new configuration is isolated. A registry entry without secrets, database
state, canaries, hooks, and drills is not a deployed region.

## Enabling automation

After independent review of all evidence, set
`FAILOVER_DRILL_APPROVED=true` first. Enable dashboard redirect, regional
activation, and provider promotion in separate reviewed changes. Keep manual
controls available and define the owner who can immediately disable each flag.

If any drill is incomplete, flaky, relies on an undocumented manual step, or
cannot prove writer/backend uniqueness and object/accounting correctness, leave
the corresponding automation disabled.
