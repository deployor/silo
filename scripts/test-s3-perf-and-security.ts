/**
 * S3 performance + security regression tests.
 *
 * Goals:
 * 1) Throughput / latency benchmarks for PUT + GET + LIST.
 * 2) Security abuse probes around path traversal + canonicalization
 *    + query duplicates + header oddities.
 *
 * This script is intentionally self-contained and does NOT import src/config
 * (so it can run without DATABASE_URL/etc).
 *
 * Run:
 *   npx tsx ./scripts/test-s3-perf-and-security.ts
 *
 * Required env:
 *   S3_ENDPOINT=https://silo.deployor.dev
 *   S3_BUCKET=testprivbucket
 *   S3_ACCESS_KEY_ID=...
 *   S3_SECRET_ACCESS_KEY=...
 *
 * Optional env:
 *   S3_REGION=auto
 *   PERF_CONCURRENCY=20
 *   PERF_ITERATIONS=200
 *   PERF_SIZES=1024,1048576,10485760
 *   PERF_LIST_PREFIX=perf
 *   TIMEOUT_MS=20000
 *   VERBOSE=0
 */

import { randomBytes } from "node:crypto";
import { AwsClient } from "aws4fetch";

type Env = {
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	perfConcurrency: number;
	perfIterations: number;
	perfSizes: number[];
	perfListPrefix: string;
	timeoutMs: number;
	verbose: boolean;
};

