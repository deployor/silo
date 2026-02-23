# Silo S3 Gateway — Codebase Improvements Plan

> Goal: Make Silo behave like a proper, standard S3 provider — no proprietary weirdness. Improve performance, reliability, and observability while keeping everything S3-compatible.

## Guiding Principles
- **Standard S3 behavior** — every improvement must be invisible to S3 clients (aws-cli, boto3, etc.)
- **No proprietary headers or behaviors** unless they're additive (like `X-Cache` which is standard CDN practice)
- **Performance wins** should reduce load on our infra, not add complexity for users

---

## Phase 1: Stats Batching (Biggest Perf Win)

**Problem:** `statsService.recordUsage()` runs a Postgres transaction with 2 UPDATE queries on every authenticated request.

**Files:** `src/services/stats-service.ts`, `src/index.ts`

**Plan:**
1. Replace per-request DB writes with Redis `INCRBY` operations:
   - `stats:{userId}:ingress` — atomic increment
   - `stats:{userId}:egress` — atomic increment
   - `stats:{userId}:requests` — atomic increment
   - `stats:bucket:{bucketId}:requests` — atomic increment
2. Add a periodic flush (every 30s) that:
   - Reads all `stats:*` keys from Redis via SCAN
   - Batches them into a single DB transaction
   - Uses `GETDEL` to atomically read+clear Redis counters
3. Register the flush timer so graceful shutdown (Phase 3) can trigger a final flush

**Impact:** Eliminates ~2 DB queries per request → massive throughput improvement under load.

---

## Phase 2: Auth Cache Improvements

**Problem:** Auth lookup does a 3-table JOIN + a SUM query per authenticated request. Cache TTL is only 60s.

**Files:** `src/middleware/auth.ts`

**Plan:**
1. Increase auth cache TTL from 60s → 300s (5 minutes)
   - Storage usage for quota checks can be slightly stale — it's already eventually consistent
2. Cache public bucket lookups in Redis (currently uncached, hits DB every time)
   - Key: `auth:pub:{bucketName}` with 300s TTL
   - For unauthenticated GET/HEAD to public buckets (the most common CDN use case)
3. Invalidate auth cache on:
   - User lock/unlock
   - Bucket pause/unpause
   - Key pause/unpause
   - Quota changes

**Impact:** Reduces DB queries for repeat visitors to near-zero.

---

## Phase 3: Graceful Shutdown

**Problem:** No signal handlers — container stop drops in-flight requests and loses buffered log queue.

**Files:** `src/index.ts`, `src/services/log-service.ts`, `src/services/stats-service.ts`

**Plan:**
1. Add `SIGTERM` and `SIGINT` handlers in `src/index.ts`
2. On signal:
   - Stop accepting new connections (Bun.serve stop)
   - Wait up to 10s for in-flight requests to complete
   - Flush `logService` pending queue
   - Flush `statsService` Redis → DB (from Phase 1)
   - Flush disk cache pending writes
   - Close Redis connection
   - Close Postgres pool
   - Exit cleanly
3. Add a `shutdownInProgress` flag to reject new requests with `503 Service Unavailable` during drain

**Impact:** Data integrity — no lost logs or stats on deploy/restart.

---

## Phase 4: Health Check Endpoint

**Problem:** No way for orchestrators (Docker, K8s) to check service health.

**Files:** `src/index.ts`

**Plan:**
1. Add `GET /health` endpoint (excluded from rate limiting and auth)
2. Returns JSON:
   ```json
   {
     "status": "ok",
     "uptime": 12345,
     "redis": "connected",
     "postgres": "connected",
     "diskCache": { "usedBytes": 1234, "totalBudget": 21474836480, "entries": 42 },
     "version": "abc1234"
   }
   ```
3. Checks:
   - Redis: `PING` command
   - Postgres: `SELECT 1` query
   - If either fails → status 503 with `"status": "degraded"`

**Impact:** Essential for production container health probes.

---

## Phase 5: ETag / 304 Not Modified Support

**Problem:** Every GET re-serves full body even if client already has it. This is standard S3 behavior that's missing.

**Files:** `src/core/s3/get.ts`

**Plan:**
1. Before fetching from cache or upstream, check request for:
   - `If-None-Match` header → compare against cached ETag
   - `If-Modified-Since` header → compare against cached Last-Modified
2. If match → return `304 Not Modified` with no body (just headers)
3. For cache hits (Redis L1, Disk L2): use stored ETag from metadata
4. For upstream passes: let S3 handle it natively (it already supports conditional GETs)
5. This is **standard S3 behavior** — every S3 provider supports this

**Impact:** Massive bandwidth savings for repeat requests (browser, CDN, apps caching assets).

---

## Phase 6: Cache-Control Headers

