import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { bucketKeys, buckets, users } from "../src/db/schema";
import { config } from "../src/config";

// Mock env for revocation secret if not set (it might be undefined in test env)
// The actual secret on staging is: 799f1b581c2bbb618798078a4caafcaffda6eb6653b322ce831d7bde874106d2
if (!process.env.REVOCATION_SECRET) {
	process.env.REVOCATION_SECRET = "799f1b581c2bbb618798078a4caafcaffda6eb6653b322ce831d7bde874106d2";
	config.revocationSecret = "799f1b581c2bbb618798078a4caafcaffda6eb6653b322ce831d7bde874106d2";
}

async function runRevocationTest() {
	console.log("🧪 Starting Revocation Endpoint Test...");

	const userId = `user-revoke-${Date.now()}`;
	const bucketName = `bucket-revoke-${Date.now()}`;
	const accessKey = `SILO_REVOKE_AK_${Date.now()}`; // Custom format for easy identification
	const secretKey = `secret${Date.now()}`;

	console.log(`Creating user: ${userId}`);
	await db.insert(users).values({
		id: userId,
		email: `${userId}@example.com`,
	});

	console.log(`Creating bucket: ${bucketName}`);
	const bucket = await db
		.insert(buckets)
		.values({
			name: bucketName,
			userId: userId,
			isPublic: false,
		})
		.returning();

	console.log(`Creating key: ${accessKey}`);
	await db.insert(bucketKeys).values({
		bucketId: bucket[0].id,
		accessKey: accessKey,
		secretKey: secretKey,
		source: "dashboard",
	});

	const endpoint = process.env.API_URL || "https://silo.deployor.dev";

	try {
		// 1. Test revocation with invalid token
		console.log("\nTesting with invalid authorization...");
		const invalidAuthRes = await fetch(`${endpoint}/api/revocation`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-token",
			},
			body: JSON.stringify({ accessKey }),
		});

		if (invalidAuthRes.status !== 401 && invalidAuthRes.status !== 403) {
			throw new Error(
				`Expected 401 or 403 for invalid token, got ${invalidAuthRes.status}`,
			);
		}
		console.log("✅ Invalid auth correctly rejected");

		// 2. Test revocation with valid token but non-existent key
		console.log("\nTesting revocation of non-existent key...");
		const notFoundRes = await fetch(`${endpoint}/api/revocation`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `${config.revocationSecret}`,
				Origin: "https://dashboard.hackclub.com", // Try faking origin
			},
			body: JSON.stringify({ accessKey: "NON_EXISTENT_KEY" }),
		});

		if (notFoundRes.status !== 404) {
			throw new Error(
				`Expected 404 for non-existent key, got ${notFoundRes.status}`,
			);
		}
		console.log("✅ Non-existent key correctly returned 404");

		// 3. Test successful revocation
		console.log("\nTesting successful revocation...");
		const successRes = await fetch(`${endpoint}/api/revocation`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `${config.revocationSecret}`,
				Origin: "https://dashboard.hackclub.com", // Try faking origin
			},
			body: JSON.stringify({ accessKey }),
		});

		if (successRes.status !== 200) {
			const text = await successRes.text();
			throw new Error(
				`Failed to revoke key: ${successRes.status} - ${text}`,
			);
		}

		const responseBody = await successRes.json();
		console.log("Response:", responseBody);

		if (
			!responseBody.revoked ||
			responseBody.email !== `${userId}@example.com` ||
			responseBody.keyName !== bucketName
		) {
			throw new Error("Response body did not match expected values");
		}
		console.log("✅ Revocation successful and returned correct details");

		// Verify key is actually gone from DB
		const keyCheck = await db.query.bucketKeys.findFirst({
			where: eq(bucketKeys.accessKey, accessKey),
		});

		if (keyCheck) {
			throw new Error("Key still exists in database after revocation!");
		}
		console.log("✅ Key confirmed deleted from database");
	} catch (error) {
		console.error("\n❌ Test Failed:", error);
		process.exit(1);
	} finally {
		console.log("\nCleaning up...");
		// Cleanup (key should be gone, but bucket and user remain)
		await db.delete(buckets).where(eq(buckets.userId, userId));
		await db.delete(users).where(eq(users.id, userId));
	}
}

runRevocationTest();
