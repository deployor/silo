import { AwsClient } from "aws4fetch";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { buckets } from "../src/db/schema";

const S3_ENDPOINT = "https://silo.deployor.dev";

async function main() {
	console.log("🧪 Starting Presigned URL & Public Access Test...");

	// 1. Setup: Get a user and bucket
	const testBucketName = "testtest";
	const accessKey = "CKD4DCC2B3BB4F9AEDC305";
	const secretKey = "4495a68af0cb0c56778f5b363ea22a4e33588eaa";

	const bucket = await db.query.buckets.findFirst({
		where: eq(buckets.name, testBucketName),
	});

	if (!bucket) {
		console.error(
			"❌ Test bucket not found in DB. Please run test-prod.ts first or ensure seed data.",
		);
		process.exit(1);
	}

	console.log(`Using bucket: ${bucket.name}`);
	console.log(`Access Key: ${bucket.accessKey}`);
	console.log(`Secret Key: ${bucket.secretKey}`);

	// 2. Upload a private file using standard Auth (Header)
	const filename = "secret.txt";
	const content = `This is a secret message ${Date.now()}`;

	const aws = new AwsClient({
		accessKeyId: accessKey,
		secretAccessKey: secretKey,
		service: "s3",
		region: "auto",
	});

	console.log("\n1. Uploading private file...");
	const uploadRes = await aws.fetch(
		`${S3_ENDPOINT}/${bucket.name}/${filename}`,
		{
			method: "PUT",
			body: content,
		},
	);

	if (!uploadRes.ok) {
		console.error("❌ Upload failed:", await uploadRes.text());
		process.exit(1);
	}
	console.log("✅ Upload success");

	// 3. Try to access it publicly (Should Fail)
	console.log("\n2. Testing public access (Should FAIL)...");
	const publicRes = await fetch(`${S3_ENDPOINT}/${bucket.name}/${filename}`);
	if (publicRes.status === 403) {
		console.log("✅ Success: Access Denied (403)");
	} else {
		console.error(`❌ Failure: Expected 403, got ${publicRes.status}`);
	}

	// 4. Generate Presigned URL
	console.log("\n3. Testing Presigned URL...");

	const urlToSign = new URL(`${S3_ENDPOINT}/${bucket.name}/${filename}`);

	const signedReq = await aws.sign(urlToSign.toString(), {
		method: "GET",
		aws: { signQuery: true },
	});

	const presignedUrl = signedReq.url;
	console.log("Generated Presigned URL:", presignedUrl);

	// 5. Fetch using Presigned URL
	const presignedRes = await fetch(presignedUrl);

	if (presignedRes.ok) {
		const text = await presignedRes.text();
		if (text === content) {
			console.log("✅ Success: Accessed private file with presigned URL");
		} else {
			console.error("❌ Failure: Content mismatch");
			console.log("Expected:", content);
			console.log("Got:", text);
		}
	} else {
		console.error(
			`❌ Failure: Failed to access with presigned URL. Status: ${presignedRes.status}`,
		);
		console.log(await presignedRes.text());
	}

	// 6. Test Public Toggle
	console.log("\n4. Testing Public Toggle...");

	// Set bucket to public via DB (simulating API)
	await db
		.update(buckets)
		.set({ isPublic: true })
		.where(eq(buckets.id, bucket.id));
	console.log("Bucket set to public.");

	const publicRes2 = await fetch(`${S3_ENDPOINT}/${bucket.name}/${filename}`);
	if (publicRes2.ok) {
		console.log("✅ Success: Accessed file publicly after toggle");
	} else {
		console.error(`❌ Failure: Expected 200, got ${publicRes2.status}`);
	}

	// Revert
	await db
		.update(buckets)
		.set({ isPublic: false })
		.where(eq(buckets.id, bucket.id));
	console.log("Bucket reverted to private.");

	console.log("\n🎉 All Presigned & Public Access Tests Completed!");
	process.exit(0);
}

main().catch(console.error);
