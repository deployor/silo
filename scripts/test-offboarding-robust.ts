import { XMLParser } from "fast-xml-parser";
import { s3Client } from "../src/lib/s3-client";

async function run() {
	const filename = "robust-test-file.bin";
	const size = 1024 * 1024 * 10; // 10MB

	console.log(`Generating ${size / 1024 / 1024} MB file...`);
	const buffer = new Uint8Array(size);
	for (let i = 0; i < size; i += 1024) {
		buffer[i] = i % 255;
	}

	console.log("Uploading file...");
	await s3Client.fetch(filename, {
		method: "PUT",
		body: buffer,
	});

	// Also upload a 0-byte file to test the edge case
	const zeroFilename = "zero-byte-file.bin";
	await s3Client.fetch(zeroFilename, {
		method: "PUT",
		body: new Uint8Array(0),
	});

	console.log("Uploads complete.");

	// Helper to simulate the offboarding logic
	async function simulateMigration(key: string, expectedSize: number) {
		console.log(
			`\nTesting migration logic for ${key} (Expected Size: ${expectedSize})...`,
		);

		// 1. List Object to get item.Size
		const listRes = await s3Client.fetch(`?list-type=2&prefix=${key}`, {
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

		const item = contents.find((i: any) => i.Key === key);
		if (!item) {
			console.error("File not found in list!");
			return;
		}
		console.log(`ListObjects Size: ${item.Size}`);

		// 2. Simulate GET with MISSING Content-Length header
		let contentLength: string | null = null; // Simulate missing header

		// Logic from offboarding.ts
		if (!contentLength && item.Size !== undefined) {
			console.log("Fallback 1: Using item.Size");
			contentLength = item.Size.toString();
		}

		if (!contentLength) {
			console.log("Fallback 2: Try HEAD request...");
			try {
				const headRes = await s3Client.fetch(key, { method: "HEAD" });
				if (headRes.ok) {
					const headCL = headRes.headers.get("content-length");
					if (headCL) {
						contentLength = headCL;
						console.log(`Found size via HEAD: ${contentLength}`);
					}
				}
			} catch (_e) {
				console.error("HEAD request failed");
			}
		}

		if (contentLength === expectedSize.toString()) {
			console.log("SUCCESS: Content-Length resolved correctly.");
		} else {
			console.error(
				`FAILURE: Resolved ${contentLength}, expected ${expectedSize}`,
			);
		}
	}

	await simulateMigration(filename, size);
	await simulateMigration(zeroFilename, 0);

	// Cleanup
	console.log("\nCleaning up...");
	await s3Client.fetch(filename, { method: "DELETE" });
	await s3Client.fetch(zeroFilename, { method: "DELETE" });
	console.log("Done.");
}

run().catch(console.error);
