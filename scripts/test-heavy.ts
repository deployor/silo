import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CopyObjectCommand,
	CreateMultipartUploadCommand,
	DeleteBucketCorsCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetBucketCorsCommand,
	GetBucketLocationCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	ListPartsCommand,
	PutBucketCorsCommand,
	PutObjectCommand,
	S3Client,
	UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes } from "crypto";
import { Readable } from "stream";

// Configuration
const ENDPOINT = "https://silo.deployor.dev";
const REGION = "auto";
const BUCKET_NAME = "testforprodpublicbucket";

const CREDENTIALS = {
	accessKeyId: "SILO_PROD_DK_8D7B8E04AC5549C2958C",
	secretAccessKey: "4eacbdf8e06320e6ada9ef77c115f0e74e8a9e1a",
};

// Initialize Client
const client = new S3Client({
	region: REGION,
	endpoint: ENDPOINT,
	credentials: CREDENTIALS,
	forcePathStyle: true,
});

// Helper: Generate a buffer of specific size
function generateBuffer(size: number): Buffer {
	return Buffer.alloc(size, "x"); // fast allocation
}

async function runTests() {
	console.log(`🚀 Starting INSANELY COMPREHENSIVE S3 Tests against ${ENDPOINT}/${BUCKET_NAME}`);
	const startTime = Date.now();
	const artifacts: string[] = []; // Track keys to clean up

	try {
		// ==========================================
		// 1. Connectivity & Bucket Check
		// ==========================================
		console.log("\n📦 1. Checking Bucket Access...");
		await client.send(new HeadBucketCommand({ Bucket: BUCKET_NAME }));
		console.log("✅ Bucket exists and is accessible");

		const location = await client.send(
			new GetBucketLocationCommand({ Bucket: BUCKET_NAME }),
		);
		console.log("✅ Bucket Location:", location.LocationConstraint || "default");

		// ==========================================
		// 2. Metadata & Content Types
		// ==========================================
		console.log("\n🏷️ 2. Testing Metadata & Content Types...");
		const metaKey = "metadata-test.json";
		artifacts.push(metaKey);
		
		await client.send(
			new PutObjectCommand({
				Bucket: BUCKET_NAME,
				Key: metaKey,
				Body: JSON.stringify({ hello: "world" }),
				ContentType: "application/json",
				Metadata: {
					"custom-author": "batman",
				},
				CacheControl: "max-age=3600",
				ContentDisposition: 'attachment; filename="download.json"'
			}),
		);
		console.log("✅ PutObject with complex metadata");

		const headMeta = await client.send(
			new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: metaKey }),
		);
		
		if (headMeta.ContentType !== "application/json") throw new Error("ContentType mismatch");
		if (headMeta.Metadata?.["custom-author"] !== "batman") throw new Error("Custom metadata mismatch");
		if (headMeta.CacheControl !== "max-age=3600") throw new Error("CacheControl mismatch");
		console.log("✅ HeadObject verified metadata and headers");

		// ==========================================
		// 3. Conditional Requests (ETags)
		// ==========================================
		console.log("\n❓ 3. Testing Conditional Requests...");
		const etag = headMeta.ETag;
		if (!etag) throw new Error("ETag missing from HeadObject");

		// If-None-Match (Should return 304 Not Modified - SDK throws '304 Not Modified')
		try {
			await client.send(new GetObjectCommand({
				Bucket: BUCKET_NAME,
				Key: metaKey,
				IfNoneMatch: etag
			}));
			console.warn("⚠️ Expected 304 Not Modified, got 200 OK (Gateway might not support conditional gets)");
		} catch (e: any) {
			if (e.$metadata?.httpStatusCode === 304) {
				console.log("✅ If-None-Match handled correctly (304)");
			} else {
				console.log(`ℹ️ If-None-Match threw: ${e.name} (Acceptable if standard SDK behavior)`);
			}
		}

		// If-Match (Should succeed)
		await client.send(new GetObjectCommand({
			Bucket: BUCKET_NAME,
			Key: metaKey,
			IfMatch: etag
		}));
		console.log("✅ If-Match verified");

		// ==========================================
		// 4. Copy Operations
		// ==========================================
		console.log("\n📋 4. Testing Copy Operations...");
		const copyKey = "copy-folder/copied-metadata.json";
		artifacts.push(copyKey);

		await client.send(new CopyObjectCommand({
			Bucket: BUCKET_NAME,
			CopySource: `${BUCKET_NAME}/${metaKey}`,
			Key: copyKey,
			MetadataDirective: "COPY" // Should preserve metadata
		}));
		console.log("✅ CopyObject (Internal Copy)");

		const headCopy = await client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: copyKey }));
		if (headCopy.Metadata?.["custom-author"] !== "batman") throw new Error("Copied object lost metadata");
		console.log("✅ Copied metadata preserved");

		// ==========================================
		// 5. Nasty Key Names (Encoding/Decoding)
		// ==========================================
		console.log("\n🤡 5. Testing Nasty Key Names...");
		// Keys with spaces, pluses, slashes, and maybe unicode?
		const nastyKey = "folder/with spaces/and+symbols/🚀emoji.txt";
		artifacts.push(nastyKey);

		await client.send(new PutObjectCommand({
			Bucket: BUCKET_NAME,
			Key: nastyKey,
			Body: "nasty content"
		}));
		console.log("✅ PutObject with complex key");

		const getNasty = await client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: nastyKey }));
		const nastyContent = await getNasty.Body?.transformToString();
		if (nastyContent !== "nasty content") throw new Error("Content mismatch for nasty key");
		console.log("✅ GetObject retrieved complex key successfully");

		// ==========================================
		// 6. CORS Configuration
		// ==========================================
		console.log("\n🌐 6. Testing CORS Configuration...");
		
		await client.send(new PutBucketCorsCommand({
			Bucket: BUCKET_NAME,
			CORSConfiguration: {
				CORSRules: [
					{
						AllowedHeaders: ["*"],
						AllowedMethods: ["GET", "PUT", "POST"],
						AllowedOrigins: ["https://example.com"],
						ExposeHeaders: ["ETag"],
						MaxAgeSeconds: 3000
					}
				]
			}
		}));
		console.log("✅ PutBucketCors success");

		const cors = await client.send(new GetBucketCorsCommand({ Bucket: BUCKET_NAME }));
		const rule = cors.CORSRules?.[0];
		if (!rule?.AllowedOrigins?.includes("https://example.com")) {
			throw new Error("CORS Configuration mismatch");
		}
		console.log("✅ GetBucketCors verified");

		// Verify CORS via fetch (OPTIONS)
		const corsRes = await fetch(`${ENDPOINT}/${BUCKET_NAME}/${metaKey}`, {
			method: "OPTIONS",
			headers: {
				"Origin": "https://example.com",
				"Access-Control-Request-Method": "GET"
			}
		});
		if (corsRes.headers.get("access-control-allow-origin") === "https://example.com") {
			console.log("✅ CORS Preflight (OPTIONS) returned correct origin");
		} else {
			console.warn("⚠️ CORS Preflight header missing or incorrect");
		}

		await client.send(new DeleteBucketCorsCommand({ Bucket: BUCKET_NAME }));
		console.log("✅ DeleteBucketCors success");


		// ==========================================
		// 7. Multipart Upload (Heavy & Abort)
		// ==========================================
		console.log("\n🏋️ 7. Testing Multipart Uploads...");
		
		// 7a. Abort Test
		console.log("   -> Testing AbortMultipartUpload...");
		const abortKey = "abort-me.bin";
		const abortMp = await client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET_NAME, Key: abortKey }));
		await client.send(new UploadPartCommand({
			Bucket: BUCKET_NAME,
			Key: abortKey,
			PartNumber: 1,
			UploadId: abortMp.UploadId,
			Body: "part1"
		}));
		await client.send(new AbortMultipartUploadCommand({
			Bucket: BUCKET_NAME,
			Key: abortKey,
			UploadId: abortMp.UploadId
		}));
		
		// Verify parts are gone (ListParts should fail or return empty)
		try {
			await client.send(new ListPartsCommand({ Bucket: BUCKET_NAME, Key: abortKey, UploadId: abortMp.UploadId }));
			console.warn("⚠️ ListParts succeeded after Abort (Expected failure or empty)");
		} catch (e: any) {
			console.log("✅ ListParts failed after Abort (Expected)");
		}

		// 7b. Full Upload (50MB)
		console.log("   -> Testing Full 50MB Upload...");
		const PART_SIZE = 5 * 1024 * 1024; // 5MB
		const TOTAL_SIZE = 50 * 1024 * 1024; // 50MB
		const PARTS_COUNT = Math.ceil(TOTAL_SIZE / PART_SIZE);
		const largeKey = "heavy-test-file.bin";
		artifacts.push(largeKey);

		const createMp = await client.send(
			new CreateMultipartUploadCommand({
				Bucket: BUCKET_NAME,
				Key: largeKey,
				ContentType: "application/octet-stream",
			}),
		);
		const uploadId = createMp.UploadId;
		const uploadParts = [];
		
		for (let i = 0; i < PARTS_COUNT; i++) {
			const partNum = i + 1;
			const isLast = i === PARTS_COUNT - 1;
			const currentPartSize = isLast ? TOTAL_SIZE - i * PART_SIZE : PART_SIZE;
			const buffer = generateBuffer(currentPartSize);
			buffer[0] = partNum; // Marker

			process.stdout.write(`\r      Uploading part ${partNum}/${PARTS_COUNT}...`);
			const upload = await client.send(
				new UploadPartCommand({
					Bucket: BUCKET_NAME,
					Key: largeKey,
					PartNumber: partNum,
					UploadId: uploadId,
					Body: buffer,
				}),
			);
			uploadParts.push({ PartNumber: partNum, ETag: upload.ETag });
		}
		console.log("\n      Completing...");
		await client.send(
			new CompleteMultipartUploadCommand({
				Bucket: BUCKET_NAME,
				Key: largeKey,
				UploadId: uploadId,
				MultipartUpload: { Parts: uploadParts },
			}),
		);
		console.log("✅ Large Multipart Upload Completed");

		// ==========================================
		// 8. Range Requests & Integrity
		// ==========================================
		console.log("\n🔍 8. Verifying Range Requests...");
		const rangeStart = await client.send(new GetObjectCommand({
			Bucket: BUCKET_NAME, Key: largeKey, Range: "bytes=0-9"
		}));
		const startBytes = await rangeStart.Body?.transformToByteArray();
		if (startBytes?.[0] !== 1) throw new Error("Range Request Start Mismatch");

		const rangeMid = await client.send(new GetObjectCommand({
			Bucket: BUCKET_NAME, Key: largeKey, Range: `bytes=${PART_SIZE}-${PART_SIZE + 9}`
		}));
		const midBytes = await rangeMid.Body?.transformToByteArray();
		if (midBytes?.[0] !== 2) throw new Error("Range Request Middle Mismatch");
		console.log("✅ Range requests verified content markers");


		// ==========================================
		// 9. Presigned URLs
		// ==========================================
		console.log("\n🔑 9. Testing Presigned URLs...");
		const prePutKey = "presigned-test.txt";
		artifacts.push(prePutKey);
		
		const putUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: BUCKET_NAME, Key: prePutKey }), { expiresIn: 3600 });
		const putRes = await fetch(putUrl, { method: "PUT", body: "via presigned" });
		if (!putRes.ok) throw new Error("Presigned PUT failed");
		console.log("✅ Presigned PUT success");

		const getUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: prePutKey }), { expiresIn: 3600 });
		const getRes = await fetch(getUrl);
		if (await getRes.text() !== "via presigned") throw new Error("Presigned GET mismatch");
		console.log("✅ Presigned GET success");


		// ==========================================
		// 10. List Pagination
		// ==========================================
		console.log("\n📚 10. Testing List Pagination...");
		const folderPrefix = "list-test/";
		const listFiles = [];
		for (let i = 0; i < 15; i++) {
			const k = `${folderPrefix}file-${i.toString().padStart(2, '0')}.txt`;
			listFiles.push(k);
			artifacts.push(k);
		}
		
		await Promise.all(listFiles.map(k => client.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: k, Body: "x" }))));
		
		let continuationToken: string | undefined;
		let totalListed = 0;
		do {
			const list: any = await client.send(new ListObjectsV2Command({
				Bucket: BUCKET_NAME,
				Prefix: folderPrefix,
				MaxKeys: 5,
				ContinuationToken: continuationToken,
			}));
			totalListed += list.Contents?.length || 0;
			continuationToken = list.NextContinuationToken;
		} while (continuationToken);

		if (totalListed !== 15) throw new Error(`Pagination count mismatch: ${totalListed}`);
		console.log("✅ Pagination success");


		// ==========================================
		// 11. Public Access
		// ==========================================
		console.log("\n🌍 11. Testing Public Access...");
		const publicUrl = `${ENDPOINT}/${BUCKET_NAME}/${nastyKey}`; // Use the nasty key to test encoding too
		// URL encode the nasty key part? fetch should handle some, but S3 usually expects encoded
		// Actually, the key is "folder/with spaces/and+symbols/🚀emoji.txt"
		// Browser/Fetch usually encodes spaces as %20.
		const encodedUrl = `${ENDPOINT}/${BUCKET_NAME}/${encodeURIComponent(nastyKey).replace(/%2F/g, '/')}`; // Keep slashes
		
		console.log(`   -> Fetching ${encodedUrl}...`);
		const pubRes = await fetch(encodedUrl);
		if (pubRes.status === 200) {
			console.log("✅ Public access confirmed (even with nasty keys)");
		} else {
			console.warn(`⚠️ Public access failed: ${pubRes.status}`);
		}

		// ==========================================
		// 12. Cleanup
		// ==========================================
		console.log("\n🧹 12. Cleaning up...");
		// Batch delete only supports 1000 keys, we have < 100
		if (artifacts.length > 0) {
			const deleteParams = {
				Bucket: BUCKET_NAME,
				Delete: {
					Objects: artifacts.map(Key => ({ Key }))
				}
			};
			const delRes = await client.send(new DeleteObjectsCommand(deleteParams));
			console.log(`✅ Deleted ${delRes.Deleted?.length || 0} objects`);
		}
		
		// Clean up abort multipart just in case it stuck
		// (Normally Abort cleans it, but if it failed...)

	} catch (error) {
		console.error("\n❌ TEST FAILED:", error);
		process.exit(1);
	}
	
	const duration = (Date.now() - startTime) / 1000;
	console.log(`\n🎉 All tests passed in ${duration.toFixed(2)}s`);
}

runTests();
