# Silo Rust Data Plane

High-throughput S3 object transfer service. Rust owns the hot data path:
standard S3 credential auth, public bucket reads, quota gates, cache hits,
provider streaming, stats counters, multipart lifecycle, bucket CORS, copy,
delete, and bucket byte commits. The Bun app remains the dashboard/control plane
and internal authorization fallback for custom-domain, offboarding, and dashboard
preview flows.

## Request Flow

1. Client sends an S3 request to the Rust data plane.
2. Rust authorizes normal AWS SigV4 S3 requests directly from Postgres/Redis and
   verifies the signature before constructing the jailed internal object path.
3. Rust falls back to Bun `/api/internal/dataplane/authorize` only for flows that
   should stay in the control plane, such as dashboard signed previews,
   offboarding export credentials, and custom-domain resolution.
4. Rust handles the normal S3 data protocol directly:
   `ListBuckets`, `GetObject`, `HeadObject`, `HeadBucket`,
   `GetBucketLocation`, `GetBucketCors`, `PutBucketCors`, `DeleteBucketCors`,
   `ListObjectsV2`, `PutObject`, `CopyObject`, `DeleteObject`,
   `DeleteObjects`, multipart create/list/upload-part/list-parts/complete/abort,
   and CORS preflight.
5. Unsupported S3 features fail closed from Rust with S3 XML errors. They are not
   proxied to Bun.

## Rust Modules

- `main.rs`: server startup, request dispatch, and upload/download handlers.
- `auth.rs`: direct S3 SigV4/public authorization, policy gates, CORS, path jail
  construction, and Bun fallback decisions.
- `bucket.rs`: ListBuckets, bucket CORS, and CORS preflight.
- `cache.rs`: Redis object body/metadata cache, conditional GET, byte ranges.
- `disk_cache.rs`: Rust-owned L2 disk cache for hot larger downloads with
  range serving, atomic write-through population, demand-based admission, and
  budget eviction.
- `copy.rs`: authenticated CopyObject source authorization and quota accounting.
- `delete.rs`: multi-object delete rewriting, MD5, cache invalidation, and byte
  accounting.
- `list.rs`: ListObjects query rewriting, list cache, XML key rewriting.
- `multipart.rs`: multipart lifecycle/listing with quota registration and
  cleanup.
- `quota.rs`: fail-closed Redis Lua quota reservations and releases.
- `upstream.rs`: provider URL construction, header filtering, SigV4 signing.
- `response.rs`: S3 response shaping, CORS, security headers.
- `security.rs`: bucket-prefix jail validation before any provider request.
- `stats.rs`: Redis stats counters compatible with the Bun stats flusher.

## Quota Model

- Downloads reserve egress quota before streaming the response body.
- Redis and disk cached downloads reserve egress quota before returning cached
  bytes.
- Normal uploads require `Content-Length`, reserve storage before streaming, and
  release the reservation if the upstream transfer fails.
- Deletes and multi-delete invalidate object/list caches immediately and release
  storage quota after upstream success.
- Multipart parts reserve per-part quota using the same Redis Lua semantics as
  the control-plane quota cache and release exact reservations on upstream
  failure or multipart abort.
- Successful uploads, copies, completes, and deletes update bucket totals
  directly in Postgres and invalidate Redis object/list caches.

## Required Env

Shared with Bun:

- `DATAPLANE_INTERNAL_SECRET`: strong shared secret, at least 24 characters.
- `DATABASE_URL`
- `REDIS_URL`
- `S3_DOMAIN`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_ENDPOINT`
- `S3_BUCKET_NAME`
- `S3_REGION`

Rust-only:

- `DATAPLANE_BIND`: defaults to `0.0.0.0:3001`.
- `CONTROL_PLANE_URL`: Bun app URL, defaults to `http://127.0.0.1:3000`.
- `DATAPLANE_PUBLIC_SCHEME`: reconstructs incoming S3 URLs, defaults to `https`.
- `DATAPLANE_DATABASE_MAX_CONNECTIONS`: optional Postgres pool size, defaults
  to `16`.
- `DATAPLANE_HTTP_POOL_MAX_IDLE_PER_HOST`: provider HTTP keepalive pool size,
  defaults to `128`.
- `DISK_CACHE_ENABLED`: defaults to `true`.
- `DISK_CACHE_DIR`: defaults to `/tmp/s3-disk-cache` in production.
- `DISK_CACHE_MAX_TOTAL_SIZE`: defaults to `21474836480` (20 GiB).
- `DISK_CACHE_MIN_SIZE`: defaults to `10485760` (10 MiB).
- `DISK_CACHE_MAX_FILE_SIZE`: defaults to `2147483648` (2 GiB).
- `DISK_CACHE_ADMISSION_HITS`: defaults to `2`.
- `DISK_CACHE_MAX_ENTRY_AGE_MS`: defaults to `43200000` (12 hours).
- `DATAPLANE_RL_ENABLED`: enables Redis-backed S3 data-plane rate limits,
  defaults to `true`.
- `DATAPLANE_RL_CLIENT_REQUESTS_PER_MINUTE`: pre-auth request limit per
  client IP, defaults to `12000`.
- `DATAPLANE_RL_BUCKET_REQUESTS_PER_MINUTE`: request limit per bucket, defaults
  to `60000`.
- `DATAPLANE_RL_BUCKET_INGRESS_BYTES_PER_MINUTE`: upload admission per bucket,
  defaults to `549755813888` (512 GiB).
- `DATAPLANE_RL_BUCKET_EGRESS_BYTES_PER_MINUTE`: download admission per bucket,
  defaults to `1099511627776` (1 TiB).
- `DATAPLANE_RL_USER_REQUESTS_PER_MINUTE`,
  `DATAPLANE_RL_USER_INGRESS_BYTES_PER_MINUTE`, and
  `DATAPLANE_RL_USER_EGRESS_BYTES_PER_MINUTE`: optional per-user limits,
  default to `0` (disabled).

## Local Commands

```sh
bun run dataplane:check
bun run dataplane:dev
```

## Production Routing

Run this as a separate service from the Bun control plane.

- Route `S3_DOMAIN` to the Rust data plane.
- Route `dashboard.S3_DOMAIN` to the Bun control plane.
- Set `CONTROL_PLANE_URL` in Rust to the private Bun service URL.
- Set the same `DATAPLANE_INTERNAL_SECRET` in both services.
- Prefer firewall/private networking so `/api/internal/dataplane/*` is only
  reachable by the Rust service. The endpoint also requires the shared secret
  and fails closed when it is missing.

The root `docker-compose.prod.yml` is a minimal two-service template for this
layout. It mounts a persistent `dataplane-cache` volume for the Rust disk cache.
