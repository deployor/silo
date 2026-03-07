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
 *   HOT_REQUESTS=20000
 *   TIMEOUT_MS=25000
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
  timeoutMs: number;
};

type Stats = {
  ok: number;
  fail: number;
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
    hotRequests: num("HOT_REQUESTS", 20000),
    timeoutMs: num("TIMEOUT_MS", 25000),
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
  let bytes = 0;
  let idx = 0;

  const start = performance.now();

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= keys.length) return;
      const key = keys[i]!;
      const url = `${c.endpoint}/${c.bucket}/${keyPath(key)}`;
      const signed = await aws.sign(url, { method: "GET", aws: { signQuery: true } });
      const t0 = performance.now();
      const res = await fetchWithTimeout(signed.url, { method: "GET" }, c.timeoutMs);
      const ms = performance.now() - t0;
      samples.push(ms);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);

      if (res.ok) {
        ok++;
        const buf = await res.arrayBuffer();
        bytes += buf.byteLength;
      } else {
        fail++;
        await res.text().catch(() => "");
      }
    }
  }

  await Promise.all(Array.from({ length: c.coldConcurrency }, () => worker()));
  const wallMs = performance.now() - start;

  return {
    ok,
    fail,
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
  let bytes = 0;
  let idx = 0;

  const start = performance.now();

  async function worker(workerId: number) {
    while (true) {
      const i = idx++;
      if (i >= c.hotRequests) return;

      // Zipf-ish hotness: first ~20% keys are hit much more frequently.
      const r = Math.random();
      const hotBand = Math.max(1, Math.floor(keys.length * 0.2));
      const keyIndex = r < 0.8
        ? Math.floor(Math.random() * hotBand)
        : hotBand + Math.floor(Math.random() * Math.max(1, keys.length - hotBand));
      const key = keys[Math.min(keys.length - 1, keyIndex)]!;

      const url = `${c.endpoint}/${c.bucket}/${keyPath(key)}`;
      const signed = await aws.sign(url, { method: "GET", aws: { signQuery: true } });

      const t0 = performance.now();
      const res = await fetchWithTimeout(signed.url, { method: "GET" }, c.timeoutMs);
      const ms = performance.now() - t0;
      samples.push(ms);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);

      if (res.ok) {
        ok++;
        const buf = await res.arrayBuffer();
        bytes += buf.byteLength;
      } else {
        fail++;
        if (workerId === 0) await res.text().catch(() => "");
      }
    }
  }

  await Promise.all(Array.from({ length: c.hotConcurrency }, (_, w) => worker(w)));
  const wallMs = performance.now() - start;

  return {
    ok,
    fail,
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
  console.log(`latency ms: min=${s.min.toFixed(1)} p50=${s.p50.toFixed(1)} p95=${s.p95.toFixed(1)} max=${s.max.toFixed(1)}`);
  console.log(`throughput: ${s.rps.toFixed(2)} req/s`);
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
  console.log(`prefix=${prefix}`);

  const keys = await seedObjects(aws, c, prefix);
  console.log(`✅ Seeded ${keys.length} objects`);

  const cold = await coldPrime(aws, c, keys);
  printStats("COLD PRIMING", cold);

  const hot = await hotReadBlast(aws, c, keys);
  printStats("HOT CACHE BLAST", hot);

  const speedup = cold.p95 > 0 ? cold.p95 / Math.max(hot.p95, 0.0001) : 0;
  console.log(`\nEstimated hot-vs-cold p95 improvement: ${speedup.toFixed(2)}x`);

  if (hot.fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error("❌ cache stress failed", e);
  process.exitCode = 1;
});
