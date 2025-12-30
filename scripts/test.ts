import { AwsClient } from "aws4fetch";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import { buckets, requestLogs, users } from "../src/db/schema";

async function runTest() {
	console.log("🧪 Starting Integration Test...");

	const testUserId = `test-user-${Date.now()}`;
	const testBucketName = `test-bucket-${Date.now()}`;
	const accessKey = `AKIA${Date.now()}`;
	const secretKey = `secret${Date.now()}`;

	console.log(`Creating test user: ${testUserId}`);
	await db.insert(users).values({
		id: testUserId,
		email: `${testUserId}@example.com`,
		storageLimitBytes: 1024 * 1024 * 100,
	});

	console.log(`Creating test bucket: ${testBucketName}`);
	await db.insert(buckets).values({
		name: testBucketName,
		userId: testUserId,
		accessKey: accessKey,
		secretKey: secretKey,
		isPublic: false,
	});

	const s3 = new AwsClient({
		accessKeyId: accessKey,
		secretAccessKey: secretKey,
		service: "s3",
		region: "auto",
	});

	const endpoint = "http://localhost:3000";

	try {
		console.log("\nTesting PUT Object...");
		const putRes = await s3.fetch(`${endpoint}/${testBucketName}/hello.txt`, {
			method: "PUT",
			body: "Hello World!",
		});

		if (putRes.status !== 200) {
			throw new Error(
				`PUT failed with status ${putRes.status}: ${await putRes.text()}`,
			);
		}
		console.log("✅ PUT Object success");

		console.log("\nTesting GET Object...");
		const getRes = await s3.fetch(`${endpoint}/${testBucketName}/hello.txt`);

		if (getRes.status !== 200) {
			throw new Error(
				`GET failed with status ${getRes.status}: ${await getRes.text()}`,
			);
		}
		const content = await getRes.text();
		if (content !== "Hello World!") {
			throw new Error(
				`GET content mismatch. Expected 'Hello World!', got '${content}'`,
			);
		}
		console.log("✅ GET Object success");

		console.log("\nTesting List Objects...");
		const listRes = await s3.fetch(
			`${endpoint}/${testBucketName}/?list-type=2`,
		);

		if (listRes.status !== 200) {
			throw new Error(
				`LIST failed with status ${listRes.status}: ${await listRes.text()}`,
			);
		}
		const xml = await listRes.text();
		if (!xml.includes("hello.txt")) {
			throw new Error("LIST response missing hello.txt");
		}
		console.log("✅ List Objects success");

		console.log("\nTesting DELETE Object...");
		const delRes = await s3.fetch(`${endpoint}/${testBucketName}/hello.txt`, {
			method: "DELETE",
		});

		if (delRes.status !== 204 && delRes.status !== 200) {
			throw new Error(
				`DELETE failed with status ${delRes.status}: ${await delRes.text()}`,
			);
		}
		console.log("✅ DELETE Object success");

		console.log("\nTesting Public Bucket...");
		const publicBucketName = `public-bucket-${Date.now()}`;
		console.log(`Creating public bucket: ${publicBucketName}`);
		await db.insert(buckets).values({
			name: publicBucketName,
			userId: testUserId,
			accessKey: `AKIA_PUB_${Date.now()}`,
			secretKey: `secret_pub_${Date.now()}`,
			isPublic: true,
		});

		console.log("Updating test bucket to be public...");
		await db
			.update(buckets)
			.set({ isPublic: true })
			.where(eq(buckets.name, testBucketName));

		console.log("Restoring hello.txt...");
		await s3.fetch(`${endpoint}/${testBucketName}/hello.txt`, {
			method: "PUT",
			body: "Hello Public World!",
		});

		const anonGetRes = await fetch(`${endpoint}/${testBucketName}/hello.txt`);
		if (anonGetRes.status !== 200) {
			throw new Error(`Anonymous GET failed with status ${anonGetRes.status}`);
		}
		const publicContent = await anonGetRes.text();
		if (publicContent !== "Hello Public World!") {
			throw new Error(`Anonymous GET content mismatch.`);
		}
		console.log("✅ Anonymous GET success");

		console.log("Testing Anonymous PUT (Should Fail)...");
		const anonPutRes = await fetch(`${endpoint}/${testBucketName}/public.txt`, {
			method: "PUT",
			body: "Should fail",
		});
		if (anonPutRes.status !== 403) {
			throw new Error(
				`Anonymous PUT should have failed with 403, got ${anonPutRes.status}`,
			);
		}
		console.log("✅ Anonymous PUT correctly denied");

		console.log("\nTesting Forbidden Management Calls...");
		const forbiddenRes = await s3.fetch(
			`${endpoint}/${testBucketName}?policy`,
			{
				method: "GET",
			},
		);
		if (forbiddenRes.status !== 501) {
			throw new Error(
				`Forbidden call should have failed with 501, got ${forbiddenRes.status}`,
			);
		}
		console.log("✅ Forbidden call correctly denied");

		console.log("\nTesting GetBucketLocation...");
		const locRes = await s3.fetch(`${endpoint}/${testBucketName}?location`);
		if (locRes.status !== 200) {
			throw new Error(`GetBucketLocation failed with status ${locRes.status}`);
		}
		const locXml = await locRes.text();
		if (!locXml.includes("eu-central-1")) {
			throw new Error("GetBucketLocation response missing eu-central-1");
		}
		console.log("✅ GetBucketLocation success");

		console.log("\nTesting Multipart Upload Flow...");
		const initRes = await s3.fetch(
			`${endpoint}/${testBucketName}/multipart.txt?uploads`,
			{
				method: "POST",
			},
		);
		if (initRes.status !== 200) {
			throw new Error(
				`Initiate Multipart failed with status ${initRes.status}`,
			);
		}
		const initXml = await initRes.text();
		const uploadIdMatch = initXml.match(/<UploadId>(.*?)<\/UploadId>/);
		if (!uploadIdMatch) {
			throw new Error("Initiate Multipart response missing UploadId");
		}
		const uploadId = uploadIdMatch[1];
		console.log(`Initiated Multipart Upload: ${uploadId}`);

		const part1Res = await s3.fetch(
			`${endpoint}/${testBucketName}/multipart.txt?partNumber=1&uploadId=${uploadId}`,
			{
				method: "PUT",
				body: "Part 1 Data",
			},
		);
		if (part1Res.status !== 200) {
			throw new Error(`Upload Part 1 failed with status ${part1Res.status}`);
		}
		const etag1 = part1Res.headers.get("ETag");
		console.log("Uploaded Part 1");

		const completeBody = `
    <CompleteMultipartUpload>
        <Part>
            <PartNumber>1</PartNumber>
            <ETag>${etag1}</ETag>
        </Part>
    </CompleteMultipartUpload>
    `;
		const completeRes = await s3.fetch(
			`${endpoint}/${testBucketName}/multipart.txt?uploadId=${uploadId}`,
			{
				method: "POST",
				body: completeBody,
			},
		);
		if (completeRes.status !== 200) {
			throw new Error(
				`Complete Multipart failed with status ${completeRes.status}: ${await completeRes.text()}`,
			);
		}
		console.log("✅ Multipart Upload success");

		console.log("\nTesting CopyObject...");
		const copyRes = await s3.fetch(`${endpoint}/${testBucketName}/copy.txt`, {
			method: "PUT",
			headers: {
				"x-amz-copy-source": `/${testBucketName}/multipart.txt`,
			},
		});
		if (copyRes.status !== 200) {
			throw new Error(
				`CopyObject failed with status ${copyRes.status}: ${await copyRes.text()}`,
			);
		}
		console.log("✅ CopyObject success");

		console.log("\nTesting DeleteObjects...");
		const deleteBody = `
    <Delete>
        <Object>
            <Key>multipart.txt</Key>
        </Object>
        <Object>
            <Key>copy.txt</Key>
        </Object>
    </Delete>
    `;
		const bulkDelRes = await s3.fetch(`${endpoint}/${testBucketName}?delete`, {
			method: "POST",
			body: deleteBody,
		});
		if (bulkDelRes.status !== 200) {
			throw new Error(
				`DeleteObjects failed with status ${bulkDelRes.status}: ${await bulkDelRes.text()}`,
			);
		}
		console.log("✅ DeleteObjects success");

		console.log("\nTesting Presigned URL (Simulation)...");
		const presignedUrl = new URL(`${endpoint}/${testBucketName}/hello.txt`);
		presignedUrl.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
		presignedUrl.searchParams.set(
			"X-Amz-Credential",
			`${accessKey}/20251220/auto/s3/aws4_request`,
		);
		presignedUrl.searchParams.set("X-Amz-Date", "20251220T000000Z");
		presignedUrl.searchParams.set("X-Amz-Expires", "3600");
		presignedUrl.searchParams.set("X-Amz-SignedHeaders", "host");
		presignedUrl.searchParams.set("X-Amz-Signature", "simulated_signature");

		const presignedRes = await fetch(presignedUrl.toString());
		if (presignedRes.status !== 200) {
			throw new Error(
				`Presigned URL request failed with status ${presignedRes.status}`,
			);
		}
		console.log("✅ Presigned URL success");

		// Wait for logs to flush (batch size 100 or 5s interval)
		console.log("\nWaiting for logs to flush...");
		await new Promise((resolve) => setTimeout(resolve, 6000));

		const logs = await db
			.select({ count: sql<number>`count(*)` })
			.from(requestLogs)
			.where(eq(requestLogs.ownerId, testUserId));

		const logCount = Number(logs[0].count);
		console.log(`Found ${logCount} logs for test user`);

		if (logCount === 0) {
			throw new Error("No request logs found! Logging middleware might be broken.");
		}
		console.log("✅ Request logging verified");

		console.log("\n🎉 All tests passed!");
	} catch (error) {
		console.error("\n❌ Test Failed:", error);
	} finally {
		console.log("\nCleaning up...");
		await db.delete(buckets).where(eq(buckets.userId, testUserId));
		await db.delete(users).where(eq(users.id, testUserId));
		process.exit(0);
	}
}

runTest();
