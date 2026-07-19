import { and, count, eq, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { bucketKeys, buckets, type users } from "../db/schema";
import { invalidateDataplaneAuthCache } from "../lib/dataplane-cache";
import {
	assertCanManageKeys,
	getBucketAccessForUser,
} from "./collaboration-service";
import { getBucketDeepFreezeMessage } from "./deep-freeze-service";
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
	const createDeepFreezeMessage = getBucketDeepFreezeMessage(bucket);
	if (createDeepFreezeMessage) throw new Error(createDeepFreezeMessage);

	// Relation user is fetched but TS might complain depending on schema inference
	const isImmortal = (bucket.user as typeof users.$inferSelect | null)
		?.isImmortal;

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

	await db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`silo:bucket-keys:${bucketId}`}, 0))`,
		);
		const [existingCount] = await tx
			.select({ value: count() })
			.from(bucketKeys)
			.where(eq(bucketKeys.bucketId, bucketId));
		if (!isImmortal && (existingCount?.value ?? 0) >= maxKeys) {
			throw new Error(
				`Key limit reached (${maxKeys}). Delete an existing key to create a new one.`,
			);
		}
		await tx.insert(bucketKeys).values({
			bucketId,
			accessKey,
			secretKey,
			source,
			note: note?.trim() || null,
		});
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
	const access = await getBucketAccessForUser({
		bucketName,
		userId,
		isAdmin,
	});
	if (access.bucket.isPaused && !isAdmin) throw new Error("Bucket is paused");
	const noteDeepFreezeMessage = getBucketDeepFreezeMessage(access.bucket);
	if (noteDeepFreezeMessage && !isAdmin) throw new Error(noteDeepFreezeMessage);
	assertCanManageKeys(access);
	const [key] = await db
		.select({ id: bucketKeys.id })
		.from(bucketKeys)
		.where(
			and(eq(bucketKeys.id, keyId), eq(bucketKeys.bucketId, access.bucket.id)),
		)
		.limit(1);
	if (!key) throw new Error("Key not found");

	await db
		.update(bucketKeys)
		.set({ note: note?.trim() || null })
		.where(
			and(eq(bucketKeys.id, keyId), eq(bucketKeys.bucketId, access.bucket.id)),
		);
}

export async function deleteKey(
	keyId: string,
	bucketName: string,
	userId: string,
	isAdmin = false,
) {
	const access = await getBucketAccessForUser({
		bucketName,
		userId,
		isAdmin,
	});
	if (access.bucket.isPaused && !isAdmin) throw new Error("Bucket is paused");
	const deleteDeepFreezeMessage = getBucketDeepFreezeMessage(access.bucket);
	if (deleteDeepFreezeMessage && !isAdmin)
		throw new Error(deleteDeepFreezeMessage);
	assertCanManageKeys(access);

	const [key] = await db
		.select({ accessKey: bucketKeys.accessKey })
		.from(bucketKeys)
		.where(
			and(eq(bucketKeys.id, keyId), eq(bucketKeys.bucketId, access.bucket.id)),
		)
		.limit(1);
	if (!key) throw new Error("Key not found");
	await db
		.delete(bucketKeys)
		.where(
			and(eq(bucketKeys.id, keyId), eq(bucketKeys.bucketId, access.bucket.id)),
		);
	await invalidateDataplaneAuthCache({
		bucketName,
		accessKey: key?.accessKey,
	});
}

export async function listKeysForBucket(
	bucketName: string,
	userId: string,
	isAdmin = false,
) {
	const access = await getBucketAccessForUser({
		bucketName,
		userId,
		isAdmin,
	});
	const listDeepFreezeMessage = getBucketDeepFreezeMessage(access.bucket);
	if (listDeepFreezeMessage && !isAdmin) throw new Error(listDeepFreezeMessage);
	assertCanManageKeys(access);

	return db
		.select({
			id: bucketKeys.id,
			accessKey: bucketKeys.accessKey,
			note: bucketKeys.note,
			isPaused: bucketKeys.isPaused,
			pauseReason: bucketKeys.pauseReason,
		})
		.from(bucketKeys)
		.where(eq(bucketKeys.bucketId, access.bucket.id));
}

export const KeyService = {
	createKey,
	deleteKey,
	listKeysForBucket,
	updateKeyNote,
};
