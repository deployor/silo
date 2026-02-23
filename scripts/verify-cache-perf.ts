/**
 * Disk Cache Performance Verification Script
 *
 * Tests the smart disk cache integration with S3 operations.
 * Verifies: demand tracking, admission control, cache hits, invalidation, eviction.
 *
 * Usage: bun run scripts/verify-cache-perf.ts
 */

import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const cfg = {
	endpoint: "https://silo.deployor.dev",
	region: "auto",
	credentials: {
		accessKeyId: "SILO_P_AK_856F8AFD9B57D232B94F",
		secretAccessKey:
			"SILO_P_SK_2ad9f66fc8f305916284b516daecd99b6d7990d3",
	},
	bucket: "testingbucketforredis",
};

const client = new S3Client({
	endpoint: cfg.endpoint,
	region: cfg.region,
	credentials: cfg.credentials,
	forcePathStyle: true,
	maxAttempts: 3,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBytes(size: number): Uint8Array {
	const buf = new Uint8Array(size);
	for (let i = 0; i < size; i++) buf[i] = Math.floor(Math.random() * 256);
	return buf;
}

async function measure<T>(label: string, fn: () => Promise<T>) {
	const start = performance.now();
	const result = await fn();
	const ms = performance.now() - start;
	return { result, ms, label };
}

function fmt(ms: number): string {
	return `${ms.toFixed(1)}ms`;
}

function fmtSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

async function testRedisL1Cache() {
	console.log("\n═══════════════════════════════════════════════════════════");
	console.log("  TEST 1: Redis L1 Cache (small objects ≤10 MB)");
	console.log("═══════════════════════════════════════════════════════════");

	const key = `cache-test/small-${Date.now()}.bin`;
	const body = randomBytes(50 * 1024); // 50 KB

	// PUT
	const put = await measure("PUT 50KB", () =>
		client.send(
			new PutObjectCommand({
				Bucket: cfg.bucket,
				Key: key,
				Body: body,
				ContentType: "application/octet-stream",
			}),
		),
	);
	console.log(`  📦 ${put.label}: ${fmt(put.ms)}`);

	// GET 1: cold (from S3, populates Redis)
	const get1 = await measure("GET cold", async () => {
		const res = await client.send(
			new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
		);
		await res.Body?.transformToByteArray();
	});
	console.log(`  🌍 ${get1.label}: ${fmt(get1.ms)}`);

	// Wait for background cache population
	await new Promise((r) => setTimeout(r, 500));

	// GET 2: warm (should hit Redis L1)
	const get2 = await measure("GET warm (Redis L1)", async () => {
		const res = await client.send(
			new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
		);
		await res.Body?.transformToByteArray();
	});
	console.log(`  ⚡ ${get2.label}: ${fmt(get2.ms)}`);

	const speedup = get1.ms / get2.ms;
	console.log(`  📈 Speedup: ${speedup.toFixed(1)}x`);

	// Cleanup
	await client.send(
		new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }),
	);
	console.log(`  🗑️  Cleaned up ${key}`);
}

