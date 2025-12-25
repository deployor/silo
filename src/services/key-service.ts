import { eq } from "drizzle-orm";
import { db } from "../db";
import { bucketKeys, buckets } from "../db/schema";

export class KeyService {
	static async createKey(bucketId: string) {
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

	static async deleteKey(
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
		if (bucket[0].userId !== userId && !isAdmin)
			throw new Error("Unauthorized");
		if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
		if (bucket[0].isCdn) throw new Error("Cannot delete keys for CDN bucket");

		await db.delete(bucketKeys).where(eq(bucketKeys.id, keyId));
	}
}
