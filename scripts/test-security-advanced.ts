import {
	S3Client,
	GetObjectCommand,
	PutObjectCommand,
	CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { AwsClient } from "aws4fetch";

async function runTest() {
	console.log("🛡️ Starting Advanced Security & Isolation Test...");

	const testBucketName = "testprod";
	const accessKey = "CKDFF6206F787F987A2EE5";
	const secretKey = "3637a2e9eac5c03009cfd65ee5fceecc6fa1dc49";
	const endpoint = "https://silo.deployor.dev";

	// Helper for signing
	const signer = new AwsClient({
		accessKeyId: accessKey,
		secretAccessKey: secretKey,
		service: "s3",
		region: "auto",
	});

	const s3 = new S3Client({
		region: "auto",
		endpoint: endpoint,
		credentials: {
			accessKeyId: accessKey,
			secretAccessKey: secretKey,
		},
		forcePathStyle: true,
	});

	// Helper to expect failure
	async function expectFailure(
		promise: Promise<any>,
		name: string,
		expectedStatus?: number,
	) {
		try {
			await promise;
			console.error(`❌ ${name} SUCCEEDED (Should have been blocked)`);
		} catch (e: any) {
			const status = e.$metadata?.httpStatusCode;
			if (
				status === 405 ||
				status === 403 ||
				status === 501 ||
				status === 404
			) {
				if (expectedStatus && status !== expectedStatus) {
					console.warn(
						`⚠️ ${name} blocked but with unexpected status: ${status} (Expected: ${expectedStatus})`,
					);
				} else {
					console.log(`✅ ${name} blocked (Status: ${status})`);
				}
			} else {
				console.warn(
					`⚠️ ${name} failed with unexpected status: ${status} (Error: ${e.message})`,
				);
			}
		}
	}

	console.log("\n--- 1. Testing Non-Existent/Made-up S3 Calls ---");

	// 1.1 Random Query Params on POST (Should be Unknown -> 405)
	// GET ignores params and does ListObjects, so we use POST.
	console.log("Testing Random Query Params (POST)...");
	try {
		const url = `${endpoint}/${testBucketName}?random-action=true`;
		const signed = await signer.sign(url, { method: "POST" });
		const res = await fetch(signed);

		if (res.status === 405) {
			console.log("✅ Random Query Param (POST) blocked (Status: 405)");
		} else {
			console.error(
				`❌ Random Query Param (POST) allowed or unexpected status: ${res.status}`,
			);
		}
	} catch (e) {
		console.log("✅ Random Query Param (POST) blocked (Network Error)");
	}

	// 1.2 Weird HTTP Methods
	console.log("Testing Weird HTTP Methods (PROPFIND)...");
	try {
		const url = `${endpoint}/${testBucketName}`;
		const signed = await signer.sign(url, { method: "PROPFIND" });
		const res = await fetch(signed);

		if (res.status === 405) {
			console.log("✅ PROPFIND blocked (Status: 405)");
		} else {
			console.error(`❌ PROPFIND allowed or unexpected status: ${res.status}`);
		}
	} catch (e) {
		console.log("✅ PROPFIND blocked (Network Error)");
	}

	console.log("\n--- 2. Testing Isolation / Cross-Bucket Tricks ---");

	// 2.1 Accessing another bucket in the URL (while signed for testBucket)
	console.log("Testing Access to 'other-bucket'...");
	const otherBucketS3 = new S3Client({
		region: "auto",
		endpoint: endpoint,
		credentials: {
			accessKeyId: accessKey,
			secretAccessKey: secretKey,
		},
		forcePathStyle: true,
	});

	await expectFailure(
		otherBucketS3.send(
			new GetObjectCommand({
				Bucket: "other-bucket",
				Key: "secret.txt",
			}),
		),
		"Access Other Bucket",
		403,
	);

	// 2.2 Path Traversal in Key
	console.log("Testing Path Traversal in Key (../)...");
	await expectFailure(
		s3.send(
			new GetObjectCommand({
				Bucket: testBucketName,
				Key: "../other-bucket/secret.txt",
			}),
		),
		"Path Traversal",
		403,
	);

	// 2.3 URL Encoded Path Traversal
	console.log("Testing URL Encoded Path Traversal (%2e%2e%2f)...");
	await expectFailure(
		s3.send(
			new GetObjectCommand({
				Bucket: testBucketName,
				Key: "..%2f..%2fetc/passwd",
			}),
		),
		"Encoded Path Traversal",
		403,
	);

	// 2.4 CopyObject from another bucket (Cross-Bucket Copy)
	console.log("Testing CopyObject from 'other-bucket'...");
	await expectFailure(
		s3.send(
			new CopyObjectCommand({
				Bucket: testBucketName,
				CopySource: "other-bucket/secret.txt",
				Key: "stolen.txt",
			}),
		),
		"Cross-Bucket Copy",
		403,
	);

	// 2.5 CopyObject Self-Copy (Should be allowed)
	console.log("Testing CopyObject Self-Copy (Should be allowed)...");
	// First ensure source exists
	try {
		await s3.send(
			new PutObjectCommand({
				Bucket: testBucketName,
				Key: "source.txt",
				Body: "data",
			}),
		);
		await s3.send(
			new CopyObjectCommand({
				Bucket: testBucketName,
				CopySource: `${testBucketName}/source.txt`,
				Key: "dest.txt",
			}),
		);
		console.log("✅ Self-Copy succeeded");
	} catch (e: any) {
		console.error(`❌ Self-Copy FAILED: ${e.message}`);
	}

	console.log("\n--- 3. Testing Protocol/Header Tricks ---");

	// 3.1 Missing Date Header (Auth should fail)
	console.log("Testing Missing Date Header...");
	try {
		// We manually construct headers to have valid Credential format but missing Date
		const credential = `${accessKey}/20250101/auto/s3/aws4_request`;
		const res = await fetch(`${endpoint}/${testBucketName}/file.txt`, {
			headers: {
				Authorization: `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=host, Signature=sig`,
				// No X-Amz-Date or Date
			},
		});
		if (res.status === 403) {
			console.log("✅ Missing Date blocked (Status: 403)");
		} else {
			console.error(
				`❌ Missing Date allowed or unexpected status: ${res.status}`,
			);
		}
	} catch (e) {
		console.log("✅ Missing Date blocked (Network Error)");
	}

	// 3.2 Invalid Signature (Tampered Request)
	console.log("Testing Tampered Signature...");
	try {
		const url = `${endpoint}/${testBucketName}/file.txt`;
		const signed = await signer.sign(url);
		const headers = new Headers(signed.headers);
		// Tamper with signature
		const auth = headers.get("Authorization");
		if (auth) {
			headers.set(
				"Authorization",
				auth.replace(/Signature=[a-f0-9]+/, "Signature=badbadbad"),
			);
		}

		const res = await fetch(url, {
			headers: headers,
		});

		if (res.status === 403) {
			console.log("✅ Invalid Signature blocked (Status: 403)");
		} else {
			console.error(
				`❌ Invalid Signature allowed or unexpected status: ${res.status}`,
			);
		}
	} catch (e) {
		console.log("✅ Invalid Signature blocked (Network Error)");
	}

	console.log("\n🎉 Advanced Security Test Complete!");
}

runTest();
