import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { buckets, users } from "../src/db/schema";

async function main() {
	console.log("Starting storage usage fix...");

	const allUsers = await db.select().from(users);
	let updatedCount = 0;

	for (const user of allUsers) {
		const userBuckets = await db
			.select()
			.from(buckets)
			.where(eq(buckets.userId, user.id));

		let totalBytes = 0;
		for (const bucket of userBuckets) {
			totalBytes += bucket.totalBytes;
		}

		if (totalBytes !== user.storageUsageBytes) {
			console.log(`User ${user.id} (${user.email}): Mismatch detected.`);
			console.log(`  Current: ${user.storageUsageBytes}`);
			console.log(`  Calculated: ${totalBytes}`);

			await db
				.update(users)
				.set({ storageUsageBytes: totalBytes })
				.where(eq(users.id, user.id));

			console.log(`  Updated.`);
			updatedCount++;
		}
	}

	console.log(`Finished storage usage fix. Updated ${updatedCount} users.`);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
