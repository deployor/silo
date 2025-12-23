import { AwsClient } from "aws4fetch";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { bucketKeys, buckets, users } from "../src/db/schema";

const S3_ENDPOINT = "https://silo.deployor.dev";

async function main() {
	console.log("🧪 Starting Storage Quota Test...");

	// 1. Setup: Get a user and bucket
	const testBucketName = "testtest";

	const bucket = await db.query.buckets.findFirst({
		where: eq(buckets.name, testBucketName),
	});

	if (!bucket) {
		console.error("❌ Test bucket not found in DB.");
		process.exit(1);
	}

	const key = await db.query.bucketKeys.findFirst({
		where: eq(bucketKeys.bucketId, bucket.id),
	});

	if (!key) {
		console.error("❌ No keys found for test bucket.");
		process.exit(1);
	}

	const accessKey = key.accessKey;
	const secretKey = key.secretKey;

	const user = await db.query.users.findFirst({
		where: eq(users.id, bucket.userId),
	});

	if (!user) {
		console.error("❌ User not found.");
		process.exit(1);
	}

	console.log(`User: ${user.id}`);
	console.log(
		`Current Usage: ${(Number(user.storageUsageBytes) / 1024 / 1024).toFixed(2)} MB`,
	);
	console.log(
		`Limit: ${(Number(user.storageLimitBytes) / 1024 / 1024).toFixed(2)} MB`,
	);

	const aws = new AwsClient({
		accessKeyId: accessKey,
		secretAccessKey: secretKey,
		service: "s3",
		region: "auto",
	});

	// --- Test 1: Standard Quota Enforcement ---
	console.log("\n--- Test 1: Standard Quota Enforcement ---");

	// Set usage to 900MB (Limit is 1GB = 1024MB)
	const usage900MB = 900 * 1024 * 1024;
	await db
		.update(users)
		.set({ storageUsageBytes: usage900MB })
		.where(eq(users.id, user.id));
	console.log("✅ DB updated to 900MB usage.");

	// Upload 1MB file (Should Succeed)
	console.log("1.1 Uploading small file (1MB) - Should SUCCEED...");
	const smallFile = new Uint8Array(1024 * 1024).fill(65); // 1MB of 'A'
	const res1 = await aws.fetch(`${S3_ENDPOINT}/${bucket.name}/small.bin`, {
		method: "PUT",
		headers: {
			"Content-Length": smallFile.length.toString(),
		},
		body: smallFile,
	});

	if (res1.ok) {
		console.log("✅ Success: Small file uploaded.");
	} else {
		console.error(
			`❌ Failure: Small file upload failed. Status: ${res1.status}`,
		);
		console.log(await res1.text());
	}

	// Upload 300MB file (Should Fail)
	console.log(
		"1.2 Uploading large file (300MB) - Should FAIL (Quota Exceeded)...",
	);
	const largeSize = 300 * 1024 * 1024;
	try {
		const res2 = await aws.fetch(`${S3_ENDPOINT}/${bucket.name}/large.bin`, {
			method: "PUT",
			headers: {
				"Content-Length": largeSize.toString(),
			},
			body: "fake-body", // Server checks header first
		});

		if (res2.status === 403) {
			const text = await res2.text();
			if (text.includes("QuotaExceeded")) {
				console.log("✅ Success: Upload blocked with QuotaExceeded error.");
			} else {
				console.log(`⚠️ Blocked with 403 but unexpected message: ${text}`);
			}
		} else {
			console.error(`❌ Failure: Expected 403, got ${res2.status}`);
			console.log(await res2.text());
		}
	} catch (e: unknown) {
		const error = e as Error;
		console.log(
			"Network error (expected if connection closed early):",
			error.message,
		);
	}

	// --- Test 2: Multipart Upload Quota ---
	console.log("\n--- Test 2: Multipart Upload Quota ---");

	// Reset usage to Limit - 5MB
	const limit = Number(user.storageLimitBytes);
	const usageNearLimit = limit - 5 * 1024 * 1024;
	await db
		.update(users)
		.set({ storageUsageBytes: usageNearLimit })
		.where(eq(users.id, user.id));
	console.log(
		`✅ DB updated to ${(usageNearLimit / 1024 / 1024).toFixed(2)} MB (5MB remaining).`,
	);

	// Initiate Multipart Upload
	console.log("2.1 Initiating Multipart Upload...");
	const initRes = await aws.fetch(
		`${S3_ENDPOINT}/${bucket.name}/multipart.bin?uploads`,
		{
			method: "POST",
		},
	);

	if (!initRes.ok) {
		console.error("❌ Failed to initiate multipart upload");
		console.log(await initRes.text());
		process.exit(1);
	}

	const initXml = await initRes.text();
	const uploadIdMatch = initXml.match(/<UploadId>(.*?)<\/UploadId>/);
	const uploadId = uploadIdMatch ? uploadIdMatch[1] : null;

	if (!uploadId) {
		console.error("❌ Could not parse UploadId");
		process.exit(1);
	}
	console.log(`✅ UploadId: ${uploadId}`);

	// Upload Part 1 (3MB) - Should Succeed (Remaining: 5MB -> 2MB)
	console.log("2.2 Uploading Part 1 (3MB) - Should SUCCEED...");
	const part1 = new Uint8Array(3 * 1024 * 1024).fill(66); // 3MB
	const part1Res = await aws.fetch(
		`${S3_ENDPOINT}/${bucket.name}/multipart.bin?partNumber=1&uploadId=${uploadId}`,
		{
			method: "PUT",
			headers: { "Content-Length": part1.length.toString() },
			body: part1,
		},
	);

	if (part1Res.ok) {
		console.log("✅ Part 1 uploaded.");
	} else {
		console.error(`❌ Part 1 failed: ${part1Res.status}`);
		console.log(await part1Res.text());
	}

	// Upload Part 2 (3MB) - Should Fail (Remaining: 2MB < 3MB)
	console.log("2.3 Uploading Part 2 (3MB) - Should FAIL (Quota Exceeded)...");
	const part2 = new Uint8Array(3 * 1024 * 1024).fill(67); // 3MB
	const part2Res = await aws.fetch(
		`${S3_ENDPOINT}/${bucket.name}/multipart.bin?partNumber=2&uploadId=${uploadId}`,
		{
			method: "PUT",
			headers: { "Content-Length": part2.length.toString() },
			body: part2,
		},
	);

	if (part2Res.status === 403) {
		console.log("✅ Part 2 blocked with 403.");
	} else {
		console.error(`❌ Part 2 unexpected status: ${part2Res.status}`);
		console.log(await part2Res.text());
	}

	// Abort multipart (cleanup)
	console.log("2.4 Aborting Multipart Upload...");
	await aws.fetch(
		`${S3_ENDPOINT}/${bucket.name}/multipart.bin?uploadId=${uploadId}`,
		{
			method: "DELETE",
		},
	);

	// --- Test 3: Content-Length Spoofing (Lying) ---
	console.log("\n--- Test 3: Content-Length Spoofing ---");

	// Reset usage to 0
	await db
		.update(users)
		.set({ storageUsageBytes: 0 })
		.where(eq(users.id, user.id));
	console.log("✅ Usage reset to 0.");

	// Attempt to upload 1MB body with Content-Length: 100
	console.log("3.1 Uploading 1MB body with Content-Length: 100...");

	const spoofBody = new Uint8Array(1024 * 1024).fill(68); // 1MB

	const spoofUrl = `${S3_ENDPOINT}/${bucket.name}/spoof.bin`;
	const signed = await aws.sign(spoofUrl, {
		method: "PUT",
		headers: { "Content-Length": "100" },
	});

	// Extract headers from signed request
	const headers = new Headers(signed.headers);
	headers.set("Content-Length", "100"); // Ensure it's 100

	// Now perform the actual fetch with the large body
	const spoofRes = await fetch(spoofUrl, {
		method: "PUT",
		headers: headers,
		body: spoofBody,
	});

	console.log(`Response Status: ${spoofRes.status}`);

	// Check usage
	const userAfterSpoof = await db.query.users.findFirst({
		where: eq(users.id, user.id),
	});

	const usage = Number(userAfterSpoof?.storageUsageBytes || 0);
	console.log(`Usage after spoof: ${usage} bytes`);

	// Verify what was actually stored
	if (spoofRes.ok) {
		const getRes = await aws.fetch(spoofUrl);
		const storedBlob = await getRes.arrayBuffer();
		const storedSize = storedBlob.byteLength;
		console.log(`Stored Object Size: ${storedSize} bytes`);

		if (usage === storedSize) {
			console.log(
				"✅ Usage matches stored size. The system correctly charged for what was stored.",
			);
		} else {
			console.error(
				`❌ Usage (${usage}) does NOT match stored size (${storedSize})!`,
			);
		}
	} else {
		console.log("ℹ️ Upload failed, so no usage check needed.");
	}

	process.exit(0);
}

main().catch(console.error);
