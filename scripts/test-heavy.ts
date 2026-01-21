import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CopyObjectCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetBucketLocationCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListBucketsCommand,
	ListMultipartUploadsCommand,
	ListObjectsV2Command,
	ListPartsCommand,
	PutObjectCommand,
	S3Client,
	UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

// --- Configuration ---
const CONFIG = {
	accessKeyId: "SILO_PROD_DK_8A44C832A88760BBC27A",
	secretAccessKey: "fa00f10fd6067748041e38400a33018cdefaacef",
	endpoint: "https://silo.deployor.dev",
	bucket: "testforprod",
	region: "auto",
};

const s3 = new S3Client({
	region: CONFIG.region,
	endpoint: CONFIG.endpoint,
	credentials: {
		accessKeyId: CONFIG.accessKeyId,
		secretAccessKey: CONFIG.secretAccessKey,
	},
	forcePathStyle: true,
});

// --- Helpers ---

function generateRandomBuffer(size: number): Buffer {
	return randomBytes(size);
}

class RandomStream extends Readable {
	private size: number;
	private sent: number;

	constructor(size: number) {
		super();
		this.size = size;
		this.sent = 0;
	}

	_read(size: number) {
		const remaining = this.size - this.sent;
		if (remaining <= 0) {
			this.push(null);
			return;
		}
		const chunk = randomBytes(Math.min(size, remaining));
		this.push(chunk);
		this.sent += chunk.length;
	}
}

