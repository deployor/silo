<div align="center">

# Silo

**Free S3-compatible object storage for Hack Clubbers.**

[Dashboard](https://silo.deployor.dev) • [Docs](https://silo.deployor.dev/docs)

</div>

---

## What is this?

Silo is a high-performance S3 gateway that provides free object storage for Hack Club members. It proxies requests to a unified backend while managing authentication, quotas, and permissions, giving you a standard S3 API experience without the complexity or cost of enterprise cloud providers.

This repository contains the source code for the Silo gateway, dashboard, and API.

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

## Cloudflare for SaaS setup

Custom domains now assume Cloudflare for SaaS is the source of truth for SSL issuance and hostname validation.

Required environment variables:

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
