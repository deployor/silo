# Silo status controller

This Worker is deliberately outside Silo production. It runs the one-minute
checks, stores operational state in D1, controls the temporary DNS records,
and dispatches the two GitHub emergency workflows.

Every individual health, readiness, and signed S3 operation has a 12-second
deadline. A dependency that eventually responds after a minute is therefore
counted as failed, not healthy. The first failed round opens an investigation;
only five consecutive failed rounds may start Hetzner provisioning.

Create the D1 database, replace the placeholder `database_id` in
`wrangler.toml`, then apply the migration:

```sh
cd status-controller
for migration in migrations/*.sql; do
  npx wrangler d1 execute silo-status --remote --file "$migration"
done
```

Bind the Worker to `status-api.onsilo.dev/*`. Bind the same Worker to
`onsilo.dev/*` as a fallback route, but leave the normal `onsilo.dev` DNS
record **DNS-only**. That route is reached only if provisioning fails and the
controller temporarily switches the record to proxied fallback mode.

Required Worker secrets/variables:

```text
PRIMARY_HEALTH_URL=https://<pawhost-origin>/health
PRIMARY_READY_URL=https://<pawhost-origin>/ready
PRIMARY_S3_CANARY_URL=https://primary-origin.onsilo.dev
PRIMARY_DASHBOARD_URL=https://<pawhost-dashboard-origin> # never dash.onsilo.dev; that redirects during outages
PRIMARY_MAINTENANCE_URL=https://<pawhost-dashboard-origin>/api/maintenance-status
EMERGENCY_HEALTH_URL=https://emergency-origin.onsilo.dev/health
EMERGENCY_READY_URL=https://emergency-origin.onsilo.dev/ready
EMERGENCY_S3_CANARY_URL=https://emergency-origin.onsilo.dev
DATAPLANE_INTERNAL_SECRET=...
CANARY_ACCESS_KEY_ID=...             # a dedicated, least-privilege Silo key
CANARY_SECRET_ACCESS_KEY=...
CANARY_BUCKET=...
CANARY_REGION=auto
GITHUB_OWNER=deployor
GITHUB_REPO=silo
GITHUB_DISPATCH_TOKEN=...
STATUS_CALLBACK_URL=https://status-api.onsilo.dev/api/callback
STATUS_CALLBACK_SECRET=...
STATUS_ADMIN_SECRET=...
STATUS_INCIDENT_PASSWORD=...          # separate 32+ character password for the incident desk
STATUS_BOOTSTRAP_SECRET=...           # separate GitHub-to-Worker registration secret
BOOTSTRAP_ENCRYPTION_KEY=...          # base64-encoded random 32-byte AES key
STATUS_ADMIN_ORIGINS=https://status.onsilo.dev
CF_DNS_TOKEN=...
CF_ZONE_ID=...
CF_S3_RECORD_ID=...
CF_EMERGENCY_RECORD_ID=...
CF_DASHBOARD_RECORD_ID=...           # dash.onsilo.dev A record
PRIMARY_DASHBOARD_IPV4=...            # PawHost dashboard origin; defaults to PRIMARY_IPV4
PRIMARY_IPV4=...
PRIMARY_IPV6=...                      # omit when the primary has no IPv6
ALERT_WEBHOOK_URL=...                 # optional maintainer webhook
AUTO_PROVISION_FAILOVER=false
AUTO_REDIRECT_DASHBOARD=false
AUTO_ACTIVATE_FAILOVER=false
FAILOVER_DRILL_APPROVED=false
```

`CLOUDFLARE_API_BASE` and `GITHUB_API_BASE` are optional test-only endpoint
overrides. Leave them unset in production so the controller uses the official
Cloudflare and GitHub APIs.

All externally mutating automation is fail-closed. Provisioning, dashboard
redirection, and S3 activation each require their corresponding `AUTO_*`
value plus `FAILOVER_DRILL_APPROVED=true`; a missing value is false. Set them
only after every scenario in
[`deploy/FAILOVER_DRILLS.md`](../deploy/FAILOVER_DRILLS.md) has current
evidence. `AUTO_RECOVER` defaults to true; the recovery lock stops automatic
failback.

During a confirmed outage, the controller changes `dash.onsilo.dev` to a
proxied Worker route that sends browsers to `status.onsilo.dev`; it restores
the DNS-only PawHost dashboard record on failback. Bind the Worker route to
`dash.onsilo.dev/*` as well as the status API and fallback routes.

Admin controls use `POST /api/admin/{provision|activate|force-failback|disable-auto-recovery|abort|destroy}` with `Authorization: Bearer <STATUS_ADMIN_SECRET>`. `GET /api/admin/operations` returns the protected current control state. All of these endpoints enforce `STATUS_ADMIN_ORIGINS`.

The human incident console is published at `https://status.onsilo.dev/admin.html`.
Its separate `STATUS_INCIDENT_PASSWORD` can only acknowledge incidents and
create, edit, or delete public incident notes; it cannot control DNS or VMs.
The password is sent as a Bearer token over HTTPS and retained only in the
browser tab's `sessionStorage`. Use a randomly generated value of at least 32
characters and add a Cloudflare rate-limiting rule for `/api/admin/*`.

The same incident-desk page contains a separately locked operator override
strip. Unlock it with `STATUS_ADMIN_SECRET` to provision Hetzner, activate a
verified emergency server, hold automatic recovery, return traffic to
PawHost, or request teardown. Manual controls cannot skip readiness, writer
fencing, signed canaries, DNS ordering, recovery grace, or accounting safety.

That operator area also schedules **status-only** maintenance windows. These
windows change the public status display and suppress a new automatic
failover, but do not stop S3, the dashboard, or any production process. Use
Silo's existing Admin Settings `S3 maintenance` or `Full maintenance` switch
when production traffic must actually be restricted.

Incident console endpoints:

```text
GET    /api/admin/incidents
POST   /api/admin/incidents/:id/acknowledge
POST   /api/admin/incidents/:id/notes
PATCH  /api/admin/notes/:id
DELETE /api/admin/notes/:id
```

The `maintenance_windows` D1 table is intentionally small and independent.
Create, list, and remove windows from the operator area or its
`/api/admin/maintenance` endpoint; future or active rows are published by
`/api/status`. An active scheduled window suppresses a new automatic failover
and is excluded from availability calculations; create the row before
intentionally taking Silo down. Separately, `PRIMARY_MAINTENANCE_URL` lets the
Worker detect either real production maintenance switch on its next one-minute
monitor run. The detected state is shown publicly and also suppresses failover;
the last verified state is retained for at most three minutes if that endpoint
cannot be reached. The Worker records one S3/dashboard
availability sample per minute and exposes rolling 90-day uptime without
publishing any internal host, IP, VM ID, or dependency state.
