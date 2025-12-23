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

	const endpoint = "https://silo.deployor.dev";

	try {
		// 1. Test Normal Access (Generates Logs)
		console.log("\nTesting Normal Access...");
		const putRes = await s3.fetch(`${endpoint}/${bucketName}/test.txt`, {
			method: "PUT",
			body: "test",
		});
		if (putRes.status !== 200)
			throw new Error(`Normal PUT failed: ${putRes.status}`);
		console.log("✅ Normal Access OK");

		// 2. Test Admin Logs API
		console.log("\nTesting Admin Logs API...");
		const logsRes = await fetch(`${endpoint}/api/admin/logs?limit=10`, {
			headers: {
				Cookie: `silo_user_id=${adminId}`,
			},
		});

		if (logsRes.status !== 200) {
			throw new Error(`Failed to fetch logs: ${logsRes.status}`);
		}

		const logsData = await logsRes.json();
		console.log(`Fetched ${logsData.logs.length} logs`);
		if (logsData.logs.length === 0) {
			console.warn("⚠️ No logs found, but we just made a request!");
		} else {
			const foundLog = logsData.logs.find(
				(l: any) => l.path === `/${bucketName}/test.txt` && l.method === "PUT",
			);
			if (foundLog) {
				console.log("✅ Found expected log entry");
			} else {
				console.warn("⚠️ Did not find the specific log entry we just created");
			}
		}

		// 3. Test Admin Users API (Pagination)
		console.log("\nTesting Admin Users API...");
		const usersRes = await fetch(`${endpoint}/api/admin/users?limit=10`, {
			headers: {
				Cookie: `silo_user_id=${adminId}`,
			},
		});

		if (usersRes.status !== 200) {
			throw new Error(`Failed to fetch users: ${usersRes.status}`);
		}

		const usersData = await usersRes.json();
		console.log(`Fetched ${usersData.users.length} users`);
		if (usersData.users.length < 2) {
			throw new Error("Expected at least 2 users (admin + user)");
		}
		console.log("✅ Users API OK");

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
