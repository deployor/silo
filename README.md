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

## Development

- Start local development (backend + React asset watcher): `bun dev`
- Build production assets: `bun run build`
- Start production server: `bun run start`

The frontend is rendered via React and bundled with Vite into [`src/assets/react/app.js`](src/assets/react/app.js) and [`src/assets/react/app.css`](src/assets/react/app.css).

---

<div align="center">

Made with love for <a href="https://hackclub.com/">Hack Club</a>

</div>
