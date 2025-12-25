import { AwsClient } from "aws4fetch";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { bucketKeys, buckets, users } from "../src/db/schema";
import { getInternalPath } from "../src/features/s3-api/utils";

async function runAdminCdnTest() {
	console.log("🧪 Starting Admin CDN Integration Test...");

	const adminId = `admin-${Date.now()}`;
	const userId = `user-${Date.now()}`;
	const bucketName = `cdn-test-${Date.now()}`;
	const accessKey = `AKIA${Date.now()}`;
	const secretKey = `secret${Date.now()}`;

	console.log(`Creating admin: ${adminId}`);
	await db.insert(users).values({
		id: adminId,
		email: `${adminId}@example.com`,
		isAdmin: true,
	});

	console.log(`Creating user: ${userId}`);
	await db.insert(users).values({
		id: userId,
		email: `${userId}@example.com`,
		isLocked: false,
	});

	console.log(`Creating CDN bucket: ${bucketName}`);
	const bucket = await db
		.insert(buckets)
		.values({
			name: bucketName,
			userId: userId,
			isPublic: true,
			isCdn: true,
			isPaused: false,
		})
		.returning();

	await db.insert(bucketKeys).values({
		bucketId: bucket[0].id,
		accessKey: accessKey,
		secretKey: secretKey,
		isPaused: false,
	});

	const s3 = new AwsClient({
		accessKeyId: accessKey,
		secretAccessKey: secretKey,
		service: "s3",
		region: "auto",
	});

	const endpoint = "https://silo.deployor.dev";

	try {
		// 1. Upload a file to the CDN bucket (simulating Slack upload)
		console.log("\nUploading file to CDN bucket...");
		const _internalPath = getInternalPath(
			"test.txt",
			{ id: userId } as any,
			bucket[0],
		);
		// We need to use the internal path logic or just upload via S3 client if we had one configured for the test
		// But here we are testing the Admin API, so let's just use the S3 client we created
		// Wait, the S3 client points to the proxy.
		// The proxy handles the path mapping.
		// So we can just upload to /{bucketName}/test.txt

		const putRes = await s3.fetch(`${endpoint}/${bucketName}/test.txt`, {
			method: "PUT",
			body: "test content",
		});

		if (putRes.status !== 200) {
			console.log(await putRes.text());
			throw new Error(`CDN Upload failed: ${putRes.status}`);
		}
		console.log("✅ CDN Upload OK");

		// 2. Try to DELETE the bucket via Admin API (should fail or be blocked if we didn't implement reset)
		// But we implemented "Reset" logic in the DELETE handler for CDN buckets.
		// If we call DELETE /api/admin/buckets/:name, it should fail with 403 unless ?reset=true is passed?
		// Let's check the code in src/features/admin/index.ts
		// It says: if (!isReset) return 403.

		console.log("\nTesting Admin Delete CDN Bucket (without reset)...");
		const deleteRes = await fetch(
			`${endpoint}/api/admin/buckets/${bucketName}`,
			{
				method: "DELETE",
				headers: {
					Cookie: `silo_user_id=${adminId}`,
				},
			},
		);

		if (deleteRes.status !== 403) {
			throw new Error(`Expected 403 for CDN delete, got ${deleteRes.status}`);
		}
		console.log("✅ Admin Delete Blocked OK");

		// 3. Test Admin Reset CDN Bucket
		console.log("\nTesting Admin Reset CDN Bucket...");
		const resetRes = await fetch(
			`${endpoint}/api/admin/buckets/${bucketName}?reset=true`,
			{
				method: "DELETE",
				headers: {
					Cookie: `silo_user_id=${adminId}`,
				},
			},
		);

		if (resetRes.status !== 200) {
			const text = await resetRes.text();
			throw new Error(`Admin Reset failed: ${resetRes.status} - ${text}`);
		}
		console.log("✅ Admin Reset OK");

		// 4. Verify file is gone
		console.log("\nVerifying file is gone...");
		const getRes = await s3.fetch(`${endpoint}/${bucketName}/test.txt`, {
			method: "GET",
		});

		if (getRes.status !== 404) {
			throw new Error(`File still exists after reset: ${getRes.status}`);
		}
		console.log("✅ File Gone OK");

		console.log("\n🎉 All Admin CDN Logic Tests Passed!");
	} catch (error) {
		console.error("\n❌ Test Failed:", error);
	} finally {
		console.log("\nCleaning up...");
		// We need to manually delete the bucket from DB since we can't delete it via API
		// And we need to clean up S3 if the reset failed (but we try to reset in the test)

		// Force delete from DB
		await db.delete(bucketKeys).where(eq(bucketKeys.bucketId, bucket[0].id));
		await db.delete(buckets).where(eq(buckets.id, bucket[0].id));
		await db.delete(users).where(eq(users.id, userId));
		await db.delete(users).where(eq(users.id, adminId));
		process.exit(0);
	}
}

runAdminCdnTest();
