import { XMLParser } from "fast-xml-parser";
import { s3Client } from "../src/lib/s3-client";

async function run() {
	const _bucket = s3Client.getBucket();
	const filename = "large-test-file.bin";
	const size = 1024 * 1024 * 55; // 55MB (above the 50MB old limit)

	console.log(`Generating ${size / 1024 / 1024} MB file...`);
	const buffer = new Uint8Array(size);
	// Fill with some data
	for (let i = 0; i < size; i += 1024) {
		buffer[i] = i % 255;
	}

	console.log("Uploading file...");
	await s3Client.fetch(filename, {
		method: "PUT",
		body: buffer,
	});
	console.log("Upload complete.");

	console.log("Listing bucket...");
	const listRes = await s3Client.fetch(`?list-type=2&prefix=${filename}`, {
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

	const item = contents.find((i: any) => i.Key === filename);
	if (!item) {
		console.error("File not found in list!");
		return;
	}

	console.log("List Item found:", JSON.stringify(item, null, 2));

	if (!item.Size) {
		console.error("ERROR: Item.Size is missing from List response!");
	} else {
		console.log(`SUCCESS: Item.Size is present: ${item.Size}`);
	}

	// Simulate the migration logic check
	console.log("\nSimulating Migration Logic...");

	// Simulate GET response with MISSING Content-Length
	const mockGetResponse = {
		headers: new Map(), // Empty headers
		body: "stream-placeholder",
	};

	let contentLength = mockGetResponse.headers.get("content-length");
	console.log(`Initial Content-Length header: ${contentLength}`);

	// THE FIX LOGIC
	if (!contentLength && item.Size) {
		console.log("Content-Length missing, falling back to item.Size...");
		contentLength = item.Size.toString();
	}

	if (contentLength === size.toString()) {
		console.log(
			`SUCCESS: Content-Length correctly recovered: ${contentLength}`,
		);
	} else {
		console.error(
			`FAILURE: Content-Length mismatch. Expected ${size}, got ${contentLength}`,
		);
	}

	// Cleanup
	console.log("\nCleaning up...");
	await s3Client.fetch(filename, { method: "DELETE" });
	console.log("Done.");
}

run().catch(console.error);
