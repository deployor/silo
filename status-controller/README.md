# Silo regional status controller

This Cloudflare Worker is the independent monitor and transition coordinator
for Silo. It is deliberately outside both production regions and the global
Bun control plane. It stores status history and transition state in D1,
performs signed logical and physical S3 canaries, coordinates fenced regional
writer moves, promotes caught-up physical backends, and updates only the DNS
records assigned to the affected logical region.

The controller never stores user objects and never decides object placement.
Aiven PostgreSQL remains authoritative for bucket region, active backend,
writer generation, accounting, replication checkpoints, and promotion audit.

## Safety model

- The cron runs once per minute. A probe has a 12-second deadline.
- One failed round opens an investigation. Dataplane or active-provider
  automation requires five consecutive failed rounds.
- Regional failover is ordered: authorize credentials, prove protected
  readiness, drain/flush the old writer when reachable, claim a new Aiven
  generation, prove that generation, pass a signed write canary, then move DNS.
- Provider promotion requires a direct healthy target canary plus a caught-up,
  fresh, explicitly authorized replication checkpoint. Promotion increments a
  separate backend generation and does not move public DNS.
- Automatic failback requires ten successful checks and ten continuous healthy
  minutes. The controller drains and flushes the remote writer before claiming
  the home generation and returning DNS.
- Remote provider credentials remain for a ten-minute DNS grace after failback.
  The signed deactivation hook must then remove them before recovery closes.
- D1's `status_monitor_leases` serializes cron and operator transitions. A
  second writer claim, DNS move, or backend promotion cannot race the first.
- Every external mutation is fail-closed. Automatic regional activation,
  backend promotion, and dashboard redirection each require its own `AUTO_*`
  flag **and** `FAILOVER_DRILL_APPROVED=true`.

## Region and physical-backend registry

`REGION_REGISTRY` contains public topology only. It must contain at least two
regions, exactly one `default: true` region, unique endpoint hosts, one primary
backend per region, and clean HTTPS fixed origins. Backend IDs must match the
IDs in `DATAPLANE_STORAGE_REGIONS` and Aiven `storage_region_backends`.

```json
[
  {
    "id": "eu-central",
    "label": "Europe — Germany",
    "flag": "🇩🇪",
    "origin": "https://eu-origin.onsilo.dev",
    "endpointHosts": ["onsilo.dev", "eu.onsilo.dev"],
    "default": true,
    "backends": [
      {
        "id": "primary",
        "label": "Backblaze B2 Europe",
        "provider": "Backblaze B2",
        "role": "primary",
        "canaryRef": "b2-eu-primary"
      },
      {
        "id": "replica-1",
        "label": "EU replica provider",
        "provider": "another S3-compatible provider",
        "role": "replica",
        "canaryRef": "eu-replica-1"
      }
    ]
  },
  {
    "id": "us-east",
    "label": "United States — US East",
    "flag": "🇺🇸",
    "origin": "https://us-origin.onsilo.dev",
    "endpointHosts": ["us.onsilo.dev"],
    "default": false,
    "backends": [
      {
        "id": "primary",
        "label": "Backblaze B2 US East",
        "provider": "Backblaze B2",
        "role": "primary",
        "canaryRef": "b2-us-primary"
      }
    ]
  }
]
```

Adding a backend to this registry only enables monitoring; it does not register
or authorize the backend in Aiven. Follow `deploy/SETUP.md` in registry-first,
readiness-second, database-registration-third order.

## D1 and deployment

Create D1, replace the placeholder `database_id` in `wrangler.jsonc`, apply
all migrations, and deploy:

```sh
cd status-controller
bunx wrangler d1 create silo-status
bunx wrangler d1 migrations apply silo-status --remote --config wrangler.jsonc
bunx wrangler deploy --config wrangler.jsonc
```

Run migrations again after every new file is added; Wrangler tracks applied
migrations. Do not edit an already-applied D1 migration.

