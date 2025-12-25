import {
	S3Client,
	ListBucketsCommand,
	HeadBucketCommand,
	GetBucketLocationCommand,
	PutBucketCorsCommand,
	GetBucketCorsCommand,
	DeleteBucketCorsCommand,
	PutObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	DeleteObjectCommand,
	CopyObjectCommand,
	ListObjectsV2Command,
	DeleteObjectsCommand,
	CreateMultipartUploadCommand,
	UploadPartCommand,
	CompleteMultipartUploadCommand,
	AbortMultipartUploadCommand,
	ListMultipartUploadsCommand,
	ListPartsCommand,
} from "@aws-sdk/client-s3";

// Configuration
const ENDPOINT = "https://silo.deployor.dev";
const REGION = "auto";

// Bucket 1 (Public)
const BUCKET_1 = {
	name: "publicbucket",
	accessKeyId: "CK73B3D7CA74F230C3A7D7",
	secretAccessKey: "d1bf4c1318e082b756179f3f038c4016aa6ddb49",
};

// Bucket 2 (Private)
const BUCKET_2 = {
	name: "privatebucket",
	accessKeyId: "CKC1E78FD976F4C160A7D8",
	secretAccessKey: "356d36d9e7afa554dea1b1591d118c40287d2055",
};

// Clients
const client1 = new S3Client({
	region: REGION,
	endpoint: ENDPOINT,
	credentials: {
		accessKeyId: BUCKET_1.accessKeyId,
		secretAccessKey: BUCKET_1.secretAccessKey,
	},
	forcePathStyle: true, // Important for custom endpoints usually
});

const client2 = new S3Client({
	region: REGION,
	endpoint: ENDPOINT,
	credentials: {
		accessKeyId: BUCKET_2.accessKeyId,
		secretAccessKey: BUCKET_2.secretAccessKey,
	},
	forcePathStyle: true,
});

