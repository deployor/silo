/**
 * Heavy SigV4 robustness/fuzz test for Silo (S3-compatible endpoint).
 *
 * This project’s verifier in [`src/lib/auth-v4.ts`](src/lib/auth-v4.ts) uses defaults
 * of service="s3" and region="auto" (matching `aws4fetch`). The AWS SDK v3 presigner
 * defaults to regions like "us-east-1", which will produce signatures that your
 * verifier will reject if it expects "auto" in the credential scope.
 *
 * So this script uses `aws4fetch` for correctness vs your implementation.
 *
 * What it does:
 * - Uploads a small set of objects with tricky keys.
 * - Generates presigned GET URLs.
 * - Mutates query params to ensure server rejects invalid signatures.
 * - Verifies invariants:
 *    - control URL must allow (2xx)
 *    - reordered params must allow (2xx)
 *    - tampering must deny (400/401/403)
 * - Runs concurrently with a worker pool.
 *
 * Run:
 *   npx tsx ./scripts/test-sigv4-fuzz.ts
 *
 * Env (required):
 *   SIGV4_ENDPOINT=https://silo.deployor.dev
 *   SIGV4_ACCESS_KEY=...
 *   SIGV4_SECRET_KEY=...
 *   SIGV4_BUCKET=testprivbucket
 *
 * Env (optional):
 *   SIGV4_REGION=auto
 *   SIGV4_EXPIRES=900   (not used by aws4fetch; left for compatibility)
 *   SIGV4_ITERATIONS=1000
 *   SIGV4_CONCURRENCY=30
 *   SIGV4_TIMEOUT_MS=15000
 *   SIGV4_VERBOSE=0
 */

import { randomBytes } from "node:crypto";

import { AwsClient } from "aws4fetch";

type Env = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  expires: number;
  iterations: number;
  concurrency: number;
  timeoutMs: number;
  verbose: boolean;
};

