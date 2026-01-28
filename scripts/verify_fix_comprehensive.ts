import { XMLParser } from "fast-xml-parser";
import { s3Client } from "../src/lib/s3-client";

async function run() {
	console.log("Starting comprehensive verification...");

	// 1. Test Files Setup
	const testFiles = [
		{ name: "test-small.txt", size: 1024, data: new Uint8Array(1024).fill(65) }, // 1KB
		{
			name: "test-medium.bin",
			size: 1024 * 1024 * 5,
			data: new Uint8Array(1024 * 1024 * 5).fill(66),
		}, // 5MB
		{
			name: "test-large.bin",
			size: 1024 * 1024 * 15,
			data: new Uint8Array(1024 * 1024 * 15).fill(67),
		}, // 15MB
		{ name: "test-zero.bin", size: 0, data: new Uint8Array(0) }, // 0B
	];

	console.log(`\nPhase 1: Uploading ${testFiles.length} test files...`);
	for (const file of testFiles) {
		process.stdout.write(`Uploading ${file.name} (${file.size} bytes)... `);
		await s3Client.fetch(file.name, {
			method: "PUT",
			body: file.data,
		});
		console.log("✓");
	}

	// 2. Verify Standard GET Content-Length
	console.log("\nPhase 2: Verifying Standard GET Content-Length...");
	let getFailures = 0;
	for (const file of testFiles) {
		const res = await s3Client.fetch(file.name, { method: "GET" });
		const cl = res.headers.get("content-length");

		if (cl === file.size.toString()) {
			console.log(`✓ ${file.name}: GET Content-Length correct (${cl})`);
		} else {
			console.error(
				`✗ ${file.name}: GET Content-Length MISMATCH (Expected ${file.size}, got ${cl})`,
			);
			getFailures++;
		}
		await res.text(); // drain
	}

	// 3. Simulate Migration Logic Fallbacks
	console.log("\nPhase 3: Simulating Migration Logic Fallbacks...");
	let migrationFailures = 0;

	for (const file of testFiles) {
		console.log(`\nChecking ${file.name}...`);

		// A. List Object
		const listRes = await s3Client.fetch(`?list-type=2&prefix=${file.name}`, {
			method: "GET",
		});
		const xml = await listRes.text();
		const parser = new XMLParser();
		const result = parser.parse(xml).ListBucketResult;
		const contents = result.Contents
			? Array.isArray(result.Contents)
				? result.Contents
				: [result.Contents]
			: [];
		const item = contents.find((i: any) => i.Key === file.name);

		if (!item) {
			console.error("  ✗ File not found in list!");
			migrationFailures++;
			continue;
		}

		// B. Simulate Logic
		let resolvedSize = null;

		// Simulation: Assume GET header is missing
		console.log("  [Simulation] GET Content-Length header missing.");

		// Fallback 1: item.Size
		if (item.Size !== undefined) {
			console.log(`  [Logic] Found item.Size: ${item.Size}`);
			resolvedSize = item.Size.toString();
		}

		// Fallback 2: HEAD (only if Size failed)
		if (!resolvedSize) {
			console.log("  [Logic] item.Size missing, trying HEAD...");
			const headRes = await s3Client.fetch(file.name, { method: "HEAD" });
			resolvedSize = headRes.headers.get("content-length");
			console.log(`  [Logic] HEAD Result: ${resolvedSize}`);
		}

		if (resolvedSize === file.size.toString()) {
			console.log(`  ✓ Resolved Size Correct: ${resolvedSize}`);
		} else {
			console.error(
				`  ✗ Resolved Size WRONG: ${resolvedSize} (Expected ${file.size})`,
			);
			migrationFailures++;
		}
	}

	// 4. Cleanup
	console.log("\nPhase 4: Cleanup...");
	for (const file of testFiles) {
		await s3Client.fetch(file.name, { method: "DELETE" });
	}

	console.log("\n----------------------------------------");
	console.log("SUMMARY");
	console.log(`GET Failures:       ${getFailures}`);
	console.log(`Migration Failures: ${migrationFailures}`);

	if (getFailures === 0 && migrationFailures === 0) {
		console.log("RESULT: PASSED ALL CHECKS");
	} else {
		console.log("RESULT: FAILED");
		process.exit(1);
	}
}

run().catch(console.error);