**Problem:** S3 object responses don't include Cache-Control for downstream caching.

**Files:** `src/core/s3/get.ts`, `src/core/s3/index.ts`

**Plan:**
1. For **public bucket** objects: add `Cache-Control: public, max-age=3600` (1 hour default)
2. For **authenticated** objects: add `Cache-Control: private, no-cache` 
3. Respect any `Cache-Control` header already set by the upstream S3 (pass through)
4. Make defaults configurable via bucket settings or env var
5. Standard S3 behavior — AWS passes through Cache-Control if set on the object

**Impact:** Offloads repeat traffic to browser cache and CDN edge.

---

## Phase 7: Response Compression

**Problem:** No compression on responses. Text content is sent uncompressed.

**Files:** New `src/middleware/compression.ts`, `src/index.ts`

**Plan:**
1. Create compression middleware that:
   - Checks `Accept-Encoding` header for `br`, `gzip`, `deflate`
   - Only compresses text-based content types: `text/*`, `application/json`, `application/xml`, `application/javascript`, `image/svg+xml`
   - Only compresses responses > 1KB (below that, overhead isn't worth it)
   - Sets `Content-Encoding` and `Vary: Accept-Encoding` headers
   - Removes `Content-Length` (compressed size differs)
2. Use Bun native: `Bun.gzipSync()` for gzip, `Bun.deflateSync()` for deflate
3. Brotli via `node:zlib` `brotliCompressSync()` for `br`
4. **Skip compression** for:
   - Already compressed content (images, video, zip, etc.)
   - Streaming responses (no Content-Length / very large)
   - Range requests
5. This is standard HTTP behavior — AWS S3 doesn't compress, but CloudFront/CDNs do. Since we act as a proxy, this is a legitimate optimization.

**Impact:** 50-80% smaller text responses.

---

## Phase 8: Security Headers Optimization

**Problem:** `securityHeaders()` creates a new Response object for every request including S3 binary streams. CSP/HSTS don't matter for `application/octet-stream`.

**Files:** `src/middleware/security-headers.ts`, `src/index.ts`

**Plan:**
1. Split into two paths:
   - **Dashboard responses**: Full security headers (CSP, HSTS, X-Frame-Options, etc.)
   - **S3 object responses**: Only `X-Content-Type-Options: nosniff` + `Content-Disposition` for dangerous types (already handled in GET handler)
2. Avoid creating a new `Response` when possible — just set headers on the existing response headers object
3. For S3 responses, skip the Response cloning entirely and just append the minimal headers

**Impact:** Eliminates unnecessary Response object allocation on every S3 request + removes irrelevant headers.

---

## Phase 9: S3 Client Retry Improvements

**Problem:** Fixed 30s timeout, exponential backoff without jitter, no circuit breaker.

**Files:** `src/lib/s3-client.ts`

**Plan:**
1. Make timeout configurable: `S3_TIMEOUT_MS` env var (default 30000)
2. Add jitter to backoff: `2^i * 100 + random(0, 100)ms` to prevent thundering herd
3. Add circuit breaker:
   - Track consecutive failures
   - After 5 consecutive failures, open circuit for 30s
   - During open: fail fast with 503 instead of waiting for timeout
   - After 30s: allow one probe request through (half-open)
4. Log retry attempts with structured data

**Impact:** Better behavior under upstream S3 outages, prevents cascading failures.

---

## Phase 10: Connection Pooling

**Problem:** Postgres client has no explicit pool configuration.

**Files:** `src/db/index.ts`

**Plan:**
1. Configure explicit pool settings:
   ```ts
   const client = postgres(connectionString, {
     prepare: false,
     max: 20,                    // max connections
     idle_timeout: 30,           // close idle connections after 30s  
     connect_timeout: 10,        // fail fast on connection
     max_lifetime: 60 * 30,      // recycle connections every 30min
   });
   ```
2. Add env var overrides: `DB_POOL_MAX`, `DB_IDLE_TIMEOUT`

**Impact:** Prevents connection exhaustion under load, reduces stale connection issues.

---

## Phase 11: Admin Cache Stats Page

**Problem:** No visibility into cache performance. `getDiskCacheStats()` exists but isn't exposed.

**Files:** `src/web/admin/index.ts`, new `src/views/admin-cache.hbs`

**Plan:**
1. Add a new "Cache" tab to the admin panel (alongside Users, Logs, Redemptions)
2. Create `GET /api/admin/cache-stats` endpoint returning:
   - **Redis**: `INFO memory` (used_memory, maxmemory), `INFO stats` (keyspace_hits, keyspace_misses, hit_rate), `DBSIZE`
   - **Disk Cache**: from `getDiskCacheStats()` — entries, total size, budget, demand tracker size, top hottest keys
   - **Hit Rates**: computed Redis hit rate, disk hit rate
3. Design the page to match existing admin UI:
   - Stats cards at top (Redis memory, Disk usage, Hit rates)
   - Table of hottest cached objects
   - Auto-refresh every 30s
   - Same Tailwind dark theme, rounded cards, `hc-red` accents, phosphor icons

**Impact:** Visibility into caching effectiveness, helps tune cache settings.

---

## Phase 12: Request Log Retention

**Problem:** `request_logs` table grows unbounded — every request creates a row forever.

**Files:** New `src/services/log-cleanup-service.ts`, `src/index.ts`

**Plan:**
1. Add a background interval (runs every hour) that:
   - Deletes logs older than N days (default 30, configurable via `LOG_RETENTION_DAYS` env var)
   - Uses `DELETE FROM request_logs WHERE created_at < NOW() - INTERVAL 'N days'`
   - Limits deletion batch size (1000 per iteration) to avoid long-running transactions
2. Register with graceful shutdown to clear the interval
3. Log how many rows were cleaned up

**Impact:** Prevents database bloat, keeps queries fast.

---

## Phase 13: Range Request Support for Disk Cache

**Problem:** Disk cache is bypassed for range requests. Video streaming and large file resume don't benefit.

**Files:** `src/core/s3/get.ts`, `src/lib/disk-cache.ts`

**Plan:**
1. Add a `diskCacheGetRange()` function that:
   - Parses `Range: bytes=start-end` header
   - Uses `Bun.file(path).slice(start, end+1)` for zero-copy range serving
   - Returns proper `206 Partial Content` with `Content-Range` header
2. In GET handler, check disk cache even for range requests:
   - If full file is cached on disk, serve the range from it
   - If not cached, pass through to upstream (which handles ranges natively)
3. Standard S3 behavior — range requests are a core S3 feature

**Impact:** Video streaming and resume downloads served from local disk instead of upstream.

---

## Phase 14: Structured Logging

**Problem:** All logging is unstructured `console.log` strings. Hard to parse and alert on.

**Files:** New `src/lib/logger.ts`, all files using `console.log/error`

**Plan:**
1. Create a lightweight logger that outputs JSON in production:
   ```ts
   logger.info("Cache hit", { bucket: "my-bucket", key: "file.jpg", layer: "redis", latencyMs: 2 })
   // → {"level":"info","msg":"Cache hit","bucket":"my-bucket","key":"file.jpg","layer":"redis","latencyMs":2,"ts":"2026-..."}
   ```
2. In development, output human-readable format
3. Include request context automatically (requestId, ip, user) from AsyncLocalStorage
4. Severity levels: `debug`, `info`, `warn`, `error`
5. Replace `console.log`/`console.error` calls across the codebase

**Impact:** Production-grade log analysis, easier debugging, alerting capability.

---

## Implementation Order

```
Phase 1  → Stats Batching (biggest perf win, foundation for Phase 3)
Phase 3  → Graceful Shutdown (needs Phase 1 flush integration)
Phase 2  → Auth Cache Improvements (quick win)
Phase 10 → Connection Pooling (quick config change)
Phase 4  → Health Check Endpoint (small, high value)
Phase 5  → ETag/304 Support (standard S3 compliance)
Phase 6  → Cache-Control Headers (standard S3 compliance)
Phase 8  → Security Headers Optimization (perf improvement)
Phase 7  → Response Compression (bandwidth savings)
Phase 9  → S3 Client Retry Improvements (reliability)
Phase 11 → Admin Cache Stats Page (observability)
Phase 12 → Log Retention (maintenance)
Phase 13 → Range Request Disk Cache (feature)
Phase 14 → Structured Logging (quality of life)
```

## Files Modified/Created Summary

| File | Action | Phase |
|------|--------|-------|
| `src/services/stats-service.ts` | Rewrite | 1 |
| `src/index.ts` | Modify | 1, 3, 4, 8 |
| `src/middleware/auth.ts` | Modify | 2 |
| `src/services/log-service.ts` | Modify | 3 |
| `src/db/index.ts` | Modify | 10 |
| `src/core/s3/get.ts` | Modify | 5, 6, 13 |
| `src/core/s3/index.ts` | Modify | 6 |
| `src/middleware/security-headers.ts` | Rewrite | 8 |
| `src/middleware/compression.ts` | Create | 7 |
| `src/lib/s3-client.ts` | Modify | 9 |
| `src/lib/disk-cache.ts` | Modify | 13 |
| `src/lib/logger.ts` | Create | 14 |
| `src/web/admin/index.ts` | Modify | 11 |
| `src/views/admin.hbs` | Modify | 11 |
| `src/services/log-cleanup-service.ts` | Create | 12 |
