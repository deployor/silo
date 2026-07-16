# Emergency dataplane

This directory is the entire Hetzner recovery machine: Caddy, the published
Rust image, and an ephemeral local Valkey. It never starts the Bun dashboard,
Dokploy, Postgres, a persistent cache, or a disk cache.

Cloud-init receives only a ten-minute, one-use bootstrap token. It exchanges
that token with the independent status Worker over TLS, writes the returned
runtime environment as root mode `0600`, and deletes the token. Long-lived
credentials are encrypted at rest in D1 and never enter Hetzner user-data.

The VM always pulls `latest`. After Compose starts, cloud-init resolves the
actual RepoDigest for every service and reports those immutable references to
the incident history. The workflow reports dependency readiness; the
controller then transfers the Aiven writer lease, runs the signed write
canary, and only then changes `onsilo.dev`.

Set these GitHub Actions secrets before enabling the controller:

```text
HETZNER_API_TOKEN
STATUS_CALLBACK_URL
STATUS_CALLBACK_SECRET
STATUS_BOOTSTRAP_URL=https://status-api.onsilo.dev/api/bootstrap
STATUS_BOOTSTRAP_SECRET
CLOUDFLARE_DNS_API_TOKEN
AIVEN_DATABASE_URL
EMERGENCY_REDIS_PASSWORD
DATAPLANE_INTERNAL_SECRET
S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_ENDPOINT / S3_BUCKET_NAME / S3_REGION
```

The container image is built on every main-branch dataplane change and pulled
as `latest`; no Rust compilation happens during an outage. After the first
successful build, make both GHCR packages (`silo-dataplane` and `silo-caddy`)
public so a brand-new Hetzner VM can pull them without a long-lived registry
credential.

Teardown calls the protected accounting flush endpoint after primary writer
fencing and DNS grace. Any queued request, byte, or bucket event must be
idempotently committed to Aiven before Hetzner accepts the DELETE. A failed
flush retains the VM and alerts maintainers. If both Aiven and Valkey are
unavailable for an accounting event, the dataplane also writes a persistent
host marker under `/opt/silo/accounting`; restarts cannot clear the teardown
block, and an operator must reconcile usage before removing that marker.
