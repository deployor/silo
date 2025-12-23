import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { bucketKeys, buckets, users } from "../src/db/schema";
import { handleS3Request } from "../src/features/s3-api";

const TEST_USER_ID = "test-cors-user";
const TEST_BUCKET_NAME = "test-cors-bucket";
const TEST_ACCESS_KEY = "TESTCORSACCESSKEY";
const TEST_SECRET_KEY = "TESTCORSSECRETKEY";

async function setup() {
	// Clean up
	await db.delete(bucketKeys).where(eq(bucketKeys.accessKey, TEST_ACCESS_KEY));
	await db.delete(buckets).where(eq(buckets.name, TEST_BUCKET_NAME));
	await db.delete(users).where(eq(users.id, TEST_USER_ID));

	// Create User
	await db.insert(users).values({
		id: TEST_USER_ID,
		email: "test-cors@example.com",
		storageLimitBytes: 1024 * 1024 * 100, // 100MB
	});

	// Create Bucket
	const [bucket] = await db
		.insert(buckets)
		.values({
			name: TEST_BUCKET_NAME,
			userId: TEST_USER_ID,
			isPublic: false,
		})
		.returning();

	// Create Key
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

test("CORS: PutBucketCors sets configuration", async () => {
	const bucket = await setup();
	const user = (
		await db.select().from(users).where(eq(users.id, TEST_USER_ID))
	)[0];

	const corsConfig = `
<CORSConfiguration>
 <CORSRule>
   <AllowedOrigin>http://www.example.com</AllowedOrigin>
   <AllowedMethod>PUT</AllowedMethod>
   <AllowedMethod>POST</AllowedMethod>
   <AllowedMethod>DELETE</AllowedMethod>
   <AllowedHeader>*</AllowedHeader>
 </CORSRule>
 <CORSRule>
   <AllowedOrigin>*</AllowedOrigin>
   <AllowedMethod>GET</AllowedMethod>
 </CORSRule>
</CORSConfiguration>
`;

	const req = new Request(
		`https://silo.deployor.dev/${TEST_BUCKET_NAME}?cors`,
		{
			method: "PUT",
			body: corsConfig,
		},
	);

	const res = await handleS3Request(req, user, bucket, "authenticated");
	expect(res.status).toBe(200);

	// Verify DB
	const [updatedBucket] = await db
		.select()
		.from(buckets)
		.where(eq(buckets.id, bucket.id));
	expect(updatedBucket.corsConfig).toBeTruthy();
	const parsed = JSON.parse(updatedBucket.corsConfig!);
	expect(parsed.CORSRules.length).toBe(2);
	expect(parsed.CORSRules[0].AllowedOrigins).toEqual(["http://www.example.com"]);

	await teardown();
});

test("CORS: GetBucketCors retrieves configuration", async () => {
	const bucket = await setup();
	const user = (
		await db.select().from(users).where(eq(users.id, TEST_USER_ID))
	)[0];

	// Set initial config
	const initialConfig = {
		CORSRules: [
			{
				AllowedOrigins: ["*"],
				AllowedMethods: ["GET"],
			},
		],
	};
	await db
		.update(buckets)
		.set({ corsConfig: JSON.stringify(initialConfig) })
		.where(eq(buckets.id, bucket.id));

	// Fetch updated bucket object
	const [updatedBucket] = await db
		.select()
		.from(buckets)
		.where(eq(buckets.id, bucket.id));

	const req = new Request(
		`https://silo.deployor.dev/${TEST_BUCKET_NAME}?cors`,
		{
			method: "GET",
		},
	);

	const res = await handleS3Request(req, user, updatedBucket, "authenticated");
	expect(res.status).toBe(200);
	const text = await res.text();
	expect(text).toContain("<CORSConfiguration");
	expect(text).toContain("<AllowedOrigin>*</AllowedOrigin>");
	expect(text).toContain("<AllowedMethod>GET</AllowedMethod>");

	await teardown();
});

test("CORS: DeleteBucketCors removes configuration", async () => {
	const bucket = await setup();
	const user = (
		await db.select().from(users).where(eq(users.id, TEST_USER_ID))
	)[0];

	// Set initial config
	await db
		.update(buckets)
		.set({ corsConfig: '{"CORSRules":[]}' })
		.where(eq(buckets.id, bucket.id));

	const req = new Request(
		`https://silo.deployor.dev/${TEST_BUCKET_NAME}?cors`,
		{
			method: "DELETE",
		},
	);

	const res = await handleS3Request(req, user, bucket, "authenticated");
	expect(res.status).toBe(204);

	// Verify DB
	const [updatedBucket] = await db
		.select()
		.from(buckets)
		.where(eq(buckets.id, bucket.id));
	expect(updatedBucket.corsConfig).toBeNull();

	await teardown();
});

test("CORS: OPTIONS Preflight check", async () => {
	const bucket = await setup();
	const user = (
		await db.select().from(users).where(eq(users.id, TEST_USER_ID))
	)[0];

	// Set config
	const config = {
		CORSRules: [
			{
				AllowedOrigins: ["http://example.com"],
				AllowedMethods: ["PUT"],
				AllowedHeaders: ["x-custom-header"],
				MaxAgeSeconds: 3000,
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

	// Valid Preflight
	const req = new Request(`https://silo.deployor.dev/${TEST_BUCKET_NAME}/file.txt`, {
		method: "OPTIONS",
		headers: {
			Origin: "http://example.com",
			"Access-Control-Request-Method": "PUT",
			"Access-Control-Request-Headers": "x-custom-header",
		},
	});

	const res = await handleS3Request(req, user, updatedBucket, "public"); 

	expect(res.status).toBe(200);
	expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
		"http://example.com",
	);
	expect(res.headers.get("Access-Control-Allow-Methods")).toBe("PUT");
	expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
		"x-custom-header",
	);

	// Invalid Origin
	const reqInvalid = new Request(
		`https://silo.deployor.dev/${TEST_BUCKET_NAME}/file.txt`,
		{
			method: "OPTIONS",
			headers: {
				Origin: "http://evil.com",
				"Access-Control-Request-Method": "PUT",
			},
		},
	);
	const resInvalid = await handleS3Request(
		reqInvalid,
		user,
		updatedBucket,
		"public",
	);
	expect(resInvalid.status).toBe(403);

	// Invalid Method
	const reqInvalidMethod = new Request(
		`https://silo.deployor.dev/${TEST_BUCKET_NAME}/file.txt`,
		{
			method: "OPTIONS",
			headers: {
				Origin: "http://example.com",
				"Access-Control-Request-Method": "DELETE", // Not allowed
			},
		},
	);
	const resInvalidMethod = await handleS3Request(
		reqInvalidMethod,
		user,
		updatedBucket,
		"public",
	);
	expect(resInvalidMethod.status).toBe(403);

	await teardown();
});

test("CORS: Security - No Config returns 403 for OPTIONS", async () => {
	const bucket = await setup();
	const user = (
		await db.select().from(users).where(eq(users.id, TEST_USER_ID))
	)[0];

	// Ensure no config
	await db
		.update(buckets)
		.set({ corsConfig: null })
		.where(eq(buckets.id, bucket.id));
	
	const [updatedBucket] = await db
		.select()
		.from(buckets)
		.where(eq(buckets.id, bucket.id));

	const req = new Request(`https://silo.deployor.dev/${TEST_BUCKET_NAME}/file.txt`, {
		method: "OPTIONS",
		headers: {
			Origin: "http://example.com",
			"Access-Control-Request-Method": "GET",
		},
	});

	const res = await handleS3Request(req, user, updatedBucket, "public");
	expect(res.status).toBe(403);

	await teardown();
});
