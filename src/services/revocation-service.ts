import { eq } from "drizzle-orm";
import { db } from "../db";
import { bucketKeys, buckets, users } from "../db/schema";

export async function revokeKey(accessKey: string) {
	// Find the key and related info
	const keyRecord = await db.query.bucketKeys.findFirst({
		where: eq(bucketKeys.accessKey, accessKey),
		with: {
			bucket: {
				with: {
					user: true,
				},
			},
		},
	});

	if (!keyRecord) {
		return null;
	}

	// Delete the key
	await db.delete(bucketKeys).where(eq(bucketKeys.id, keyRecord.id));

	// Extract info for response
	// The relation setup in schema might need checking, but assuming standard Drizzle relations:
	// bucketKeys has bucketId -> buckets
	// buckets has userId -> users

	// In the query above, we are using the relations inferred by Drizzle query builder.
	// We need to make sure relations are defined in db/index.ts or schema.ts for `with` to work.
	// Let's verify relations in a moment. If not using `db.query`, we can join manually.

	// Falling back to explicit joins if relations aren't set up in the query builder object yet.
	// But let's try to be safe and use a manual join query which is robust.

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
		// It's possible the key exists but bucket or user is gone, or key doesn't exist.
		// If key exists but no user/bucket, we should still delete it?
		// S3 keys cascade delete with bucket, so if bucket is gone, key should be gone.
		// If user is gone, bucket should be gone.
		// So if result is empty, key probably doesn't exist.
		return null;
	}

	const { userEmail, bucketName, keyId } = result[0];

	// Perform the deletion
	await db.delete(bucketKeys).where(eq(bucketKeys.id, keyId));

	return {
		revoked: true,
		email: userEmail,
		keyName: bucketName, // Using bucket name as a proxy for key context
	};
}

export const revocationService = {
	revokeKey,
};
