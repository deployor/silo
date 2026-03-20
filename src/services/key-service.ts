import { count, eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { bucketKeys, buckets, type users } from "../db/schema";
import { getAppSettings } from "./settings-service";

export async function createKey(
	bucketId: string,
	source: "dashboard" | "slack" = "dashboard",
	note?: string | null,
) {
	const settings = await getAppSettings();
	const maxKeys = settings.defaultMaxKeysPerBucket;

	// Check owner of bucket for immortality
	const bucket = await db.query.buckets.findFirst({
		where: eq(buckets.id, bucketId),
		with: {
			user: true,
		},
	});

	if (!bucket) throw new Error("Bucket not found");

	// Relation user is fetched but TS might complain depending on schema inference
	const isImmortal = (bucket.user as typeof users.$inferSelect | null)
		?.isImmortal;

	const existingCount = await db
		.select({ count: count() })
		.from(bucketKeys)
		.where(eq(bucketKeys.bucketId, bucketId));

	if (!isImmortal && (existingCount[0]?.count ?? 0) >= maxKeys) {
		throw new Error(
			`Key limit reached (${maxKeys}). Delete an existing key to create a new one.`,
		);
	}

	const envPrefix = config.isProduction ? "SILO_P" : "SILO_D";

	const randomPart = Array.from(
		crypto.getRandomValues(new Uint8Array(10)),
		(b) => b.toString(16).padStart(2, "0"),
	)
		.join("")
		.toUpperCase();

	// Format: SILO_P_AK_[RANDOM]
	// Example: SILO_P_AK_7F3A9B...
	const accessKey = `${envPrefix}_AK_${randomPart}`;

	const secretRandomPart = Array.from(
		crypto.getRandomValues(new Uint8Array(20)),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");

	// Format: SILO_P_SK_[RANDOM]
	// Example: SILO_P_SK_8E2D1C...
	const secretKey = `${envPrefix}_SK_${secretRandomPart}`;

	await db.insert(bucketKeys).values({
		bucketId,
		accessKey,
		secretKey,
		source,
		note: note?.trim() || null,
	});

	return { accessKey, secretKey };
}

export async function updateKeyNote(
	keyId: string,
	bucketName: string,
	userId: string,
	note: string | null,
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
	if (bucket[0].isCdn) throw new Error("Cannot modify keys for CDN bucket");

	await db
		.update(bucketKeys)
		.set({ note: note?.trim() || null })
		.where(eq(bucketKeys.id, keyId));
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

export async function listKeysForBucket(
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

	return db
		.select({
			id: bucketKeys.id,
			accessKey: bucketKeys.accessKey,
			note: bucketKeys.note,
			isPaused: bucketKeys.isPaused,
			pauseReason: bucketKeys.pauseReason,
		})
		.from(bucketKeys)
		.where(eq(bucketKeys.bucketId, bucket[0].id));
}

export const KeyService = {
	createKey,
	deleteKey,
	listKeysForBucket,
	updateKeyNote,
};
