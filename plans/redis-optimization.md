# Plan: Redis Optimization & S3 Performance Overhaul

## Objective
Make S3 "fucking FAST" by aggressively caching data, metadata, and optimizing IO paths.

## 🚀 The "Fucking FAST" Strategy

### 1. S3 Object Caching (The Big Win)
**Impact:** ⚡ **Instant Downloads** | 📉 **Zero Egress**
-   **What:** Cache binary content of small-to-medium files in Redis.
-   **Why:** Serving from RAM (Redis) is orders of magnitude faster than fetching from S3.
-   **Action:**
    -   Cache files < 10MB in Redis.
    -   Cache metadata (Headers, Content-Type, ETag) for ALL files. Even if we have to fetch the body from S3, having headers cached allows us to respond to `HEAD` requests instantly (used heavily by browsers/clients).

### 2. S3 Connection Pooling
**Impact:** ⚡ **Lower Latency**
-   **What:** Re-use TCP connections to S3.
-   **Why:** Setting up a new SSL/TCP connection for every request is slow. `aws4fetch` (used in `src/lib/s3-client.ts`) uses the native `fetch` API. In Bun, `fetch` handles keep-alive automatically, but we should verify we aren't destroying clients unnecessarily.
-   **Action:**
    -   Ensure `HetznerS3Client` is a true singleton (it already is).

### 3. XML Response Caching
**Impact:** ⚡ **Snappy Listings**
-   **What:** Cache `ListObjects` (XML) responses.
-   **Why:** Tools like `aws s3 ls` or file browsers constantly list buckets. Generating that XML requires a DB query and XML serialization every time.
-   **Action:**
    -   Cache the generated XML for `ListObjectsV2`.
    -   Invalidate this cache whenever a `PUT` or `DELETE` happens in that bucket.

### 4. Auth & Metadata Caching
**Impact:** ⚡ **Lower Latency per Request**
-   **What:** Cache DB lookups for API Keys, Users, and Bucket Configs.
-   **Why:** Every request hits Postgres. Redis is faster for these key-value lookups.
-   **Action:** Cache `access_key` -> `user_id` mapping.

### 5. Optimizing HEAD Requests
**Impact:** ⚡ **Faster Preflight/Checks**
-   **What:** `HEAD` requests currently fetch metadata from S3.
-   **Why:** Browsers do this constantly.
-   **Action:** Implement `handleHeadRequest` properly in `src/core/s3/head.ts` (or inline in `index.ts`) to use the **Metadata Cache** from Redis.

---

## Implementation Steps

### Phase 1: Foundation (Redis)
1.  [ ] **Install Dependencies:** `ioredis`.
2.  [ ] **Config:** `REDIS_URL`.
3.  [ ] **Service:** `src/lib/redis.ts`.

### Phase 2: Aggressive Read Caching
4.  [ ] **Object Cache:** `src/core/s3/get.ts` (Body + Headers).
5.  [ ] **List Cache:** `src/core/s3/get.ts` (XML Listings).
6.  [ ] **HEAD Cache:** Update `src/core/s3/index.ts` to use cached metadata for `HEAD` requests.
7.  [ ] **Invalidation:** `src/core/s3/put.ts` & `src/core/s3/delete.ts` (Clear Object + List caches).


## Technical Details

**Cache Keys:**
-   `s3:body:{bucket}:{key}` (Buffer)
-   `s3:meta:{bucket}:{key}` (JSON Headers)
-   `s3:list:{bucket}:{prefix}` (XML String)
-   `auth:key:{accessKey}` (JSON User)