Route the Worker to `status-api.onsilo.dev/*`. If Silo uses Worker-based
break-glass fallbacks, also bind `onsilo.dev/*`, `eu.onsilo.dev/*`,
`us.onsilo.dev/*`, and `dash.onsilo.dev/*`; normal endpoint records remain
DNS-only and therefore bypass those routes. The dashboard fallback works by
temporarily proxying `dash.onsilo.dev` to the Worker, which redirects browsers
to `status.onsilo.dev`.

## Required variables

Non-secret variables live in `wrangler.jsonc`:

```text
REGION_REGISTRY=<JSON described above>
DASHBOARD_HEALTH_URL=https://control-origin.onsilo.dev/health
MAINTENANCE_URL=https://control-origin.onsilo.dev/api/maintenance-status
DASHBOARD_DNS_NAME=dash.onsilo.dev
CONTROL_PLANE_ORIGIN_HOST=control-origin.onsilo.dev
STATUS_ADMIN_ORIGINS=https://status.onsilo.dev
AUTO_ACTIVATE_FAILOVER=false
AUTO_PROMOTE_STORAGE=false
AUTO_REDIRECT_DASHBOARD=false
AUTO_RECOVER=true
FAILOVER_DRILL_APPROVED=false
```

`DASHBOARD_HEALTH_URL` and `MAINTENANCE_URL` must use the fixed control-plane
origin, never `dash.onsilo.dev`, because the public name can be redirected
during an incident.

Configure the following with `wrangler secret put`; never commit real values:

```text
DATAPLANE_INTERNAL_SECRET
REGION_CANARIES
CF_DNS_TOKEN
CF_ZONE_ID
CF_ENDPOINT_RECORD_IDS
CF_DASHBOARD_RECORD_ID
STATUS_ADMIN_SECRET
STATUS_INCIDENT_PASSWORD
FAILOVER_ACTIVATION_URLS
FAILOVER_DEACTIVATION_URLS
FAILOVER_HOOK_SECRET
ALERT_WEBHOOK_URL                 # optional
```

`CLOUDFLARE_API_BASE` is a test override. Leave it unset in production.

The Cloudflare token needs only DNS edit access for the Silo zone. The endpoint
record map is keyed by every hostname in `endpointHosts`:

```json
{
  "onsilo.dev": "cloudflare-record-id",
  "eu.onsilo.dev": "cloudflare-record-id",
  "us.onsilo.dev": "cloudflare-record-id"
}
```

Every fixed regional origin and target hostname must already exist and present
a valid certificate before automation is enabled. Regional endpoint records
are DNS-only CNAMEs with a 60-second TTL.

## Canary credentials

`REGION_CANARIES` has one logical Silo credential per logical region and one
direct provider credential per `canaryRef`:

```json
{
  "logical": {
    "eu-central": {
      "endpoint": "https://onsilo.dev",
      "bucket": "silo-status-eu",
      "accessKeyId": "...",
      "secretAccessKey": "...",
	  "sessionToken": "... optional temporary credential token ...",
      "signingRegion": "auto",
	  "prefix": "__silo_healthcheck/status",
	  "addressingStyle": "path"
    },
    "us-east": {
      "endpoint": "https://us.onsilo.dev",
      "bucket": "silo-status-us",
      "accessKeyId": "...",
      "secretAccessKey": "...",
      "signingRegion": "auto",
	  "prefix": "__silo_healthcheck/status",
	  "addressingStyle": "path"
    }
  },
  "backends": {
    "b2-eu-primary": {
      "endpoint": "https://<provider-endpoint>",
      "bucket": "<physical-bucket>",
      "accessKeyId": "...",
      "secretAccessKey": "...",
      "signingRegion": "auto",
      "prefix": "__silo_healthcheck/status"
    }
  }
}
```

