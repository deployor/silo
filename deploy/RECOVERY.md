# Production recovery runbook

## 1. Move the source of truth first

Provision the Aiven PostgreSQL service, apply the existing Drizzle migrations
to it, and migrate during a short S3 maintenance window. Do not point only the
emergency VM at Aiven: PawHost and Hetzner must use the identical Aiven
`DATABASE_URL` before failover is enabled.

There are two deliberately separate maintenance controls:

- A status-only window, created in the status incident desk, publishes the
  notice and suppresses automatic failover without stopping any service.
- Silo Admin Settings' S3/full maintenance switches actually restrict
  production. The external Worker reads `/api/maintenance-status` from the
  fixed PawHost dashboard origin every minute and treats the switch as planned
  maintenance rather than an outage.

For planned work: publish the status-only window first, enable the appropriate
production switch in Silo Admin Settings when work begins, disable that switch
when service is ready, then end/remove the status window. Scheduling the window
early does not stop anything. While the window is active it does pause new
automatic failover, so keep its duration narrow and remove it if the work is
cancelled.

```sh
# Run from a trusted machine. Keep both URLs out of shell history where possible.
pg_dump --format=custom "$OLD_DATABASE_URL" > silo-before-aiven.dump
pg_restore --clean --if-exists --no-owner --dbname="$AIVEN_DATABASE_URL" silo-before-aiven.dump
```

Validate the Aiven database with a read-only count of users, buckets, and
bucket keys; then update Dokploy’s `DATABASE_URL` and restart the existing
compose deployment. The production Compose layout itself stays unchanged:
PawHost runs Bun, Rust, and Dragonfly; Aiven replaces only Postgres.

## 2. Configure independent services

1. Deploy `status/` as Cloudflare Pages at `status.onsilo.dev`.
2. Create the D1 database and deploy `status-controller/` at
   `status-api.onsilo.dev`; follow its README for scoped secrets and routes.
3. Add the GitHub Actions secrets listed in
   [`emergency/README.md`](./emergency/README.md).
4. Set `onsilo.dev` to DNS-only with TTL 60. Keep `dash.onsilo.dev` on
   PawHost. Create `primary-origin.onsilo.dev` and
   `emergency-origin.onsilo.dev` as DNS-only with TTL 60. Monitoring must use
   the fixed primary origin names, never the public names that DNS failover
   changes.

Use a separate least-privilege Silo canary key and bucket. The controller uses
read-only checks while the other site owns the writer lease, then a
PUT/GET/DELETE canary immediately after transferring the lease and before DNS.

## 3. Drill before unattended activation

Leave both `AUTO_ACTIVATE_FAILOVER=false` and
`FAILOVER_DRILL_APPROVED=false`. Complete every scenario and retain the
evidence described in [`FAILOVER_DRILLS.md`](./FAILOVER_DRILLS.md). Enable
both flags only after review; missing flags remain fail-closed.

DNS selects a destination, but Aiven selects the only writer. The controller
uses an exclusive database advisory lock to drain in-flight mutations before
changing the writer generation; stale DNS traffic can read but receives a
retryable `NotActiveWriter` for mutations. While emergency service is active the dashboard is intentionally
unavailable, disk cache stays disabled, and all S3 responses include
`x-silo-failover: active`.

## 4. Recovery timing

- The independent Worker checks once per minute. `dash.onsilo.dev` moves to
  the status page on the first detected dashboard outage, normally within one
  minute.
- Each health, readiness, PUT, GET, and DELETE probe has a 12-second deadline.
  A response arriving after a minute is treated as unavailable even if it
  eventually succeeds.
- Hetzner provisioning starts only after five consecutive complete failures,
  roughly four to five minutes after the outage begins. A single missed check
  never creates a VM.
- The provisioning workflow waits up to 15 minutes for protected readiness.
  Public S3 DNS changes only after the VM is ready, the Aiven writer lease has
  moved, and a signed PUT/GET/DELETE canary succeeds.
- The public record has a 60-second TTL. Most clients should follow the new
  address within about a minute, but stale clients remain safe because only
  the current Aiven lease holder accepts mutations.
- Automatic failback requires ten successful checks and at least ten stable
  minutes, so it normally starts about ten to eleven minutes after primary
  recovery. Emergency mutations are drained before the lease and DNS return
  to PawHost.
- Hetzner remains online for another ten-minute DNS grace period. Only after
  that period, a verified accounting flush, and confirmation that emergency
  is no longer the active writer may the workflow delete the VM.
