import { config } from "../src/config";
import { s3Client } from "../src/lib/s3-client";

async function testStreamingUpload() {
	console.log("Starting streaming upload test...");

	// 1. Create a dummy large file (10MB) as a stream
	const size = 10 * 1024 * 1024;
	const buffer = new Uint8Array(size);
	buffer.fill(65); // 'A'

	// Create a ReadableStream from the buffer
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(buffer);
			controller.close();
		},
	});

	const key = "debug-streaming-test.txt";
	const endpoint = config.s3.endpoint
		.replace(/^https?:\/\//, "")
		.replace(/\/$/, "");
	const url = `https://${config.s3.bucket}.${endpoint}/${key}`;

	console.log(`Target URL: ${url}`);
	console.log(`File size: ${size} bytes`);

	// 2. Sign the request using aws4fetch ONLY for headers
	// We need to bypass the s3Client.fetch wrapper to test raw fetch behavior
	const signedRequest = await s3Client.sign(url, {
		method: "PUT",
		headers: {
			"Content-Length": size.toString(),
			"Content-Type": "text/plain",
		},
	});

	console.log(
		"Signed headers:",
		Object.fromEntries(signedRequest.headers.entries()),
	);

	// 3. Execute the request using Bun's native fetch
	// We explicitly pass the stream as body and try to enforce Content-Length
	try {
		const response = await fetch(url, {
			method: "PUT",
			headers: signedRequest.headers, // Use the signed headers
			body: stream, // Stream body
			// @ts-expect-error - Bun/Node specific option for full-duplex streaming or to signal streaming intent
			duplex: "half",
		});

		console.log(`Response status: ${response.status} ${response.statusText}`);
		const text = await response.text();
		console.log(`Response body: ${text}`);

		if (response.ok) {
			console.log("✅ Streaming upload SUCCEEDED!");
		} else {
			console.error("❌ Streaming upload FAILED.");
		}
	} catch (error) {
		console.error("❌ Request threw an error:", error);
	}
}

testStreamingUpload();
