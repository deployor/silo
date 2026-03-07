/**
 * Cache-focused stress test for Silo staging.
 *
 * Usage:
 *   S3_ENDPOINT='https://silo.deployor.dev' \
 *   S3_BUCKET='testingbucketforcache' \
 *   S3_ACCESS_KEY_ID='...' \
 *   S3_SECRET_ACCESS_KEY='...' \
 *   bun run scripts/test-cache-stress.ts
 *
 * Optional env:
 *   S3_REGION=auto
 *   CACHE_OBJECT_COUNT=200
 *   CACHE_OBJECT_SIZE=131072      # bytes (default 128 KiB)
 *   COLD_CONCURRENCY=40
 *   HOT_CONCURRENCY=250
 *   HOT_REQUESTS=8000
 *   HOT_RANGE_BYTES=16384         # request only first N bytes per hot GET
 *   MAX_HOT_SECONDS=180           # hard stop for hot phase
 *   PROGRESS_EVERY=500            # print progress every N completed reqs
 *   TIMEOUT_MS=25000
 *   HOT_TIMEOUT_MS=8000           # timeout per hot request (faster tail)
 */

import { randomBytes } from "node:crypto";
import { AwsClient } from "aws4fetch";

type Cfg = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  objectCount: number;
  objectSize: number;
  coldConcurrency: number;
  hotConcurrency: number;
  hotRequests: number;
  hotRangeBytes: number;
  maxHotSeconds: number;
  progressEvery: number;
  timeoutMs: number;
  hotTimeoutMs: number;
};

type Stats = {
  ok: number;
  fail: number;
  timeouts: number;
  rateLimited: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  rps: number;
  bytes: number;
  statuses: Map<number, number>;
};