Use dedicated buckets/keys or provider policies limited to HEAD plus
PUT/GET/DELETE under the canary prefix. Never reuse application provider keys.
The controller verifies uploaded bytes before deleting them. Missing physical
credentials report `unknown` rather than making an unmonitored backend safe to
promote. `addressingStyle` defaults to `path`; set it to `virtual` only when the
provider requires bucket-prefixed hostnames. Dotted bucket names must use path
style so wildcard TLS certificates remain valid. Temporary STS-style
credentials are supported through `sessionToken`.

## Signed failover authorization hooks

Normal regional dataplanes possess only their local logical-region provider
credentials. `FAILOVER_ACTIVATION_URLS` and `FAILOVER_DEACTIVATION_URLS` map a
logical source and target dataplane to an HTTPS hook:

```json
{
  "eu-central:us-east": "https://secrets-automation.example/hooks/eu-to-us",
  "us-east:eu-central": "https://secrets-automation.example/hooks/us-to-eu"
}
```

The Worker sends:

```http
POST /hooks/eu-to-us
Content-Type: application/json
Idempotency-Key: <request UUID>
X-Silo-Request-Timestamp: <ISO-8601 timestamp>
X-Silo-Signature: sha256=<lowercase HMAC-SHA256 hex>

{"action":"activate","storageRegion":"eu-central","targetDataplaneRegion":"us-east","requestedAt":"...","requestId":"..."}
```

The signature is HMAC-SHA256 of the exact raw request body with
`FAILOVER_HOOK_SECRET`, which must contain at least 32 random characters. The
hook must validate the signature in constant time, reject stale timestamps,
deduplicate `requestId`/`Idempotency-Key`, validate the exact source/target
allowlist, and return 2xx only after the requested deployment state is ready.

For `activate`, the hook atomically obtains the failed region's provider
credentials from Infisical, adds that region to the target's
`DATAPLANE_STORAGE_REGIONS` and `DATAPLANE_FAILOVER_REGIONS`, deploys/restarts
the target, and waits until protected `/ready` lists the region as authorized
and healthy. For `deactivate`, it removes the remote region and credentials,
restarts, and waits until `/ready.failoverRegions` no longer lists it. The
Worker polls authorization every two seconds for up to 55 seconds, so the hook
and Dokploy rollout must complete within that budget or fail closed.

The hook response must not include credentials. Log request ID, action,
source/target, secret version, deployment ID, result, and duration—but never
secret values or rendered environment files.

## Automatic and manual controls

Keep all automatic mutation flags false until every drill in
`deploy/FAILOVER_DRILLS.md` has current evidence. Then enable one behavior at a
time in a reviewed change:

- `AUTO_ACTIVATE_FAILOVER` moves a failed logical region to a healthy peer.
- `AUTO_PROMOTE_STORAGE` promotes a physical standby after replication and
  direct-canary gates pass.
- `AUTO_REDIRECT_DASHBOARD` points a failed dashboard name at the status route.
- `AUTO_RECOVER` defaults to true; a per-region operator hold overrides it.

`GET /api/admin/operations` returns protected regional state. Operator actions
all require `Authorization: Bearer <STATUS_ADMIN_SECRET>` and a JSON `region`:

```text
POST /api/admin/activate-failover
POST /api/admin/force-failback
POST /api/admin/hold-auto-recovery
POST /api/admin/resume-auto-recovery
POST /api/admin/promote-backend       # also requires backendId
```

These controls cannot skip readiness, writer ownership, accounting flush,
replication, backend generation, signed canary, or DNS ordering checks.

The incident desk uses the separate `STATUS_INCIDENT_PASSWORD` only to read,
acknowledge, and annotate incidents. `STATUS_ADMIN_SECRET` controls operational
transitions and maintenance windows. Add Cloudflare rate limiting for
`/api/admin/*`, use independent 32+ character values, and keep both only in the
team password manager.

Status-only maintenance windows publish a notice and suppress new automatic
failover; they do not stop S3. The Silo Admin Settings S3/full-maintenance
switches affect production. The Worker reads those switches from the fixed
`MAINTENANCE_URL`, retains the last verified result for at most three minutes,
and excludes planned samples from the 90-day component availability history.
