import { eq } from "drizzle-orm";
import { db } from "../db";
import { bucketKeys, buckets, users } from "../db/schema";

export async function revokeKey(accessKey: string) {
	// Find the key and related info using manual joins to avoid relation issues
	const result = await db
		.select({
			keyId: bucketKeys.id,
			bucketName: buckets.name,
			userEmail: users.email,
		})
		.from(bucketKeys)
		.innerJoin(buckets, eq(bucketKeys.bucketId, buckets.id))
		.innerJoin(users, eq(buckets.userId, users.id))
		.where(eq(bucketKeys.accessKey, accessKey))
		.limit(1);

	if (result.length === 0) {
		return null;
	}

	const { userEmail, bucketName, keyId } = result[0];

	// Perform the deletion
	await db.delete(bucketKeys).where(eq(bucketKeys.id, keyId));

	return {
		revoked: true,
		email: userEmail,
		keyName: bucketName,
	};
}

export const revocationService = {
	revokeKey,
};
