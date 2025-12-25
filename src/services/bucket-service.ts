import { eq } from "drizzle-orm";
import { isReservedBucketName } from "../core/s3/utils";
import { db } from "../db";
import { bucketKeys, buckets } from "../db/schema";

export class BucketService {
	static async getBucketsForUser(userId: string) {
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

	static async createBucket(userId: string, name: string, isCdn = false) {
		if (!name || !/^[a-z0-9-]+$/.test(name)) {
			throw new Error("Invalid bucket name");
		}

		if (isReservedBucketName(name)) {
			throw new Error("Bucket name is reserved for system use");
		}

		const userBuckets = await db
			.select()
			.from(buckets)
			.where(eq(buckets.userId, userId));
		if (userBuckets.length >= 50) {
			throw new Error("Bucket limit reached");
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

	static async deleteBucket(name: string, userId: string, isAdmin = false) {
		const bucket = await db
			.select()
			.from(buckets)
			.where(eq(buckets.name, name))
			.limit(1);

		if (bucket.length === 0) throw new Error("Bucket not found");
		if (bucket[0].userId !== userId && !isAdmin)
			throw new Error("Unauthorized");
		if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");

		// We don't actually delete the files here, the caller should handle that or we can add it later
		// For now, just delete the DB record
		await db.delete(buckets).where(eq(buckets.name, name));
	}

	static async updateBucketVisibility(
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
		if (bucket[0].userId !== userId && !isAdmin)
			throw new Error("Unauthorized");
		if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
		if (bucket[0].isCdn) throw new Error("Cannot modify CDN bucket");

		await db.update(buckets).set({ isPublic }).where(eq(buckets.name, name));
	}

	static async updateCorsConfig(
		name: string,
		userId: string,
		rules: any[],
		isAdmin = false,
	) {
		const bucket = await db
			.select()
			.from(buckets)
			.where(eq(buckets.name, name))
			.limit(1);

		if (bucket.length === 0) throw new Error("Bucket not found");
		if (bucket[0].userId !== userId && !isAdmin)
			throw new Error("Unauthorized");
		if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
		if (bucket[0].isCdn) throw new Error("Cannot modify CDN bucket CORS");

		const corsConfig = {
			CORSRules: rules,
		};

		await db
			.update(buckets)
			.set({ corsConfig: JSON.stringify(corsConfig) })
			.where(eq(buckets.name, name));
	}

	static async deleteCorsConfig(name: string, userId: string, isAdmin = false) {
		const bucket = await db
			.select()
			.from(buckets)
			.where(eq(buckets.name, name))
			.limit(1);

		if (bucket.length === 0) throw new Error("Bucket not found");
		if (bucket[0].userId !== userId && !isAdmin)
			throw new Error("Unauthorized");
		if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
		if (bucket[0].isCdn) throw new Error("Cannot modify CDN bucket CORS");

		await db
			.update(buckets)
			.set({ corsConfig: null })
			.where(eq(buckets.name, name));
	}
}
