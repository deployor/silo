import { eq } from "drizzle-orm";
import { db } from "../db";
import { bucketKeys, buckets, users } from "../db/schema";
import { invalidateDataplaneAuthCache } from "../lib/dataplane-cache";

export async function revokeKey(accessKey: string) {
	const result = await db
		.select({
			keyId: bucketKeys.id,
			accessKey: bucketKeys.accessKey,
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

	const {
		userEmail,
		bucketName,
		keyId,
		accessKey: revokedAccessKey,
	} = result[0];

	// Perform the deletion
	await db.delete(bucketKeys).where(eq(bucketKeys.id, keyId));
	await invalidateDataplaneAuthCache({
		bucketName,
		accessKey: revokedAccessKey,
	});

	return {
		revoked: true,
		email: userEmail,
		keyName: bucketName,
	};
}

export const revocationService = {
	revokeKey,
};
