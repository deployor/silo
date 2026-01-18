import { count, eq } from "drizzle-orm";
import { db } from "../db";
import { bucketKeys, buckets } from "../db/schema";
import { getAppSettings } from "./settings-service";

export async function createKey(
	bucketId: string,
	source: "dashboard" | "slack" = "dashboard",
) {
	const settings = await getAppSettings();
	const maxKeys = settings.defaultMaxKeysPerBucket;

	const existingCount = await db
		.select({ count: count() })
		.from(bucketKeys)
		.where(eq(bucketKeys.bucketId, bucketId));

	if ((existingCount[0]?.count ?? 0) >= maxKeys) {
		throw new Error(
			`Key limit reached (${maxKeys}). Delete an existing key to create a new one.`,
		);
	}

	const envPrefix =
		process.env.NODE_ENV === "production" ? "SILO_PROD" : "SILO_DEV";
	const sourcePrefix = source === "dashboard" ? "DK" : "SK"; // DK = Dashboard Key, SK = Slack Key

	const randomPart = Array.from(
		crypto.getRandomValues(new Uint8Array(10)),
		(b) => b.toString(16).padStart(2, "0"),
	)
		.join("")
		.toUpperCase();

	// Format: SILO_PROD_DK_7F3A9B...
	const accessKey = `${envPrefix}_${sourcePrefix}_${randomPart}`;

	const secretKey = Array.from(
		crypto.getRandomValues(new Uint8Array(20)),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");

	await db.insert(bucketKeys).values({
		bucketId,
		accessKey,
		secretKey,
	});

	return { accessKey, secretKey };
}

export async function deleteKey(
	keyId: string,
	bucketName: string,
	userId: string,
	isAdmin = false,
) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);

	if (bucket.length === 0) throw new Error("Bucket not found");
	if (bucket[0].userId !== userId && !isAdmin) throw new Error("Unauthorized");
	if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
	if (bucket[0].isCdn) throw new Error("Cannot delete keys for CDN bucket");

	await db.delete(bucketKeys).where(eq(bucketKeys.id, keyId));
}

export const KeyService = {
	createKey,
	deleteKey,
};