async function runTest() {
	console.log("🚀 Starting Heavy S3 Test Suite...");
	console.log(`Target: ${CONFIG.endpoint}/${CONFIG.bucket}`);
	const startTime = Date.now();

	const errors: string[] = [];
	const logError = (msg: string, err: any) => {
		console.error(`❌ ${msg}`, err);
		errors.push(`${msg}: ${err.message || err}`);
	};

	try {
		// 1. Connectivity Check
		console.log("\n--- 1. Connectivity & Bucket Check ---");
		try {
			await s3.send(new HeadBucketCommand({ Bucket: CONFIG.bucket }));
			console.log("✅ HeadBucket success");
		} catch (e) {
			logError("HeadBucket failed", e);
			// Try to list buckets to see if we have access at all
			try {
				const list = await s3.send(new ListBucketsCommand({}));
				console.log("✅ ListBuckets success", list.Buckets?.map((b) => b.Name));
			} catch (listErr) {
				logError("ListBuckets failed", listErr);
				throw new Error("Cannot connect to S3 or find bucket");
			}
		}

		// 2. Basic CRUD - Small Files
		console.log("\n--- 2. Basic CRUD (Small Files) ---");
		const smallKey = "test-small.txt";
		const smallContent = "This is a small test file for S3 actions.";
		try {
			await s3.send(
				new PutObjectCommand({
					Bucket: CONFIG.bucket,
					Key: smallKey,
					Body: smallContent,
					ContentType: "text/plain",
					Metadata: { "x-test-meta": "value1" },
				}),
			);
			console.log("✅ PutObject (Small) success");

			const head = await s3.send(
				new HeadObjectCommand({ Bucket: CONFIG.bucket, Key: smallKey }),
			);
			if (head.Metadata?.["x-test-meta"] !== "value1")
				throw new Error("Metadata mismatch");
			if (head.ContentType !== "text/plain")
				throw new Error("ContentType mismatch");
			console.log("✅ HeadObject (Metadata) success");

			const get = await s3.send(
				new GetObjectCommand({ Bucket: CONFIG.bucket, Key: smallKey }),
			);
			const getContent = await get.Body?.transformToString();
			if (getContent !== smallContent)
				throw new Error("Content mismatch");
			console.log("✅ GetObject (Small) success");
		} catch (e) {
			logError("Basic CRUD failed", e);
		}

		// 3. Binary Data & Larger Single Put (10MB)
		console.log("\n--- 3. Medium Binary Put (10MB) ---");
		const mediumKey = "test-medium.bin";
		const mediumSize = 10 * 1024 * 1024; // 10MB
		const mediumBuffer = generateRandomBuffer(mediumSize);
		try {
			console.time("PutObject 10MB");
			await s3.send(
				new PutObjectCommand({
					Bucket: CONFIG.bucket,
					Key: mediumKey,
					Body: mediumBuffer,
					ContentLength: mediumSize,
				}),
			);
			console.timeEnd("PutObject 10MB");
			console.log("✅ PutObject (10MB) success");

			console.time("GetObject 10MB");
			const getMedium = await s3.send(
				new GetObjectCommand({ Bucket: CONFIG.bucket, Key: mediumKey }),
			);
			const getMediumBuffer = await getMedium.Body?.transformToByteArray();
			console.timeEnd("GetObject 10MB");
			
			if (getMediumBuffer?.length !== mediumSize) {
				throw new Error(`Size mismatch: expected ${mediumSize}, got ${getMediumBuffer?.length}`);
			}
			console.log("✅ GetObject (10MB) success");
		} catch (e) {
			logError("Medium Binary Test failed", e);
		}

		// 4. Multipart Upload (Heavy - 100MB+)
		// Note: Doing full 5GB might be too slow for a quick script run, but we simulate the mechanism.
		// We will do a 50MB upload with 5MB parts (10 parts) to verify the logic thoroughly.
		console.log("\n--- 4. Multipart Upload (50MB in 10 parts) ---");
		const multipartKey = "test-multipart-50mb.bin";
		const partSize = 5 * 1024 * 1024; // 5MB min part size
		const partCount = 10;
		const totalSize = partSize * partCount;
		
		try {
			const createMulti = await s3.send(
				new CreateMultipartUploadCommand({
					Bucket: CONFIG.bucket,
					Key: multipartKey,
				}),
			);
			const uploadId = createMulti.UploadId;
			console.log(`Initialized Upload ID: ${uploadId}`);

			const parts: { PartNumber: number; ETag: string }[] = [];
			
			console.time("Multipart Upload 50MB");
			for (let i = 0; i < partCount; i++) {
				const partNum = i + 1;
				const partBody = generateRandomBuffer(partSize);
				
				// Upload parts in parallel groups if we wanted to be faster, but sequential is safer for tests
				process.stdout.write(`Uploading Part ${partNum}/${partCount}...\r`);
				const uploadPart = await s3.send(
					new UploadPartCommand({
						Bucket: CONFIG.bucket,
						Key: multipartKey,
						UploadId: uploadId,
						PartNumber: partNum,
						Body: partBody,
					}),
				);
				
				if (!uploadPart.ETag) throw new Error(`Part ${partNum} missing ETag`);
				parts.push({ PartNumber: partNum, ETag: uploadPart.ETag });
			}
			console.log("\nAll parts uploaded.");

			const listParts = await s3.send(new ListPartsCommand({
				Bucket: CONFIG.bucket,
				Key: multipartKey,
				UploadId: uploadId
			}));
			if (listParts.Parts?.length !== partCount) throw new Error("ListParts mismatch count");
			console.log("✅ ListParts success");

			await s3.send(
				new CompleteMultipartUploadCommand({
					Bucket: CONFIG.bucket,
					Key: multipartKey,
					UploadId: uploadId,
					MultipartUpload: { Parts: parts },
				}),
			);
			console.timeEnd("Multipart Upload 50MB");
			console.log("✅ CompleteMultipartUpload success");

			// Verify size
			const headMulti = await s3.send(new HeadObjectCommand({
				Bucket: CONFIG.bucket,
				Key: multipartKey
			}));
			if (headMulti.ContentLength !== totalSize) {
				throw new Error(`Multipart size mismatch. Expected ${totalSize}, got ${headMulti.ContentLength}`);
			}
			console.log("✅ Multipart Size Verification success");

		} catch (e) {
			logError("Multipart Upload failed", e);
		}

		// 5. Abort Multipart
		console.log("\n--- 5. Abort Multipart Upload ---");
		const abortKey = "test-abort.bin";
		try {
			const createAbort = await s3.send(
				new CreateMultipartUploadCommand({
					Bucket: CONFIG.bucket,
					Key: abortKey,
				}),
			);
			await s3.send(new UploadPartCommand({
				Bucket: CONFIG.bucket,
				Key: abortKey,
				UploadId: createAbort.UploadId,
				PartNumber: 1,
				Body: generateRandomBuffer(5 * 1024 * 1024)
			}));
			
			// Verify it exists in list
			const listIncomplete = await s3.send(new ListMultipartUploadsCommand({ Bucket: CONFIG.bucket }));
			if (!listIncomplete.Uploads?.some(u => u.UploadId === createAbort.UploadId)) {
				throw new Error("Multipart upload not found in list before abort");
			}

			await s3.send(new AbortMultipartUploadCommand({
				Bucket: CONFIG.bucket,
				Key: abortKey,
				UploadId: createAbort.UploadId
			}));

			// Verify it's gone
			const listAfterAbort = await s3.send(new ListMultipartUploadsCommand({ Bucket: CONFIG.bucket }));
			if (listAfterAbort.Uploads?.some(u => u.UploadId === createAbort.UploadId)) {
				throw new Error("Multipart upload still exists after abort");
			}
			console.log("✅ AbortMultipartUpload success");

		} catch (e) {
			logError("Abort Multipart failed", e);
		}

		// 6. Range Request
		console.log("\n--- 6. Range Requests ---");
		try {
			// Using the medium file
			const rangeGet = await s3.send(new GetObjectCommand({
				Bucket: CONFIG.bucket,
				Key: mediumKey,
				Range: "bytes=0-9"
			}));
			const rangeContent = await rangeGet.Body?.transformToByteArray();
			if (rangeContent?.length !== 10) throw new Error("Range request length mismatch");
			console.log("✅ Range Request (0-9) success");
		} catch (e) {
			logError("Range Request failed", e);
		}

		// 7. Copy Object
		console.log("\n--- 7. Copy Object ---");
		const copyKey = "test-copy.bin";
		try {
			await s3.send(new CopyObjectCommand({
				Bucket: CONFIG.bucket,
				CopySource: `${CONFIG.bucket}/${mediumKey}`,
				Key: copyKey
			}));
			
			const headCopy = await s3.send(new HeadObjectCommand({ Bucket: CONFIG.bucket, Key: copyKey }));
			if (headCopy.ContentLength !== mediumSize) throw new Error("Copy size mismatch");
			console.log("✅ CopyObject success");
		} catch (e) {
			logError("Copy Object failed", e);
		}

		// 8. List Objects V2 Pagination
		console.log("\n--- 8. List Objects Pagination ---");
		try {
			// Create a few files to ensure we have something to list
			for(let i=0; i<5; i++) {
				await s3.send(new PutObjectCommand({
					Bucket: CONFIG.bucket,
					Key: `list-test/file-${i}.txt`,
					Body: `Content ${i}`
				}));
			}

			const list = await s3.send(new ListObjectsV2Command({
				Bucket: CONFIG.bucket,
				Prefix: "list-test/",
				MaxKeys: 2
			}));
			
			if (list.KeyCount !== 2 || !list.IsTruncated) throw new Error("Pagination MaxKeys failed");
			if (!list.NextContinuationToken) throw new Error("Missing NextContinuationToken");

			const list2 = await s3.send(new ListObjectsV2Command({
				Bucket: CONFIG.bucket,
				Prefix: "list-test/",
				ContinuationToken: list.NextContinuationToken
			}));
			
			console.log(`✅ List Pagination success (Found ${list.KeyCount} + ${list2.KeyCount} items)`);
		} catch (e) {
			logError("List Pagination failed", e);
		}

		// 9. Presigned URLs
		console.log("\n--- 9. Presigned URLs ---");
		try {
			const presignKey = "presign-test.txt";
			const putCommand = new PutObjectCommand({ Bucket: CONFIG.bucket, Key: presignKey });
			const putUrl = await getSignedUrl(s3, putCommand, { expiresIn: 3600 });
			
			console.log("Generated Put URL. Uploading...");
			const putRes = await fetch(putUrl, {
				method: "PUT",
				body: "Presigned content"
			});
			if (!putRes.ok) throw new Error(`Presigned PUT failed: ${putRes.status}`);

			const getCommand = new GetObjectCommand({ Bucket: CONFIG.bucket, Key: presignKey });
			const getUrl = await getSignedUrl(s3, getCommand, { expiresIn: 3600 });
			
			console.log("Generated Get URL. Downloading...");
			const getRes = await fetch(getUrl);
			const getText = await getRes.text();
			
			if (getText !== "Presigned content") throw new Error("Presigned content mismatch");
			console.log("✅ Presigned URL PUT/GET success");
		} catch (e) {
			logError("Presigned URL failed", e);
		}

		// 10. Cleanup
		console.log("\n--- 10. Cleanup ---");
		try {
			const keysToDelete = [
				smallKey,
				mediumKey,
				multipartKey,
				copyKey,
				"presign-test.txt",
				"list-test/file-0.txt",
				"list-test/file-1.txt",
				"list-test/file-2.txt",
				"list-test/file-3.txt",
				"list-test/file-4.txt"
			];

			await s3.send(new DeleteObjectsCommand({
				Bucket: CONFIG.bucket,
				Delete: {
					Objects: keysToDelete.map(k => ({ Key: k }))
				}
			}));
			console.log("✅ Cleanup success");
		} catch (e) {
			logError("Cleanup failed", e);
		}

	} catch (e) {
		console.error("\n💥 Fatal Error:", e);
	}

	const duration = (Date.now() - startTime) / 1000;
	console.log(`\n🏁 Test Suite Completed in ${duration.toFixed(2)}s`);
	if (errors.length > 0) {
		console.log(`\n❌ ${errors.length} Tests Failed:`);
		errors.forEach((e) => {
			console.log(`- ${e}`);
		});
		process.exit(1);
	} else {
		console.log("\n✨ All Heavy Tests Passed! ✨");
	}
}

runTest();
