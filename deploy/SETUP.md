# Production setup checklist

Keep `AUTO_PROVISION_FAILOVER=false`, `AUTO_REDIRECT_DASHBOARD=false`,
`AUTO_ACTIVATE_FAILOVER=false`, and `FAILOVER_DRILL_APPROVED=false` until the
final section is complete.

## 1. Aiven PostgreSQL

1. Create a PostgreSQL service with TLS, backups, and enough connection quota
   for PawHost plus one temporary emergency dataplane.
2. Apply every root `drizzle/*.sql` migration, including
   `0004_failover_fencing.sql`.
3. Migrate the existing production database during a maintenance window and
   verify user, bucket, key, byte, and request totals.
4. Put the same Aiven TLS `DATABASE_URL` in PawHost and the GitHub secret
   `AIVEN_DATABASE_URL`. There must be no separate emergency database.

## 2. PawHost

Deploy the existing production Compose stack with:

```text
DATABASE_URL=<Aiven TLS URL>
DATAPLANE_INTERNAL_SECRET=<random 32+ characters>
DATAPLANE_WRITER_INSTANCE_ID=primary
DATAPLANE_WRITER_AUTO_CLAIM=true
DATAPLANE_ORIGIN_DOMAINS=primary-origin.onsilo.dev
```

Keep Bun, Rust, Dragonfly, and the existing object store as they are. Remove
the old local PostgreSQL service only after the Aiven migration is verified.

## 3. Cloudflare status infrastructure

1. Publish `status/` as a Pages project and attach `status.onsilo.dev`.
2. Create D1 with `wrangler d1 create silo-status`, replace the placeholder
   `database_id` in `status-controller/wrangler.toml`, and apply every
   `status-controller/migrations/*.sql` migration remotely.
3. Deploy the Worker and attach `status-api.onsilo.dev`.
4. Add Worker routes for `onsilo.dev/*` and `dash.onsilo.dev/*`. They are used
   only when the controller changes those records to proxied fallback mode.
5. Create DNS-only, 60-second-TTL A records for `onsilo.dev`,
   `dash.onsilo.dev`, `primary-origin.onsilo.dev`,
   `primary-dashboard-origin.onsilo.dev`, and `emergency-origin.onsilo.dev`.
   The first four initially point to PawHost; the emergency record may start
   at the documentation address `192.0.2.1`.
6. Create a scoped Cloudflare token limited to DNS record editing for the Silo
   zone. Record the zone ID and the A-record IDs for S3, dashboard, and the
   emergency origin.

Configure the Worker values listed in `status-controller/README.md`. Generate
independent random values for the callback, bootstrap, incident, internal,
and admin secrets. Generate `BOOTSTRAP_ENCRYPTION_KEY` with a cryptographically
secure 32-byte value encoded as base64. Set
`STATUS_ADMIN_ORIGINS=https://status.onsilo.dev`. Set
`PRIMARY_MAINTENANCE_URL` to the fixed PawHost dashboard origin followed by
`/api/maintenance-status`—never use `dash.onsilo.dev`, because that hostname
redirects to status during an outage.

Set `DASHBOARD_ORIGIN_DOMAINS=primary-dashboard-origin.onsilo.dev` on PawHost
and route that DNS-only hostname to the Bun control plane. This makes the
dashboard check independent from the public dashboard DNS record.

Use a dedicated least-privilege Silo canary credential and bucket. It must be
allowed to HEAD the bucket and PUT, GET, and DELETE only its health-check
prefix.

## 4. GitHub and container registry

Enable Actions and add these repository secrets:

```text
HETZNER_API_TOKEN
STATUS_CALLBACK_URL=https://status-api.onsilo.dev/api/callback
STATUS_CALLBACK_SECRET
STATUS_BOOTSTRAP_URL=https://status-api.onsilo.dev/api/bootstrap
STATUS_BOOTSTRAP_SECRET
CLOUDFLARE_DNS_API_TOKEN
AIVEN_DATABASE_URL
EMERGENCY_REDIS_PASSWORD
DATAPLANE_INTERNAL_SECRET
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
S3_ENDPOINT
S3_BUCKET_NAME
S3_REGION
PRIMARY_IPV4
```

The Worker also needs a repository token capable of sending
`repository_dispatch` events. Run the build workflow once and make the
`silo-dataplane` and `silo-caddy` GHCR packages readable by a brand-new VM.

## 5. Hetzner

Create a project and API token with server create/read/delete access. Verify
the project can create the configured `cx23` server in `fsn1`, has sufficient
quota, and has no account-level approval or payment block. No permanent VM is
required.

## 6. Alerts and operator access

Configure `ALERT_WEBHOOK_URL` for a channel watched by maintainers and add a
Cloudflare rate limit for `/api/admin/*`. The incident desk is
`https://status.onsilo.dev/admin.html`:

- `STATUS_INCIDENT_PASSWORD` unlocks acknowledgement and public notes.
- `STATUS_ADMIN_SECRET` separately unlocks manual recovery controls.

The same operator panel can create status-only maintenance windows. They
announce maintenance and suppress failover but leave S3 and the dashboard
running. The existing Silo Admin Settings switches are the controls that
actually enable S3-only or full application maintenance. The Worker mirrors
those production switches through `PRIMARY_MAINTENANCE_URL`, so an intentional
shutdown is not mistaken for an outage.

Keep both secrets in a team password manager. Do not reuse either one for the
dataplane, GitHub callbacks, or bootstrap exchange.

## 7. Drills and activation

Run every scenario in `FAILOVER_DRILLS.md` against the real Aiven, Cloudflare,
PawHost, Hetzner, and GHCR setup. Save incident IDs, GitHub run links, writer
generations, DNS answers, image digests, canary results, alerts, and accounting
totals.

After review, set `FAILOVER_DRILL_APPROVED=true`. Enable
`AUTO_PROVISION_FAILOVER`, `AUTO_REDIRECT_DASHBOARD`, and
`AUTO_ACTIVATE_FAILOVER` one at a time in separate changes. Manual
provisioning and activation remain available from the incident desk while
automatic actions are disabled.