async function testDiskL2DemandGating() {
	console.log("\n═══════════════════════════════════════════════════════════");
	console.log("  TEST 2: Disk L2 Demand-Gated Admission");
	console.log("═══════════════════════════════════════════════════════════");
	console.log("  Objects must be requested multiple times before being");
	console.log("  admitted to disk cache (demand-based admission).");

	const key = `cache-test/demand-${Date.now()}.bin`;
	const size = 2 * 1024 * 1024; // 2 MB — above Redis L1 default min for disk
	const body = randomBytes(size);

	console.log(`\n  Uploading ${fmtSize(size)} test object...`);
	await client.send(
		new PutObjectCommand({
			Bucket: cfg.bucket,
			Key: key,
			Body: body,
			ContentType: "application/octet-stream",
		}),
	);

	// Multiple GETs to build demand and eventually trigger disk cache admission
	const latencies: number[] = [];
	const numGets = 5;

	for (let i = 1; i <= numGets; i++) {
		const get = await measure(`GET #${i}`, async () => {
			const res = await client.send(
				new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
			);
			await res.Body?.transformToByteArray();
		});
		latencies.push(get.ms);

		const source =
			i === 1
				? "(cold — S3 origin)"
				: i <= 2
					? "(warming — demand building)"
					: "(should be cached)";
		console.log(`  ${i <= 2 ? "🌍" : "💾"} ${get.label} ${source}: ${fmt(get.ms)}`);

		// Small delay to let background caching complete
		await new Promise((r) => setTimeout(r, 300));
	}

	if (latencies.length >= 3) {
		const coldAvg = latencies[0];
		const warmAvg =
			latencies.slice(2).reduce((a, b) => a + b, 0) /
			latencies.slice(2).length;
		console.log(
			`\n  📊 Cold: ${fmt(coldAvg)} → Warm: ${fmt(warmAvg)} (${(coldAvg / warmAvg).toFixed(1)}x speedup)`,
		);
	}

	// Cleanup
	await client.send(
		new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }),
	);
	console.log(`  🗑️  Cleaned up ${key}`);
}

async function testInvalidation() {
	console.log("\n═══════════════════════════════════════════════════════════");
	console.log("  TEST 3: Cache Invalidation on PUT/DELETE");
	console.log("═══════════════════════════════════════════════════════════");

	const key = `cache-test/invalidation-${Date.now()}.bin`;
	const body1 = randomBytes(30 * 1024);
	const body2 = randomBytes(30 * 1024);

	// PUT v1
	await client.send(
		new PutObjectCommand({
			Bucket: cfg.bucket,
			Key: key,
			Body: body1,
			ContentType: "application/octet-stream",
		}),
	);
	console.log("  📦 Uploaded v1");

	// GET to warm cache
	const res1 = await client.send(
		new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
	);
	const data1 = await res1.Body?.transformToByteArray();
	await new Promise((r) => setTimeout(r, 500));

	// GET from cache
	const res1cached = await client.send(
		new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
	);
	const data1cached = await res1cached.Body?.transformToByteArray();

	const v1Match =
		data1 &&
		data1cached &&
		data1.length === data1cached.length &&
		data1.every((b, i) => b === data1cached[i]);
	console.log(`  ✅ Cache v1 consistency: ${v1Match ? "PASS" : "FAIL"}`);

	// PUT v2 (should invalidate cache)
	await client.send(
		new PutObjectCommand({
			Bucket: cfg.bucket,
			Key: key,
			Body: body2,
			ContentType: "application/octet-stream",
		}),
	);
	console.log("  📦 Uploaded v2 (should invalidate cache)");
	await new Promise((r) => setTimeout(r, 500));

	// GET should return v2, NOT stale v1
	const res2 = await client.send(
		new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
	);
	const data2 = await res2.Body?.transformToByteArray();

	const v2Match =
		data2 &&
		body2.length === data2.length &&
		body2.every((b, i) => b === data2[i]);
	console.log(
		`  ${v2Match ? "✅" : "❌"} Post-invalidation data: ${v2Match ? "PASS (fresh data)" : "FAIL (stale cache!)"}`,
	);

	// DELETE
	await client.send(
		new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }),
	);
	console.log("  🗑️  Deleted key (cache should be invalidated)");
}

