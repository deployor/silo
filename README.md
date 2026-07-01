<div align="center">

# Silo

**Free S3-compatible object storage for Hack Clubbers.**

[Dashboard](https://silo.deployor.dev) • [Docs](https://silo.deployor.dev/docs)

</div>

---

## What is this?

Silo is a high-performance S3-compatible object storage service for Hack Club members. The Rust data plane owns S3 authentication, quota enforcement, caching, and object transfer against the backing provider; the Bun app owns the dashboard, account management, and internal control-plane APIs.

This repository contains the Silo Rust data plane, dashboard, and control-plane API.

## Documentation

For full documentation on how to use Silo, including SDK examples, configuration guides, and API references, please visit our **[Documentation Site](https://silo.deployor.dev/docs)**.

## Key Features

- **S3 Compatibility**: Works with standard tools like AWS CLI, Rclone, and official AWS SDKs.
- **Instant Provisioning**: Log in with Hack Club Auth and get credentials immediately.
- **Public & Private Buckets**: Host static assets publicly or keep backups private.
- **CORS Support**: Configurable Cross-Origin Resource Sharing for web applications.
- **Cloudflare for SaaS custom domains**: Managed SSL/TLS and hostname onboarding for bucket domains.

## Development

- Start local development (backend + React asset watcher): `bun dev`
- Build production assets: `bun run build`
- Start production server: `bun run start`
- Check the Rust S3 data plane: `bun run dataplane:check`
- Rust owns the Redis and disk object caches; Bun only reads cache stats for
  admin/health pages.

## Production

Production runs as two services: the Bun control plane for the dashboard and
account APIs, and the Rust data plane for all S3-compatible object traffic.
Point `dashboard.${S3_DOMAIN}` at the control-plane service and `${S3_DOMAIN}`
at the dataplane service.

1. Copy `.env.production.example` to `.env.production` and fill in the real
   Postgres, Redis, provider S3, Hack Club Auth, Slack, and
   `DATAPLANE_INTERNAL_SECRET` values.
2. Deploy with `GIT_SHA=$(git rev-parse HEAD) docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`.
3. Set `GIT_DATE` and `GIT_MESSAGE` the same way if you want those values in
   the dashboard build metadata.

The dataplane exposes `/health` and owns auth, bucket jail enforcement, quota
checks, provider streaming, Redis metadata cache, and disk object cache.

## Cloudflare for SaaS setup

Custom-domain support is currently feature-flagged. It is disabled unless `DOMAINS=true` is explicitly set in the environment.
Deep Freeze is also feature-flagged. It is disabled unless `DEEP_FREEZE=true` is explicitly set in the environment.

Custom domains now assume Cloudflare for SaaS is the source of truth for SSL issuance and hostname validation.

Required environment variables:

- `DOMAINS` — set to `true` to enable all custom-domain UI/API/runtime behavior.
- `DEEP_FREEZE` — set to `true` to enable all Deep Freeze UI/API/runtime behavior.
- `CF_API_TOKEN` — Cloudflare API token with custom hostname permissions for the zone.
- `CF_ZONE_ID` — Zone ID for the SaaS zone.
- `CF_SAAS_FALLBACK_ORIGIN` — Origin hostname Cloudflare should send traffic to.
- `CF_SAAS_TARGET` — Hostname customers should CNAME to. Defaults to `S3_DOMAIN`.
- `CF_SAAS_MIN_TLS` — Optional minimum TLS version. Defaults to `1.2`.

Expected flow:

1. Add a domain in the dashboard.
2. The backend creates a Cloudflare custom hostname.
3. The dashboard shows the ownership TXT record and any SSL/DCV records returned by Cloudflare.
4. The user points their hostname at the Cloudflare SaaS target and adds the TXT records.
5. Silo verifies by polling Cloudflare hostname status instead of doing direct DNS checks itself.

Important: if Cloudflare returns an `_acme-challenge` TXT record, you must add that too. Ownership TXT alone is not always enough for HTTPS issuance.

The frontend is rendered via React and bundled with Vite into [`src/assets/react/app.js`](src/assets/react/app.js) and [`src/assets/react/app.css`](src/assets/react/app.css).

---

<div align="center">

Made with love for <a href="https://hackclub.com/">Hack Club</a>

</div>