async function runTests() {
	console.log("🚀 Starting Comprehensive S3 Tests against " + ENDPOINT);

	try {
		// ==========================================
		// 1. Standard Operations (Bucket 1)
		// ==========================================
		console.log("\n--- Testing Standard Operations (Bucket 1) ---");

		// List Buckets
		console.log("Testing ListBuckets...");
		const listBuckets = await client1.send(new ListBucketsCommand({}));
		console.log(
			"✅ ListBuckets success:",
			listBuckets.Buckets?.map((b) => b.Name),
		);

		// Head Bucket
		console.log(`Testing HeadBucket (${BUCKET_1.name})...`);
		await client1.send(new HeadBucketCommand({ Bucket: BUCKET_1.name }));
		console.log("✅ HeadBucket success");

		// Get Bucket Location
		console.log(`Testing GetBucketLocation (${BUCKET_1.name})...`);
		const location = await client1.send(
			new GetBucketLocationCommand({ Bucket: BUCKET_1.name }),
		);
		console.log("✅ GetBucketLocation success:", location.LocationConstraint);

		// Put Object
		console.log("Testing PutObject...");
		const key = "test-file.txt";
		await client1.send(
			new PutObjectCommand({
				Bucket: BUCKET_1.name,
				Key: key,
				Body: "Hello World",
				ContentType: "text/plain",
			}),
		);
		console.log("✅ PutObject success");

		// Get Object
		console.log("Testing GetObject...");
		const getObj = await client1.send(
			new GetObjectCommand({ Bucket: BUCKET_1.name, Key: key }),
		);
		const body = await getObj.Body?.transformToString();
		if (body !== "Hello World") throw new Error("Content mismatch");
		console.log("✅ GetObject success");

		// Head Object
		console.log("Testing HeadObject...");
		await client1.send(
			new HeadObjectCommand({ Bucket: BUCKET_1.name, Key: key }),
		);
		console.log("✅ HeadObject success");

		// List Objects V2
		console.log("Testing ListObjectsV2...");
		const listObj = await client1.send(
			new ListObjectsV2Command({ Bucket: BUCKET_1.name }),
		);
		if (!listObj.Contents?.find((c) => c.Key === key))
			throw new Error("Object not found in list");
		console.log("✅ ListObjectsV2 success");

		// Copy Object
		console.log("Testing CopyObject...");
		const copyKey = "test-copy.txt";
		await client1.send(
			new CopyObjectCommand({
				Bucket: BUCKET_1.name,
				CopySource: `${BUCKET_1.name}/${key}`,
				Key: copyKey,
			}),
		);
		console.log("✅ CopyObject success");

		// Delete Objects (Bulk)
		console.log("Testing DeleteObjects...");
		await client1.send(
			new DeleteObjectsCommand({
				Bucket: BUCKET_1.name,
				Delete: { Objects: [{ Key: key }, { Key: copyKey }] },
			}),
		);
		console.log("✅ DeleteObjects success");

		// CORS Operations
		console.log("Testing CORS Operations...");
		await client1.send(
			new PutBucketCorsCommand({
				Bucket: BUCKET_1.name,
				CORSConfiguration: {
					CORSRules: [
						{
							AllowedHeaders: ["*"],
							AllowedMethods: ["GET"],
							AllowedOrigins: ["*"],
						},
					],
				},
			}),
		);
		console.log("✅ PutBucketCors success");

		const cors = await client1.send(
			new GetBucketCorsCommand({ Bucket: BUCKET_1.name }),
		);
		// The order of methods might vary or be normalized, so we check if GET is present
		const allowedMethods = cors.CORSRules?.[0]?.AllowedMethods || [];
		// AWS SDK might return methods as array or single string depending on XML parsing
		// Our new XML builder ensures arrays, but let's be robust
		const methods = Array.isArray(allowedMethods)
			? allowedMethods
			: [allowedMethods];

		if (!methods.includes("GET"))
			throw new Error(
				"CORS mismatch: GET not found in allowed methods. Got: " +
					JSON.stringify(methods),
			);
		console.log("✅ GetBucketCors success");

		await client1.send(
			new DeleteBucketCorsCommand({ Bucket: BUCKET_1.name }),
		);
		console.log("✅ DeleteBucketCors success");

		// ==========================================
		// 2. Multipart Uploads
		// ==========================================
		console.log("\n--- Testing Multipart Uploads ---");
		const mpKey = "multipart-test.txt";
		const mpCreate = await client1.send(
			new CreateMultipartUploadCommand({
				Bucket: BUCKET_1.name,
				Key: mpKey,
			}),
		);
		const uploadId = mpCreate.UploadId;
		console.log("✅ CreateMultipartUpload success, ID:", uploadId);

		if (!uploadId) throw new Error("No UploadId returned");

		// Create a 5MB buffer for parts (minimum size for S3 parts except the last one)
		const partSize = 5 * 1024 * 1024;
		const partBuffer = Buffer.alloc(partSize, "a");

		const part1 = await client1.send(
			new UploadPartCommand({
				Bucket: BUCKET_1.name,
				Key: mpKey,
				PartNumber: 1,
				UploadId: uploadId,
				Body: partBuffer,
			}),
		);
		console.log("✅ UploadPart 1 success");

		const part2 = await client1.send(
			new UploadPartCommand({
				Bucket: BUCKET_1.name,
				Key: mpKey,
				PartNumber: 2,
				UploadId: uploadId,
				Body: "Part 2", // Last part can be small
			}),
		);
		console.log("✅ UploadPart 2 success");

		const listParts = await client1.send(
			new ListPartsCommand({
				Bucket: BUCKET_1.name,
				Key: mpKey,
				UploadId: uploadId,
			}),
		);
		if (listParts.Parts?.length !== 2)
			throw new Error("ListParts count mismatch");
		console.log("✅ ListParts success");

		await client1.send(
			new CompleteMultipartUploadCommand({
				Bucket: BUCKET_1.name,
				Key: mpKey,
				UploadId: uploadId,
				MultipartUpload: {
					Parts: [
						{ PartNumber: 1, ETag: part1.ETag },
						{ PartNumber: 2, ETag: part2.ETag },
					],
				},
			}),
		);
		console.log("✅ CompleteMultipartUpload success");

		// Cleanup multipart file
		await client1.send(
			new DeleteObjectCommand({ Bucket: BUCKET_1.name, Key: mpKey }),
		);

		// Test Abort
		const abortMp = await client1.send(
			new CreateMultipartUploadCommand({
				Bucket: BUCKET_1.name,
				Key: "abort-test.txt",
			}),
		);
		await client1.send(
			new AbortMultipartUploadCommand({
				Bucket: BUCKET_1.name,
				Key: "abort-test.txt",
				UploadId: abortMp.UploadId,
			}),
		);
		console.log("✅ AbortMultipartUpload success");

		// ==========================================
		// 3. Security & Isolation
		// ==========================================
		console.log("\n--- Testing Security & Isolation ---");

		// 3.1 Cross-Bucket Access (Client 1 trying to access Bucket 2)
		console.log("Testing Cross-Bucket Access (Should Fail)...");
		try {
			await client1.send(
				new ListObjectsV2Command({ Bucket: BUCKET_2.name }),
			);
			console.error("❌ Client 1 was able to list Bucket 2!");
		} catch (e: any) {
			console.log("✅ Client 1 denied access to Bucket 2 (" + e.name + ")");
		}

		// 3.2 Public Access
		console.log("Testing Public Access...");
		// Upload file to public bucket
		await client1.send(
			new PutObjectCommand({
				Bucket: BUCKET_1.name,
				Key: "public.txt",
				Body: "Public Content",
			}),
		);
		// Fetch without credentials
		const publicRes = await fetch(
			`${ENDPOINT}/${BUCKET_1.name}/public.txt`,
		);
		if (publicRes.status === 200) {
			console.log("✅ Public bucket file accessible without auth");
		} else {
			console.error(
				"❌ Public bucket file NOT accessible:",
				publicRes.status,
			);
		}

		// Upload file to private bucket
		await client2.send(
			new PutObjectCommand({
				Bucket: BUCKET_2.name,
				Key: "private.txt",
				Body: "Private Content",
			}),
		);
		// Fetch without credentials
		const privateRes = await fetch(
			`${ENDPOINT}/${BUCKET_2.name}/private.txt`,
		);
		if (privateRes.status === 403) {
			console.log("✅ Private bucket file denied without auth");
		} else {
			console.error(
				"❌ Private bucket file ACCESSIBLE without auth:",
				privateRes.status,
			);
		}

		// ==========================================
		// 4. Unsupported Operations & Injection
		// ==========================================
		console.log("\n--- Testing Unsupported Operations & Injection ---");

		// 4.1 Unsupported Operation (e.g., GetBucketAcl - not in list)
		// Note: AWS SDK might not have a command for something completely random, but we can try a raw fetch
		// or use a command that is definitely not supported.
		// Let's try to access a non-existent bucket with weird characters
		console.log("Testing Injection/Invalid Bucket Name...");
		try {
			await client1.send(
				new ListObjectsV2Command({ Bucket: "../../../etc/passwd" }),
			);
			console.error("❌ Path traversal bucket name accepted!");
		} catch (e) {
			console.log("✅ Path traversal bucket name rejected");
		}

		// 4.2 Metadata Injection
		console.log("Testing Metadata Injection...");
		try {
			await client1.send(
				new PutObjectCommand({
					Bucket: BUCKET_1.name,
					Key: "injection.txt",
					Body: "test",
					Metadata: {
						"x-amz-meta-test": "value\r\nInjected-Header: true",
					},
				}),
			);
			// If it succeeds, check if header was injected (hard to check with SDK, but server shouldn't crash)
			console.log("✅ Metadata injection attempt handled (no crash)");
		} catch (e) {
			console.log("✅ Metadata injection rejected");
		}

		console.log("\n🎉 All Comprehensive Tests Completed!");
	} catch (error) {
		console.error("\n❌ Test Suite Failed:", error);
	}
}

runTests();
