import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { bucketKeys, buckets, users } from "../src/db/schema";
import { handleS3Request } from "../src/features/s3-api";

const TEST_USER_ID = "cors-header-user";
const TEST_BUCKET_NAME = "cors-header-bucket";
const TEST_ACCESS_KEY = "CORSHEADERACCESS";
const TEST_SECRET_KEY = "CORSHEADERSECRET";

async function setup() {
	await db.delete(bucketKeys).where(eq(bucketKeys.accessKey, TEST_ACCESS_KEY));
	await db.delete(buckets).where(eq(buckets.name, TEST_BUCKET_NAME));
	await db.delete(users).where(eq(users.id, TEST_USER_ID));

	await db.insert(users).values({
		id: TEST_USER_ID,
		email: "cors-header@example.com",
	});

	const [bucket] = await db
		.insert(buckets)
		.values({
			name: TEST_BUCKET_NAME,
			userId: TEST_USER_ID,
			isPublic: true, // Make it public for easier GET testing
		})
		.returning();

	await db.insert(bucketKeys).values({
		bucketId: bucket.id,
		accessKey: TEST_ACCESS_KEY,
		secretKey: TEST_SECRET_KEY,
	});

	return bucket;
}

async function teardown() {
	await db.delete(bucketKeys).where(eq(bucketKeys.accessKey, TEST_ACCESS_KEY));
	await db.delete(buckets).where(eq(buckets.name, TEST_BUCKET_NAME));
	await db.delete(users).where(eq(users.id, TEST_USER_ID));
}

test("CORS: GET request includes CORS headers", async () => {
	const bucket = await setup();
	const user = (
		await db.select().from(users).where(eq(users.id, TEST_USER_ID))
	)[0];

	// Set CORS config
	const config = {
		CORSRules: [
			{
				AllowedOrigins: ["http://example.com"],
				AllowedMethods: ["GET"],
				AllowedHeaders: ["*"],
				ExposeHeaders: ["x-amz-meta-custom"],
			},
		],
	};
	await db
		.update(buckets)
		.set({ corsConfig: JSON.stringify(config) })
		.where(eq(buckets.id, bucket.id));

	// Fetch updated bucket
	const [updatedBucket] = await db
		.select()
		.from(buckets)
		.where(eq(buckets.id, bucket.id));

	const req = new Request(
		`https://silo.deployor.dev/${TEST_BUCKET_NAME}/file.txt`,
		{
			method: "GET",
			headers: {
				Origin: "http://example.com",
			},
		},
	);

	const res = await handleS3Request(req, user, updatedBucket, "public");

	expect(res.status).toBe(404); // 404 is fine, we just want headers (upstream 404)
	// Note: If upstream returns 404, we still want CORS headers so the browser can see the 404!

	expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
		"http://example.com",
	);
	expect(res.headers.get("Access-Control-Expose-Headers")).toContain(
		"x-amz-meta-custom",
	);
	expect(res.headers.get("Vary")).toContain("Origin");

	await teardown();
});