function must(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${name}: ${raw}`);
  return Math.floor(n);
}

function cfg(): Cfg {
  return {
    endpoint: must("S3_ENDPOINT"),
    bucket: must("S3_BUCKET"),
    accessKeyId: must("S3_ACCESS_KEY_ID"),
    secretAccessKey: must("S3_SECRET_ACCESS_KEY"),
    region: process.env.S3_REGION ?? "auto",
    objectCount: num("CACHE_OBJECT_COUNT", 200),
    objectSize: num("CACHE_OBJECT_SIZE", 128 * 1024),
    coldConcurrency: num("COLD_CONCURRENCY", 40),
    hotConcurrency: num("HOT_CONCURRENCY", 250),
    hotRequests: num("HOT_REQUESTS", 8000),
    hotRangeBytes: num("HOT_RANGE_BYTES", 16 * 1024),
    maxHotSeconds: num("MAX_HOT_SECONDS", 180),
    progressEvery: num("PROGRESS_EVERY", 500),
    timeoutMs: num("TIMEOUT_MS", 25000),
    hotTimeoutMs: num("HOT_TIMEOUT_MS", 8000),
  };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function keyPath(key: string): string {
  return encodeURIComponent(key).replace(/%2F/g, "/");
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function seedObjects(aws: AwsClient, c: Cfg, prefix: string) {
  const body = randomBytes(c.objectSize);
  const keys = Array.from({ length: c.objectCount }, (_, i) => `${prefix}/obj-${i}.bin`);

  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= keys.length) return;
      const key = keys[i]!;
      const url = `${c.endpoint}/${c.bucket}/${keyPath(key)}`;
      const signed = await aws.sign(url, { method: "PUT" });
      const headers = new Headers(signed.headers);
      headers.set("content-length", String(body.byteLength));
      const res = await fetchWithTimeout(
        signed.url,
        { method: "PUT", headers, body },
        c.timeoutMs,
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Seed PUT failed ${key}: ${res.status} ${txt}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(c.coldConcurrency, 32) }, () => worker()));
  return keys;
}

async function coldPrime(aws: AwsClient, c: Cfg, keys: string[]): Promise<Stats> {
  const samples: number[] = [];
  const statuses = new Map<number, number>();
  let ok = 0;
  let fail = 0;
  let timeouts = 0;
  let rateLimited = 0;
  let bytes = 0;
  let idx = 0;
  let done = 0;

  const start = performance.now();
  const presigned = await Promise.all(
    keys.map(async (key) => {
      const url = `${c.endpoint}/${c.bucket}/${keyPath(key)}`;
      const signed = await aws.sign(url, { method: "GET", aws: { signQuery: true } });
      return signed.url;
    }),
  );

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= keys.length) return;

      const t0 = performance.now();
      try {
        const res = await fetchWithTimeout(presigned[i]!, { method: "GET" }, c.timeoutMs);
        const ms = performance.now() - t0;
        samples.push(ms);
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);

        if (res.ok) {
          ok++;
          const buf = await res.arrayBuffer();
          bytes += buf.byteLength;
        } else {
          fail++;
          if (res.status === 429) rateLimited++;
          await res.text().catch(() => "");
        }
      } catch (e) {
        const ms = performance.now() - t0;
        samples.push(ms);
        fail++;
        if (String(e).includes("timeout")) timeouts++;
        statuses.set(0, (statuses.get(0) ?? 0) + 1);
      }

      done++;
      if (done % c.progressEvery === 0 || done === keys.length) {
        const elapsed = (performance.now() - start) / 1000;
        const liveRps = done / Math.max(elapsed, 0.001);
        console.log(`COLD progress: ${done}/${keys.length} (${((done / keys.length) * 100).toFixed(1)}%) @ ${liveRps.toFixed(1)} req/s`);
      }
    }
  }

  await Promise.all(Array.from({ length: c.coldConcurrency }, () => worker()));
  const wallMs = performance.now() - start;

  return {
    ok,
    fail,
    timeouts,
    rateLimited,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    min: samples.length ? Math.min(...samples) : 0,
    max: samples.length ? Math.max(...samples) : 0,
    rps: samples.length / (wallMs / 1000),
    bytes,
    statuses,
  };
}

async function hotReadBlast(aws: AwsClient, c: Cfg, keys: string[]): Promise<Stats> {
  const samples: number[] = [];
  const statuses = new Map<number, number>();
  let ok = 0;
  let fail = 0;
  let timeouts = 0;
  let rateLimited = 0;
  let bytes = 0;
  let idx = 0;
  let done = 0;

  const start = performance.now();
  const hardDeadline = start + c.maxHotSeconds * 1000;
  const rangeHeader = `bytes=0-${Math.max(0, c.hotRangeBytes - 1)}`;

  const presigned = await Promise.all(
    keys.map(async (key) => {
      const url = `${c.endpoint}/${c.bucket}/${keyPath(key)}`;
      const signed = await aws.sign(url, { method: "GET", aws: { signQuery: true } });
      return signed.url;
    }),
  );

  let lastProgressAt = performance.now();

  async function worker(workerId: number) {
    while (true) {
      if (performance.now() >= hardDeadline) return;

      const i = idx++;
      if (i >= c.hotRequests) return;

      // Zipf-ish hotness: first ~20% keys are hit much more frequently.
      const r = Math.random();
      const hotBand = Math.max(1, Math.floor(keys.length * 0.2));
      const keyIndex = r < 0.8
        ? Math.floor(Math.random() * hotBand)
        : hotBand + Math.floor(Math.random() * Math.max(1, keys.length - hotBand));
      const signedUrl = presigned[Math.min(keys.length - 1, keyIndex)]!;

      const t0 = performance.now();
      try {
        const res = await fetchWithTimeout(
          signedUrl,
          { method: "GET", headers: { Range: rangeHeader } },
          c.hotTimeoutMs,
        );
        const ms = performance.now() - t0;
        samples.push(ms);
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);

        if (res.ok) {
          ok++;
          const buf = await res.arrayBuffer();
          bytes += buf.byteLength;
        } else {
          fail++;
          if (res.status === 429) rateLimited++;
          if (workerId === 0) await res.text().catch(() => "");
        }
      } catch (e) {
        const ms = performance.now() - t0;
        samples.push(ms);
        fail++;
        if (String(e).includes("timeout")) timeouts++;
        statuses.set(0, (statuses.get(0) ?? 0) + 1);
      }

      done++;
      const now = performance.now();
      if (done % c.progressEvery === 0 || now - lastProgressAt > 5000) {
        lastProgressAt = now;
        const elapsed = (now - start) / 1000;
        const liveRps = done / Math.max(elapsed, 0.001);
        const remaining = Math.max(0, c.hotRequests - done);
        const etaSec = liveRps > 0 ? remaining / liveRps : 0;
        console.log(
          `HOT progress: ${done}/${c.hotRequests} (${((done / c.hotRequests) * 100).toFixed(1)}%) @ ${liveRps.toFixed(1)} req/s, p95=${percentile(samples, 0.95).toFixed(1)}ms, eta=${etaSec.toFixed(0)}s`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: c.hotConcurrency }, (_, w) => worker(w)));
  const wallMs = performance.now() - start;

  return {
    ok,
    fail,
    timeouts,
    rateLimited,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    min: samples.length ? Math.min(...samples) : 0,
    max: samples.length ? Math.max(...samples) : 0,
    rps: samples.length / (wallMs / 1000),
    bytes,
    statuses,
  };
}

function printStats(name: string, s: Stats) {
  console.log(`\n=== ${name} ===`);
  console.log(`ok/fail: ${s.ok}/${s.fail}`);
  console.log(`timeouts: ${s.timeouts}, 429s: ${s.rateLimited}`);
  const total = s.ok + s.fail;
  const successRate = total > 0 ? (s.ok / total) * 100 : 0;
  console.log(`success rate: ${successRate.toFixed(2)}%`);
  console.log(`latency ms: min=${s.min.toFixed(1)} p50=${s.p50.toFixed(1)} p95=${s.p95.toFixed(1)} max=${s.max.toFixed(1)}`);
  console.log(`throughput: ${s.rps.toFixed(2)} req/s`);
  console.log(`effective throughput (2xx): ${(s.rps * (successRate / 100)).toFixed(2)} req/s`);
  console.log(`bytes read: ${(s.bytes / (1024 * 1024)).toFixed(2)} MiB`);
  const statusList = [...s.statuses.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`statuses: ${statusList.map(([code, count]) => `${code}:${count}`).join(", ") || "none"}`);
}

async function main() {
  const c = cfg();
  const aws = new AwsClient({
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    service: "s3",
    region: c.region,
  });

  const runId = new Date().toISOString().replace(/[.:]/g, "-");
  const prefix = `cache-stress/${runId}`;

  console.log("🚀 Cache stress test starting");
  console.log(`endpoint=${c.endpoint}`);
  console.log(`bucket=${c.bucket}`);
  console.log(`objects=${c.objectCount}, objectSize=${c.objectSize} bytes`);
  console.log(`coldConcurrency=${c.coldConcurrency}, hotConcurrency=${c.hotConcurrency}, hotRequests=${c.hotRequests}`);
  console.log(`hotRangeBytes=${c.hotRangeBytes}, maxHotSeconds=${c.maxHotSeconds}, progressEvery=${c.progressEvery}`);
  console.log(`timeoutMs=${c.timeoutMs}, hotTimeoutMs=${c.hotTimeoutMs}`);
  console.log(`prefix=${prefix}`);

  const keys = await seedObjects(aws, c, prefix);
  console.log(`✅ Seeded ${keys.length} objects`);

  const cold = await coldPrime(aws, c, keys);
  printStats("COLD PRIMING", cold);

  const hot = await hotReadBlast(aws, c, keys);
  printStats("HOT CACHE BLAST", hot);

  const speedup = cold.p95 > 0 ? cold.p95 / Math.max(hot.p95, 0.0001) : 0;
  console.log(`\nEstimated hot-vs-cold p95 improvement: ${speedup.toFixed(2)}x`);
  const hotSuccessRate = hot.ok + hot.fail > 0 ? (hot.ok / (hot.ok + hot.fail)) * 100 : 0;
  console.log(`HOT success rate: ${hotSuccessRate.toFixed(2)}%`);
  if (hot.rateLimited > 0) {
    console.log(`HOT run saw heavy rate limiting (${hot.rateLimited}x 429). Compare runs by success rate + effective throughput.`);
  }

  if (hot.fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error("❌ cache stress failed", e);
  process.exitCode = 1;
});
