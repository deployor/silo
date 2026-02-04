import { and, eq, lte } from "drizzle-orm";
import { deleteBucketContents, getInternalPath } from "../src/core/s3/utils";
import { db } from "../src/db";
import { bucketKeys, buckets, users } from "../src/db/schema";

async function processAgedUsers() {
	console.log("Starting aged user processing...");

	// Find users who are:
	// 1. Marked as over-age
	// 2. Grace period has expired (lte now)
	// 3. Files NOT yet deleted
	const now = new Date();

	const agedUsers = await db
		.select()
		.from(users)
		.where(
			and(
				eq(users.markedAsOverAge, true),
				lte(users.overAgeGracePeriodEndsAt, now),
				eq(users.filesDeleted, false),
				eq(users.isImmortal, false),
			),
		);

	console.log(`Found ${agedUsers.length} users to offboard.`);

	for (const user of agedUsers) {
		console.log(`Processing user ${user.id} (${user.email})...`);
		try {
			// 1. Find all buckets
			const userBuckets = await db
				.select()
				.from(buckets)
				.where(eq(buckets.userId, user.id));

			for (const bucket of userBuckets) {
				console.log(`  Deleting bucket ${bucket.name}...`);
				const internalPrefix = getInternalPath("", user, bucket);

				// 2. Delete all S3 contents
				try {
					await deleteBucketContents(internalPrefix);
				} catch (e) {
					console.error(
						`  Failed to delete S3 contents for ${bucket.name}:`,
						e,
					);
					// Continue anyway to try and clean up DB
				}

				// 3. Delete keys
				await db.delete(bucketKeys).where(eq(bucketKeys.bucketId, bucket.id));

				// 4. Delete bucket record
				await db.delete(buckets).where(eq(buckets.id, bucket.id));
			}

			// 5. Mark as files deleted
			await db
				.update(users)
				.set({ filesDeleted: true })
				.where(eq(users.id, user.id));

			console.log(`User ${user.id} processed successfully.`);
		} catch (e) {
			console.error(`Failed to process user ${user.id}:`, e);
		}
	}

	console.log("Done.");
}

processAgedUsers()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
