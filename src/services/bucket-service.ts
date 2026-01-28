import { eq } from "drizzle-orm";
import {
	deleteBucketContents,
	getInternalPath,
	isReservedBucketName,
} from "../core/s3/utils";
import { db } from "../db";
import { bucketKeys, buckets, users } from "../db/schema";
import { getAppSettings } from "./settings-service";

export type CorsRule = {
	ID?: string;
	AllowedOrigins: string[];
	AllowedMethods: string[];
	AllowedHeaders?: string[];
	ExposeHeaders?: string[];
	MaxAgeSeconds?: number;
};

export async function getBucketsForUser(userId: string) {
	const userBuckets = await db
		.select()
		.from(buckets)
		.where(eq(buckets.userId, userId));

	const bucketsWithKeys = await Promise.all(
		userBuckets.map(async (b) => {
			const keys = await db
				.select()
				.from(bucketKeys)
				.where(eq(bucketKeys.bucketId, b.id));
			return {
				...b,
				keys: keys.map((k) => ({
					id: k.id,
					accessKey: k.accessKey,
				})),
			};
		}),
	);

	return bucketsWithKeys;
}

export async function createBucket(
	userId: string,
	name: string,
	isCdn = false,
) {
	if (!name || !/^[a-z0-9-]+$/.test(name)) {
		throw new Error("Invalid bucket name");
	}

	if (isReservedBucketName(name)) {
		throw new Error("Bucket name is reserved for system use");
	}

	const settings = await getAppSettings();
	const maxBuckets = settings.defaultMaxBucketsPerUser;

	const userBuckets = await db
		.select()
		.from(buckets)
		.where(eq(buckets.userId, userId));
	if (userBuckets.length >= maxBuckets) {
		throw new Error(`Bucket limit reached (${maxBuckets})`);
	}

	const existing = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, name))
		.limit(1);
	if (existing.length > 0) {
		throw new Error("Bucket name already taken");
	}

	const newBucket = await db
		.insert(buckets)
		.values({
			name,
			userId,
			isPublic: isCdn,
			isCdn,
		})
		.returning();

	return newBucket[0];
}

export async function emptyBucket(
	name: string,
	userId: string,
	isAdmin = false,
) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, name))
		.limit(1);

	if (bucket.length === 0) throw new Error("Bucket not found");
	if (bucket[0].userId !== userId && !isAdmin) throw new Error("Unauthorized");
	if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");

	if (!bucket[0].userId)
		throw new Error("Cannot empty system bucket without owner");

	const owner = await db
		.select()
		.from(users)
		.where(eq(users.id, bucket[0].userId))
		.limit(1);
	if (owner.length === 0) throw new Error("Owner not found");

	const internalPrefix = getInternalPath("", owner[0], bucket[0]);
	await deleteBucketContents(internalPrefix);

	// Reset usage stats for the bucket
	await db
		.update(buckets)
		.set({ totalBytes: 0 })
		.where(eq(buckets.id, bucket[0].id));
}

export async function deleteBucket(
	name: string,
	userId: string,
	isAdmin = false,
) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, name))
		.limit(1);

	if (bucket.length === 0) throw new Error("Bucket not found");
	if (bucket[0].userId !== userId && !isAdmin) throw new Error("Unauthorized");
	if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
	if (bucket[0].isSystem) throw new Error("Cannot delete system bucket");

	// Best-effort: remove all objects first so upstream storage doesn't leak
	try {
		if (bucket[0].userId) {
			const owner = await db
				.select()
				.from(users)
				.where(eq(users.id, bucket[0].userId))
				.limit(1);
			if (owner.length > 0) {
				const internalPrefix = getInternalPath("", owner[0], bucket[0]);
				await deleteBucketContents(internalPrefix);
			}
		}
	} catch (e) {
		console.error("Failed to empty bucket during delete:", e);
	}

	await db.delete(buckets).where(eq(buckets.name, name));
}

export async function updateBucketVisibility(
	name: string,
	userId: string,
	isPublic: boolean,
	isAdmin = false,
) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, name))
		.limit(1);

	if (bucket.length === 0) throw new Error("Bucket not found");
	if (bucket[0].userId !== userId && !isAdmin) throw new Error("Unauthorized");
	if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
	if (bucket[0].isCdn) throw new Error("Cannot modify CDN bucket");

	await db.update(buckets).set({ isPublic }).where(eq(buckets.name, name));
}

export async function updateCorsConfig(
	name: string,
	userId: string,
	corsRules: CorsRule[],
	isAdmin = false,
) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, name))
		.limit(1);

	if (bucket.length === 0) throw new Error("Bucket not found");
	if (bucket[0].userId !== userId && !isAdmin) throw new Error("Unauthorized");
	if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
	if (bucket[0].isCdn) throw new Error("Cannot modify CDN bucket CORS");

	const corsConfig = {
		CORSRules: corsRules,
	};

	await db
		.update(buckets)
		.set({ corsConfig: JSON.stringify(corsConfig) })
		.where(eq(buckets.name, name));
}

export async function deleteCorsConfig(
	name: string,
	userId: string,
	isAdmin = false,
) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, name))
		.limit(1);

	if (bucket.length === 0) throw new Error("Bucket not found");
	if (bucket[0].userId !== userId && !isAdmin) throw new Error("Unauthorized");
	if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
	if (bucket[0].isCdn) throw new Error("Cannot modify CDN bucket CORS");

	await db
		.update(buckets)
		.set({ corsConfig: null })
		.where(eq(buckets.name, name));
}

export const BucketService = {
	getBucketsForUser,
	createBucket,
	emptyBucket,
	deleteBucket,
	updateBucketVisibility,
	updateCorsConfig,
	deleteCorsConfig,
};