function must(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing env: ${name}`);
	return v;
}

function parseCsvNumbers(s: string): number[] {
	return s
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean)
		.map((x) => Number(x))
		.filter((n) => Number.isFinite(n) && n > 0);
}

function env(): Env {
	const endpoint = must("S3_ENDPOINT");
	const bucket = must("S3_BUCKET");
	const accessKeyId = must("S3_ACCESS_KEY_ID");
	const secretAccessKey = must("S3_SECRET_ACCESS_KEY");

	const region = process.env.S3_REGION ?? "auto";
	const perfConcurrency = Number(process.env.PERF_CONCURRENCY ?? "20");
	const perfIterations = Number(process.env.PERF_ITERATIONS ?? "200");
	const perfSizes =
		parseCsvNumbers(process.env.PERF_SIZES ?? "1024,1048576,10485760") || [];
	const perfListPrefix = process.env.PERF_LIST_PREFIX ?? "perf";
	const timeoutMs = Number(process.env.TIMEOUT_MS ?? "20000");
	const verbose = (process.env.VERBOSE ?? "0") === "1";

	if (!Number.isFinite(perfConcurrency) || perfConcurrency <= 0)
		throw new Error("PERF_CONCURRENCY invalid");
	if (!Number.isFinite(perfIterations) || perfIterations <= 0)
		throw new Error("PERF_ITERATIONS invalid");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new Error("TIMEOUT_MS invalid");
	if (!perfSizes.length) throw new Error("PERF_SIZES invalid/empty");

	return {
		endpoint,
		bucket,
		accessKeyId,
		secretAccessKey,
		region,
		perfConcurrency,
		perfIterations,
		perfSizes,
		perfListPrefix,
		timeoutMs,
		verbose,
	};
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

function nowId() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function escapeKeyForPath(key: string) {
	// Encode for path-style S3, keep slashes.
	return encodeURIComponent(key).replace(/%2F/g, "/");
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
) {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: ac.signal });
	} finally {
		clearTimeout(t);
	}
}

type Lat = {
	n: number;
	sumMs: number;
	minMs: number;
	maxMs: number;
	ok: number;
	fail: number;
	statusCounts: Map<number, number>;
};

function newLat(): Lat {
	return {
		n: 0,
		sumMs: 0,
		minMs: Infinity,
		maxMs: 0,
		ok: 0,
		fail: 0,
		statusCounts: new Map(),
	};
}

function addLat(lat: Lat, ms: number, ok: boolean, status: number) {
	lat.n++;
	lat.sumMs += ms;
	lat.minMs = Math.min(lat.minMs, ms);
	lat.maxMs = Math.max(lat.maxMs, ms);
	if (ok) lat.ok++;
	else lat.fail++;
	lat.statusCounts.set(status, (lat.statusCounts.get(status) ?? 0) + 1);
}

function p50(values: number[]) {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.floor(s.length * 0.5)]!;
}
function p95(values: number[]) {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.floor(s.length * 0.95)]!;
}

async function perfPutGet(
	aws: AwsClient,
	cfg: Env,
	runPrefix: string,
	size: number,
) {
	const body = randomBytes(size);
	const contentLength = body.byteLength;
	const key = `${runPrefix}/obj-${size}.bin`;
	const putUrl = `${cfg.endpoint}/${cfg.bucket}/${escapeKeyForPath(key)}`;

	// PUT once to be sure object exists.
	// Under heavy load, this can hit rate limits; retry with backoff.
	let putOnceStatus: number | undefined;
	let putOnceBody = "";
	for (let attempt = 0; attempt < 6; attempt++) {
		const signedPut = await aws.sign(putUrl, { method: "PUT" });
		const h = new Headers(signedPut.headers);
		h.set("Content-Length", String(contentLength));
		const putOnce = await fetchWithTimeout(
			signedPut.url,
			{ method: "PUT", headers: h, body },
			cfg.timeoutMs,
		);
		putOnceStatus = putOnce.status;
		if (putOnce.ok) break;

		putOnceBody = await putOnce.text().catch(() => "");
		if (putOnce.status !== 429) break;

		const backoffMs = 250 * 2 ** attempt;
		await sleep(backoffMs);
	}

	if (!(putOnceStatus && putOnceStatus >= 200 && putOnceStatus < 300)) {
		throw new Error(
			`seed PUT failed size=${size} status=${putOnceStatus} body=${putOnceBody}`,
		);
	}

	const putLat = newLat();
	const getLat = newLat();
	const putSamples: number[] = [];
	const getSamples: number[] = [];

	let idx = 0;
	async function worker(workerId: number) {
		while (true) {
			const i = idx++;
			if (i >= cfg.perfIterations) return;

			// Round-robin: half PUTs, half GETs.
			const doPut = i % 2 === 0;
			if (doPut) {
				const k = `${runPrefix}/w${workerId}/put-${size}-${i}.bin`;
				const u = `${cfg.endpoint}/${cfg.bucket}/${escapeKeyForPath(k)}`;
				const s = await aws.sign(u, { method: "PUT" });
				const h = new Headers(s.headers);
				h.set("Content-Length", String(contentLength));
				const t0 = performance.now();
				const res = await fetchWithTimeout(
					s.url,
					{ method: "PUT", headers: h, body },
					cfg.timeoutMs,
				);
				const ms = performance.now() - t0;
				const ok = res.status >= 200 && res.status < 300;
				if (cfg.verbose && !ok) {
					console.error(
						`[PUT FAIL] status=${res.status} body=${await res.text().catch(() => "")}`,
					);
				}
				addLat(putLat, ms, ok, res.status);
				putSamples.push(ms);
			} else {
				// presigned GET (query)
				const s = await aws.sign(putUrl, {
					method: "GET",
					aws: { signQuery: true },
				});
				const t0 = performance.now();
				const res = await fetchWithTimeout(
					s.url,
					{ method: "GET" },
					cfg.timeoutMs,
				);
				const ms = performance.now() - t0;
				const ok = res.status >= 200 && res.status < 300;
				if (cfg.verbose && !ok) {
					console.error(
						`[GET FAIL] status=${res.status} body=${await res.text().catch(() => "")}`,
					);
				}
				addLat(getLat, ms, ok, res.status);
				getSamples.push(ms);
				// Drain body so connection reuse behaves.
				await res.arrayBuffer().catch(() => null);
			}
		}
	}

	const t0 = performance.now();
	await Promise.all(
		Array.from({ length: cfg.perfConcurrency }, (_, w) => worker(w)),
	);
	const wallMs = performance.now() - t0;

	const totalOps = putLat.n + getLat.n;
	const opsPerSec = totalOps / (wallMs / 1000);

	return {
		size,
		key,
		wallMs,
		totalOps,
		opsPerSec,
		putLat,
		getLat,
		putP50: p50(putSamples),
		putP95: p95(putSamples),
		getP50: p50(getSamples),
		getP95: p95(getSamples),
	};
}

async function perfList(aws: AwsClient, cfg: Env, runPrefix: string) {
	// List is signed header auth (not presigned) so we can add params.
	const prefix = `${cfg.perfListPrefix}/${runPrefix}`;
	const query = new URLSearchParams();
	query.set("list-type", "2");
	query.set("prefix", prefix);
	query.set("max-keys", "1000");

	const listUrl = `${cfg.endpoint}/${cfg.bucket}?${query.toString()}`;

	// Seed a handful of objects.
	// Under high concurrency runs, seeding can hit rate limits; retry with backoff.
	for (let i = 0; i < 20; i++) {
		const k = `${prefix}/seed-${i}.txt`;
		const u = `${cfg.endpoint}/${cfg.bucket}/${escapeKeyForPath(k)}`;

		let lastStatus: number | undefined;
		for (let attempt = 0; attempt < 6; attempt++) {
			const s = await aws.sign(u, { method: "PUT" });
			const res = await fetchWithTimeout(
				s.url,
				{ method: "PUT", headers: s.headers, body: `seed-${i}` },
				cfg.timeoutMs,
			);
			lastStatus = res.status;

			if (res.ok) break;
			if (res.status !== 429) {
				throw new Error(`seed list PUT failed status=${res.status}`);
			}

			await res.text().catch(() => "");
			const backoffMs = 250 * 2 ** attempt;
			await sleep(backoffMs);
		}

		if (lastStatus === 429) {
			throw new Error(
				`seed list PUT failed status=429 (throttled after retries)`,
			);
		}
	}

	const lat = newLat();
	const samples: number[] = [];

	for (let i = 0; i < 50; i++) {
		const s = await aws.sign(listUrl, { method: "GET" });
		const t0 = performance.now();
		const res = await fetchWithTimeout(
			s.url,
			{ method: "GET", headers: s.headers },
			cfg.timeoutMs,
		);
		const ms = performance.now() - t0;
		const ok = res.status >= 200 && res.status < 300;
		addLat(lat, ms, ok, res.status);
		samples.push(ms);
		await res.text().catch(() => "");
		if (!ok && cfg.verbose) {
			console.error(`[LIST FAIL] status=${res.status}`);
		}
	}

	return {
		prefix,
		lat,
		p50: p50(samples),
		p95: p95(samples),
	};
}

async function securityProbes(aws: AwsClient, cfg: Env, runPrefix: string) {
	const results: Array<{
		name: string;
		ok: boolean;
		status?: number;
		note: string;
	}> = [];

	// 1) Path traversal attempts (should not allow, ideally 400/403)
	// NOTE:
	// - Raw "../" is normalized by URL parsers.
	// - Also, some stacks normalize a dot-segment *even when it originated from percent-encoding*.
	//   Example: "%2e%2e/" is often treated as "../" and removed, yielding a different pathname.
	//   If you see 200 for "%2e%2e/", it may mean the proxy/router normalized it *before* your app.
	// We keep the variants that actually reach the app intact.
	const traversalKeys = [
		`${runPrefix}/..%2Fevil.txt`,
		`${runPrefix}/%2e%2e%2fevil.txt`,
		`..%2F..%2Fetc%2Fpasswd`,
	];

	for (const key of traversalKeys) {
		// IMPORTANT:
		// - We want to send the path *exactly* as written (including %2e%2e, %2f, etc)
		// - Using `new URL()` or any encoding helpers can normalize/escape and change what the server receives.
		// So we build a literal URL string and do NOT re-parse it.
		const u = `${cfg.endpoint}/${cfg.bucket}/${key}`;

		const s = await aws.sign(u, { method: "PUT" });
		const res = await fetchWithTimeout(
			s.url,
			{ method: "PUT", headers: s.headers, body: "x" },
			cfg.timeoutMs,
		);
		const ok = res.status === 400 || res.status === 403;
		results.push({
			name: `path-traversal-put:${key}`,
			ok,
			status: res.status,
			note: ok ? "blocked" : `unexpected status ${res.status}`,
		});
		await res.text().catch(() => "");
	}

	// 2) Duplicate query params in presigned GET.
	//    We expect deny (400/401/403/404/429) but NOT 2xx.
	{
		const key = `${runPrefix}/dup-query.txt`;
		const putUrl = `${cfg.endpoint}/${cfg.bucket}/${escapeKeyForPath(key)}`;
		const signedPut = await aws.sign(putUrl, { method: "PUT" });
		const putRes = await fetchWithTimeout(
			signedPut.url,
			{ method: "PUT", headers: signedPut.headers, body: "dup" },
			cfg.timeoutMs,
		);
		if (!putRes.ok)
			throw new Error(`seed dup-query PUT failed status=${putRes.status}`);

		const signedGet = await aws.sign(putUrl, {
			method: "GET",
			aws: { signQuery: true },
		});
		const url = new URL(signedGet.url);
		// Add duplicate X-Amz-Date.
		url.search += `&X-Amz-Date=${encodeURIComponent(url.searchParams.get("X-Amz-Date") ?? "")}`;

		const res = await fetchWithTimeout(
			url.toString(),
			{ method: "GET" },
			cfg.timeoutMs,
		);
		const ok = !(res.status >= 200 && res.status < 300);
		results.push({
			name: "presigned-dup-query",
			ok,
			status: res.status,
			note: ok ? "not-2xx" : "unexpected 2xx for dup query",
		});
		await res.text().catch(() => "");
	}

	// 3) Header smuggling-ish: duplicate headers are hard in fetch, but we can try weird whitespace.
	{
		const key = `${runPrefix}/header-ws.txt`;
		const putUrl = `${cfg.endpoint}/${cfg.bucket}/${escapeKeyForPath(key)}`;
		const s = await aws.sign(putUrl, { method: "PUT" });
		const h = new Headers(s.headers);
		// Add weird whitespace around date header value (should still verify if canonicalization normalizes) OR be rejected.
		const date = h.get("x-amz-date") ?? "";
		h.set("x-amz-date", `  ${date}   `);

		const res = await fetchWithTimeout(
			putUrl,
			{ method: "PUT", headers: h, body: "ws" },
			cfg.timeoutMs,
		);
		// Either reject (403) or accept (2xx). But MUST NOT be 500.
		const ok = res.status !== 500;
		results.push({
			name: "header-whitespace-x-amz-date",
			ok,
			status: res.status,
			note: ok ? "not-500" : "server error",
		});
		await res.text().catch(() => "");
	}

	return results;
}

async function main() {
	const cfg = env();

	const aws = new AwsClient({
		accessKeyId: cfg.accessKeyId,
		secretAccessKey: cfg.secretAccessKey,
		service: "s3",
		region: cfg.region,
	});

	const runPrefix = `perfsec-${nowId()}-${randomBytes(3).toString("hex")}`;

	console.log("\n== Performance tests ==");
	for (const size of cfg.perfSizes) {
		const r = await perfPutGet(aws, cfg, runPrefix, size);
		console.log("\nPUT+GET size:", size);
		console.log(
			`ops: ${r.totalOps}  wall: ${(r.wallMs / 1000).toFixed(2)}s  ops/s: ${r.opsPerSec.toFixed(2)}`,
		);
		console.log(
			`PUT ok/fail: ${r.putLat.ok}/${r.putLat.fail}  p50=${r.putP50.toFixed(1)}ms  p95=${r.putP95.toFixed(1)}ms`,
		);
		console.log(
			`GET ok/fail: ${r.getLat.ok}/${r.getLat.fail}  p50=${r.getP50.toFixed(1)}ms  p95=${r.getP95.toFixed(1)}ms`,
		);
	}

	const list = await perfList(aws, cfg, runPrefix);
	console.log(
		"\nLIST p50/p95:",
		list.p50.toFixed(1),
		"/",
		list.p95.toFixed(1),
		"ms",
		"prefix:",
		list.prefix,
	);

	console.log("\n== Security probes ==");
	const sec = await securityProbes(aws, cfg, runPrefix);
	const failed = sec.filter((x) => !x.ok);
	for (const r of sec) {
		console.log(
			`${r.ok ? "OK" : "FAIL"}  ${r.name}  status=${r.status ?? "?"}  ${r.note}`,
		);
	}

	if (failed.length) {
		process.exitCode = 2;
	}
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