function getEnv(): Env {
  const endpoint = process.env.SIGV4_ENDPOINT;
  const accessKeyId = process.env.SIGV4_ACCESS_KEY;
  const secretAccessKey = process.env.SIGV4_SECRET_KEY;
  const bucket = process.env.SIGV4_BUCKET;

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      [
        "Missing required env.",
        "Set: SIGV4_ENDPOINT, SIGV4_ACCESS_KEY, SIGV4_SECRET_KEY, SIGV4_BUCKET",
      ].join("\n"),
    );
  }

  const region = process.env.SIGV4_REGION ?? "auto";
  const expires = Number(process.env.SIGV4_EXPIRES ?? "900");
  const iterations = Number(process.env.SIGV4_ITERATIONS ?? "1000");
  const concurrency = Number(process.env.SIGV4_CONCURRENCY ?? "30");
  const timeoutMs = Number(process.env.SIGV4_TIMEOUT_MS ?? "15000");
  const verbose = (process.env.SIGV4_VERBOSE ?? "0") === "1";

  if (!Number.isFinite(expires) || expires <= 0) throw new Error("SIGV4_EXPIRES invalid");
  if (!Number.isFinite(iterations) || iterations <= 0) throw new Error("SIGV4_ITERATIONS invalid");
  if (!Number.isFinite(concurrency) || concurrency <= 0) throw new Error("SIGV4_CONCURRENCY invalid");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("SIGV4_TIMEOUT_MS invalid");

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region,
    expires,
    iterations,
    concurrency,
    timeoutMs,
    verbose,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function rndId(bytes = 8) {
  return randomBytes(bytes).toString("hex");
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: ac.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function parseQuery(u: URL): Array<[string, string]> {
  // Preserve duplicates by parsing raw search.
  const raw = u.search.startsWith("?") ? u.search.slice(1) : u.search;
  if (!raw) return [];
  return raw.split("&").map((kv) => {
    const idx = kv.indexOf("=");
    if (idx === -1) return [decodeURIComponent(kv), ""];
    return [decodeURIComponent(kv.slice(0, idx)), decodeURIComponent(kv.slice(idx + 1))];
  });
}

function setRawQuery(u: URL, pairs: Array<[string, string]>) {
  // Re-encode in a stable way. (Not necessarily AWS canonical encoding; this is only
  // used for test mutations and control cases.)
  // Query mutation encoding: keep %20 (AWS canonical query encoding uses %20, not '+').
  const enc = (s: string) => encodeURIComponent(s);
  const q = pairs
    .map(([k, v]) => (v === "" ? enc(k) : `${enc(k)}=${enc(v)}`))
    .join("&");
  u.search = q ? `?${q}` : "";
}

function escapeKeyForPath(key: string) {
  // IMPORTANT:
  // - For S3 path-style requests, the path must use percent-encoding for *all*
  //   non-unreserved chars *including spaces as %20*.
  // - Do NOT convert %20 -> + in the *path* ("+" is only a thing in query encoding).
  // - Keep "/" as a path separator so keys with slashes work.
  return encodeURIComponent(key).replace(/%2F/g, "/");
}

function withKeyVariants(baseKey: string): string[] {
  return [
    baseKey,
    `${baseKey}-space key`,
    `${baseKey}-unicode-Łódź`,
    `${baseKey}-slashes/a//b///c`,
    `${baseKey}-percent-%25-%2F`,
    `${baseKey}-plus+sign`,
    `${baseKey}-dot./..../x`,
  ];
}

type MutationResult = {
  name: string;
  url: string;
  expect: "allow" | "deny";
  reason: string;
};

function mutatePresignedUrl(original: string): MutationResult[] {
  const mutations: MutationResult[] = [];
  const qp0 = parseQuery(new URL(original));
  const hasSig = qp0.some(([k]) => k === "X-Amz-Signature");
  if (!hasSig) {
    mutations.push({
      name: "no-signature-present",
      url: original,
      expect: "deny",
      reason: "URL missing X-Amz-Signature",
    });
    return mutations;
  }

  // Control: should be allowed.
  mutations.push({
    name: "control",
    url: original,
    expect: "allow",
    reason: "Original presigned URL should succeed",
  });

  // Add arbitrary query param (should invalidate signature if included in canonical query).
  {
    const u = new URL(original);
    const p = parseQuery(u);
    p.push(["x-test", rndId(4)]);
    setRawQuery(u, p);
    mutations.push({
      name: "add-extra-param",
      url: u.toString(),
      expect: "deny",
      reason: "Added query param must break signature",
    });
  }

  // Reorder query params (should still allow; canonical query sorts).
  {
    const u = new URL(original);
    const p = shuffle(parseQuery(u));
    setRawQuery(u, p);
    mutations.push({
      name: "reorder-params",
      url: u.toString(),
      expect: "allow",
      reason: "Query param order must not matter",
    });
  }

  // Duplicate a signed parameter (should deny).
  {
    const u = new URL(original);
    const p = parseQuery(u);
    const candidates = p.filter(([k]) => k.startsWith("X-Amz-") && k !== "X-Amz-Signature");
    if (candidates.length) {
      const toDup = pick(candidates);
      p.push([toDup[0], toDup[1]]);
      setRawQuery(u, p);
      mutations.push({
        name: "duplicate-signed-param",
        url: u.toString(),
        expect: "deny",
        reason: "Duplicate params can change canonical query; should be rejected",
      });
    }
  }

  // Tamper with signature (flip one char)
  {
    const u = new URL(original);
    const p = parseQuery(u).map(([k, v]) => {
      if (k !== "X-Amz-Signature") return [k, v] as [string, string];
      if (!v) return [k, v] as [string, string];
      const i = Math.min(5, v.length - 1);
      const flip = v[i] === "a" ? "b" : "a";
      return [k, v.slice(0, i) + flip + v.slice(i + 1)] as [string, string];
    });
    setRawQuery(u, p);
    mutations.push({
      name: "tamper-signature",
      url: u.toString(),
      expect: "deny",
      reason: "Signature mismatch must be rejected",
    });
  }

  // Tamper with X-Amz-Date
  {
    const u = new URL(original);
    const p = parseQuery(u).map(([k, v]) => {
      if (k !== "X-Amz-Date") return [k, v] as [string, string];
      return [k, v.replace(/Z$/, "X")] as [string, string];
    });
    setRawQuery(u, p);
    mutations.push({
      name: "tamper-date",
      url: u.toString(),
      expect: "deny",
      reason: "Date tamper must be rejected",
    });
  }

  // Tamper with X-Amz-Expires (increase)
  {
    const u = new URL(original);
    const p = parseQuery(u).map(([k, v]) => {
      if (k !== "X-Amz-Expires") return [k, v] as [string, string];
      const n = Number(v);
      return [k, String(Number.isFinite(n) ? n + 1 : 9999)] as [string, string];
    });
    setRawQuery(u, p);
    mutations.push({
      name: "tamper-expires",
      url: u.toString(),
      expect: "deny",
      reason: "Expires tamper must be rejected",
    });
  }

  // Tamper with credential scope (region)
  {
    const u = new URL(original);
    const p = parseQuery(u).map(([k, v]) => {
      if (k !== "X-Amz-Credential") return [k, v] as [string, string];
      const parts = v.split("/");
      // <accessKey>/<date>/<region>/<service>/<request>
      if (parts.length >= 5) {
        parts[2] = parts[2] === "auto" ? "us-east-1" : "auto";
      }
      return [k, parts.join("/")] as [string, string];
    });
    setRawQuery(u, p);
    mutations.push({
      name: "tamper-credential-scope",
      url: u.toString(),
      expect: "deny",
      reason: "Credential scope tamper must be rejected",
    });
  }

  // Change host (should deny)
  {
    const u = new URL(original);
    u.host = "example.com";
    mutations.push({
      name: "wrong-host",
      url: u.toString(),
      expect: "deny",
      reason: "Host is in canonical request; must be rejected",
    });
  }

  return mutations;
}

type Stats = {
  allowOk: number;
  allowFail: number;
  denyOk: number;
  denyFail: number;
  timeouts: number;
  netErrors: number;
  unexpectedStatus: Map<number, number>;
};

function newStats(): Stats {
  return {
    allowOk: 0,
    allowFail: 0,
    denyOk: 0,
    denyFail: 0,
    timeouts: 0,
    netErrors: 0,
    unexpectedStatus: new Map(),
  };
}

function statusBucket(stats: Stats, status: number) {
  stats.unexpectedStatus.set(status, (stats.unexpectedStatus.get(status) ?? 0) + 1);
}

async function main() {
  const env = getEnv();

  const aws = new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    service: "s3",
    region: env.region,
  });

  const runId = `sigv4-fuzz-${nowIso().replace(/[:.]/g, "-")}-${rndId(4)}`;
  const baseKey = `${runId}/object`;

  // Upload a small set of objects to fetch.
  const keys = withKeyVariants(baseKey);
  for (const key of keys) {
    const putUrl = `${env.endpoint}/${env.bucket}/${escapeKeyForPath(key)}`;
    const signedPut = await aws.sign(putUrl, { method: "PUT" });

    const putRes = await fetchWithTimeout(
      signedPut.url,
      {
        method: "PUT",
        headers: signedPut.headers,
        body: `hello:${key}:${runId}`,
      },
      env.timeoutMs,
    );

    if (!putRes.ok) {
      const text = await putRes.text().catch(() => "");
      throw new Error(`PUT failed for key=${JSON.stringify(key)} status=${putRes.status}\n${text}`);
    }
  }

  const stats = newStats();
  const start = Date.now();

  let idx = 0;
  async function worker(workerId: number) {
    while (true) {
      const my = idx++;
      if (my >= env.iterations) return;

      const key = pick(keys);
      const urlToSign = `${env.endpoint}/${env.bucket}/${escapeKeyForPath(key)}`;

      const signedReq = await aws.sign(urlToSign, {
        method: "GET",
        aws: {
          signQuery: true,
        },
      });
      const signed = signedReq.url;

      const tests = mutatePresignedUrl(signed);

      for (const t of tests) {
        try {
          const res = await fetchWithTimeout(
            t.url,
            {
              method: "GET",
            },
            env.timeoutMs,
          );

          const okAllow = t.expect === "allow" && res.status >= 200 && res.status < 300;
          const okDeny =
            t.expect === "deny" && (res.status === 403 || res.status === 400 || res.status === 401);

          if (okAllow) stats.allowOk++;
          else if (t.expect === "allow") {
            stats.allowFail++;
            statusBucket(stats, res.status);
            if (env.verbose) {
              const text = await res.text().catch(() => "");
              console.error(
                `[ALLOW-FAIL] worker=${workerId} iter=${my} key=${JSON.stringify(key)} test=${t.name} status=${res.status} url=${t.url}\n${text}`,
              );
            }
          } else if (okDeny) stats.denyOk++;
          else {
            stats.denyFail++;
            statusBucket(stats, res.status);
            if (env.verbose) {
              const text = await res.text().catch(() => "");
              console.error(
                `[DENY-FAIL] worker=${workerId} iter=${my} key=${JSON.stringify(key)} test=${t.name} status=${res.status} url=${t.url}\n${text}`,
              );
            }
          }
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (msg.includes("timeout")) stats.timeouts++;
          else stats.netErrors++;
          if (env.verbose) {
            console.error(`[FETCH-ERROR] worker=${workerId} iter=${my} test=${t.name} ${msg}`);
          }
          await sleep(25);
        }
      }
    }
  }

  const workers = Array.from({ length: env.concurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  const ms = Date.now() - start;

  const sanityUrlToSign = `${env.endpoint}/${env.bucket}/${escapeKeyForPath(keys[0]!)}`;
  const sanitySigned = await aws.sign(sanityUrlToSign, {
    method: "GET",
    aws: {
      signQuery: true,
    },
  });
  const totalCasesPerIter = mutatePresignedUrl(sanitySigned.url).length;

  function pct(n: number, d: number) {
    if (!d) return "0%";
    return `${((n * 100) / d).toFixed(2)}%`;
  }

  const allowTotal = stats.allowOk + stats.allowFail;
  const denyTotal = stats.denyOk + stats.denyFail;

  console.log("\nSigV4 fuzz test complete");
  console.log(`endpoint:   ${env.endpoint}`);
  console.log(`bucket:     ${env.bucket}`);
  console.log(`iterations: ${env.iterations}  (cases/iter: ${totalCasesPerIter})`);
  console.log(`concurrency:${env.concurrency}`);
  console.log(`duration:   ${(ms / 1000).toFixed(2)}s`);
  console.log("\nALLOW cases (should be 2xx)");
  console.log(`  ok:   ${stats.allowOk}`);
  console.log(`  fail: ${stats.allowFail} (${pct(stats.allowFail, allowTotal)})`);
  console.log("DENY cases (should be 400/401/403)");
  console.log(`  ok:   ${stats.denyOk}`);
  console.log(`  fail: ${stats.denyFail} (${pct(stats.denyFail, denyTotal)})`);
  console.log("\nerrors");
  console.log(`  timeouts:  ${stats.timeouts}`);
  console.log(`  netErrors: ${stats.netErrors}`);

  if (stats.unexpectedStatus.size) {
    const sorted = [...stats.unexpectedStatus.entries()].sort((a, b) => b[1] - a[1]);
    console.log("\nunexpected statuses (from fails)");
    for (const [st, count] of sorted) console.log(`  ${st}: ${count}`);
  }

  if (stats.allowFail > 0 || stats.denyFail > 0) {
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