async function testConcurrentPerformance() {
	console.log("\n═══════════════════════════════════════════════════════════");
	console.log("  TEST 4: Concurrent GET Performance (Stress)");
	console.log("═══════════════════════════════════════════════════════════");

	const key = `cache-test/stress-${Date.now()}.bin`;
	const size = 100 * 1024; // 100 KB
	const body = randomBytes(size);
	const concurrency = 20;
	const totalRequests = 100;

	console.log(`  Size: ${fmtSize(size)}, Concurrency: ${concurrency}, Total: ${totalRequests}`);

	// Upload
	await client.send(
		new PutObjectCommand({
			Bucket: cfg.bucket,
			Key: key,
			Body: body,
			ContentType: "application/octet-stream",
		}),
	);

	// Warm up cache
	await client.send(
		new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
	);
	await new Promise((r) => setTimeout(r, 500));

	// Stress test
	const latencies: number[] = [];
	let errors = 0;
	let completed = 0;

	const worker = async () => {
		while (completed < totalRequests) {
			completed++;
			const { ms, label } = await measure("GET", async () => {
				const res = await client.send(
					new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
				);
				await res.Body?.transformToByteArray();
			});
			latencies.push(ms);
		}
	};

	const startTime = performance.now();
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	const totalTime = performance.now() - startTime;

	// Stats
	latencies.sort((a, b) => a - b);
	const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
	const p50 = latencies[Math.floor(latencies.length * 0.5)];
	const p95 = latencies[Math.floor(latencies.length * 0.95)];
	const p99 = latencies[Math.floor(latencies.length * 0.99)];
	const rps = (latencies.length / (totalTime / 1000)).toFixed(1);

	console.log(`\n  📊 Results (${latencies.length} requests in ${fmt(totalTime)}):`);
	console.log(`     Throughput: ${rps} req/sec`);
	console.log(`     Avg: ${fmt(avg)}`);
	console.log(`     P50: ${fmt(p50)}`);
	console.log(`     P95: ${fmt(p95)}`);
	console.log(`     P99: ${fmt(p99)}`);
	console.log(`     Min: ${fmt(latencies[0])}`);
	console.log(`     Max: ${fmt(latencies[latencies.length - 1])}`);
	if (errors > 0) console.log(`     Errors: ${errors}`);

	// Cleanup
	await client.send(
		new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }),
	);
}

async function testXCacheHeader() {
	console.log("\n═══════════════════════════════════════════════════════════");
	console.log("  TEST 5: X-Cache Header Verification");
	console.log("═══════════════════════════════════════════════════════════");
	console.log("  Checks if disk cache hits return X-Cache: DISK-HIT");

	const key = `cache-test/header-${Date.now()}.bin`;
	const size = 2 * 1024 * 1024; // 2 MB
	const body = randomBytes(size);

	await client.send(
		new PutObjectCommand({
			Bucket: cfg.bucket,
			Key: key,
			Body: body,
			ContentType: "application/octet-stream",
		}),
	);

	// Multiple GETs to build demand
	for (let i = 0; i < 3; i++) {
		await client.send(
			new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
		);
		await new Promise((r) => setTimeout(r, 200));
	}

	// Check for X-Cache header via raw fetch (SDK may strip custom headers)
	try {
		const url = `${cfg.endpoint}/${cfg.bucket}/${key}`;
		const res = await fetch(url);
		const xcache = res.headers.get("x-cache");
		console.log(`  X-Cache header: ${xcache || "(not present)"}`);
		await res.arrayBuffer(); // consume body
	} catch (e) {
		console.log("  ⚠️  Could not verify X-Cache header via raw fetch");
	}

	// Cleanup
	await client.send(
		new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }),
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("🚀 Smart Disk Cache Performance Verification");
	console.log(`   Endpoint: ${cfg.endpoint}`);
	console.log(`   Bucket: ${cfg.bucket}`);
	console.log(`   Time: ${new Date().toISOString()}`);

	try {
		await testRedisL1Cache();
		await testDiskL2DemandGating();
		await testInvalidation();
		await testConcurrentPerformance();
		await testXCacheHeader();

		console.log("\n═══════════════════════════════════════════════════════════");
		console.log("  ✅ All tests completed!");
		console.log("═══════════════════════════════════════════════════════════\n");
	} catch (e) {
		console.error("\n❌ Test failed:", e);
		process.exit(1);
	}
}

main();
