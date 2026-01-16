import { count, eq } from "drizzle-orm";
import { db } from "../db";
import { bucketKeys, buckets } from "../db/schema";

const MAX_KEYS_PER_BUCKET = 20;

export async function createKey(bucketId: string) {
	const existingCount = await db
		.select({ count: count() })
		.from(bucketKeys)
		.where(eq(bucketKeys.bucketId, bucketId));

	if ((existingCount[0]?.count ?? 0) >= MAX_KEYS_PER_BUCKET) {
		throw new Error(
			`Key limit reached (${MAX_KEYS_PER_BUCKET}). Delete an existing key to create a new one.`,
		);
	}

	const accessKey =
		"CK" +
		Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) =>
			b.toString(16).padStart(2, "0"),
		)
			.join("")
			.toUpperCase();
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
