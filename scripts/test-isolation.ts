import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

async function runIsolationTest() {
	console.log("🧪 Starting Strict Bucket Isolation Test...");

	const endpoint = "https://cargo.deployor.dev";

	// User 1 / Bucket 1
	const bucket1 = "testtest";
	const creds1 = {
		accessKeyId: "CKD4DCC2B3BB4F9AEDC305",
		secretAccessKey: "4495a68af0cb0c56778f5b363ea22a4e33588eaa",
	};

	// User 2 / Bucket 2
	const bucket2 = "test2";
	const creds2 = {
		accessKeyId: "CKB1722051AED09DDD4D41",
		secretAccessKey: "be3a4394c4b5602f9d905e3537c90b413c0de500",
	};

	const s3_1 = new S3Client({
		region: "auto",
		endpoint: endpoint,
		credentials: creds1,
		forcePathStyle: true,
	});

	const s3_2 = new S3Client({
		region: "auto",
		endpoint: endpoint,
		credentials: creds2,
		forcePathStyle: true,
	});

	try {
		// 1. Setup: Create files in both buckets using correct credentials
		console.log(`\n1. Creating file in ${bucket1} using User 1...`);
		await s3_1.send(
			new PutObjectCommand({
				Bucket: bucket1,
				Key: "file1.txt",
				Body: "This is file 1",
			}),
		);
		console.log("✅ Success");

		console.log(`\n2. Creating file in ${bucket2} using User 2...`);
		await s3_2.send(
			new PutObjectCommand({
				Bucket: bucket2,
				Key: "file2.txt",
				Body: "This is file 2",
			}),
		);
		console.log("✅ Success");

		// 2. Test: User 2 tries to read User 1's file (Should Fail)
		console.log(
			`\n3. User 2 trying to read ${bucket1}/file1.txt (Should FAIL)...`,
		);
		try {
			await s3_2.send(
				new GetObjectCommand({
					Bucket: bucket1,
					Key: "file1.txt",
				}),
			);
			console.error("❌ FAILURE: User 2 was able to read User 1's file!");
			process.exit(1);
		} catch (e: unknown) {
			const error = e as { $metadata?: { httpStatusCode?: number } };
			if (error.$metadata?.httpStatusCode === 403) {
				console.log("✅ Success: Access Denied (403)");
			} else {
				console.error(
					`⚠️ Unexpected error code: ${error.$metadata?.httpStatusCode}`,
				);
			}
		}

		// 3. Test: User 1 tries to read User 2's file (Should Fail)
		console.log(
			`\n4. User 1 trying to read ${bucket2}/file2.txt (Should FAIL)...`,
		);
		try {
			await s3_1.send(
				new GetObjectCommand({
					Bucket: bucket2,
					Key: "file2.txt",
				}),
			);
			console.error("❌ FAILURE: User 1 was able to read User 2's file!");
			process.exit(1);
		} catch (e: unknown) {
			const error = e as { $metadata?: { httpStatusCode?: number } };
			if (error.$metadata?.httpStatusCode === 403) {
				console.log("✅ Success: Access Denied (403)");
			} else {
				console.error(
					`⚠️ Unexpected error code: ${error.$metadata?.httpStatusCode}`,
				);
			}
		}

		// 4. Test: User 2 tries to write to User 1's bucket (Should Fail)
		console.log(`\n5. User 2 trying to write to ${bucket1} (Should FAIL)...`);
		try {
			await s3_2.send(
				new PutObjectCommand({
					Bucket: bucket1,
					Key: "hacked.txt",
					Body: "I am a hacker",
				}),
			);
			console.error("❌ FAILURE: User 2 was able to write to User 1's bucket!");
			process.exit(1);
		} catch (e: unknown) {
			const error = e as { $metadata?: { httpStatusCode?: number } };
			if (error.$metadata?.httpStatusCode === 403) {
				console.log("✅ Success: Access Denied (403)");
			} else {
				console.error(
					`⚠️ Unexpected error code: ${error.$metadata?.httpStatusCode}`,
				);
			}
		}

		console.log("\n🎉 Isolation Test Passed: Buckets are strictly isolated!");
	} catch (error) {
		console.error("\n❌ Test Failed with unexpected error:", error);
		process.exit(1);
	}
}

runIsolationTest();
