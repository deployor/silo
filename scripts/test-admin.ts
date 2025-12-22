import { AwsClient } from "aws4fetch";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { bucketKeys, buckets, users } from "../src/db/schema";

async function runAdminTest() {
	console.log("🧪 Starting Admin Integration Test...");

	const adminId = `admin-${Date.now()}`;
	const userId = `user-${Date.now()}`;
	const bucketName = `bucket-${Date.now()}`;
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

	console.log(`Creating bucket: ${bucketName}`);
	const bucket = await db
		.insert(buckets)
		.values({
			name: bucketName,
			userId: userId,
			isPublic: false,
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

	const endpoint = "https://cargo.deployor.dev";

	try {
		// 1. Test Normal Access
		console.log("\nTesting Normal Access...");
		const putRes = await s3.fetch(`${endpoint}/${bucketName}/test.txt`, {
			method: "PUT",
			body: "test",
		});
		if (putRes.status !== 200)
			throw new Error(`Normal PUT failed: ${putRes.status}`);
		console.log("✅ Normal Access OK");

		// 2. Test User Lock
		console.log("\nTesting User Lock...");
		await db.update(users).set({ isLocked: true }).where(eq(users.id, userId));
		const lockRes = await s3.fetch(`${endpoint}/${bucketName}/test.txt`);
		if (lockRes.status !== 403)
			throw new Error(`Locked user should be 403, got ${lockRes.status}`);
		console.log("✅ User Lock OK");
		await db.update(users).set({ isLocked: false }).where(eq(users.id, userId));

		// 3. Test Bucket Pause
		console.log("\nTesting Bucket Pause...");
		await db
			.update(buckets)
			.set({ isPaused: true })
			.where(eq(buckets.name, bucketName));
		const pauseRes = await s3.fetch(`${endpoint}/${bucketName}/test.txt`);
		if (pauseRes.status !== 403)
			throw new Error(`Paused bucket should be 403, got ${pauseRes.status}`);
		console.log("✅ Bucket Pause OK");
		await db
			.update(buckets)
			.set({ isPaused: false })
			.where(eq(buckets.name, bucketName));

		// 4. Test Key Pause
		console.log("\nTesting Key Pause...");
		await db
			.update(bucketKeys)
			.set({ isPaused: true })
			.where(eq(bucketKeys.accessKey, accessKey));
		const keyPauseRes = await s3.fetch(`${endpoint}/${bucketName}/test.txt`);
		if (keyPauseRes.status !== 403)
			throw new Error(`Paused key should be 403, got ${keyPauseRes.status}`);
		console.log("✅ Key Pause OK");

		console.log("\n🎉 All Admin Logic Tests Passed!");
	} catch (error) {
		console.error("\n❌ Test Failed:", error);
	} finally {
		console.log("\nCleaning up...");
		await db.delete(buckets).where(eq(buckets.userId, userId));
		await db.delete(users).where(eq(users.id, userId));
		await db.delete(users).where(eq(users.id, adminId));
		process.exit(0);
	}
}

runAdminTest();
