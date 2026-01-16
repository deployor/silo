import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { bucketKeys, buckets } from "../src/db/schema";
import { KeyService } from "../src/services/key-service";

/**
 * Smoke-test: enforce max 20 keys per bucket.
 *
 * Usage:
 *   bun scripts/test-key-limit.ts <bucket-name>
 *
 * Notes:
 * - This script assumes you have DB connectivity configured in env.
 * - It uses the bucket by name and attempts to create up to 21 keys.
 */
async function main() {
	const bucketName = process.argv[2];
	if (!bucketName) {
		console.error("Usage: bun scripts/test-key-limit.ts <bucket-name>");
		process.exit(1);
	}

	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);

	if (bucket.length === 0) {
		console.error(`Bucket not found: ${bucketName}`);
		process.exit(1);
	}

	const before = await db
		.select()
		.from(bucketKeys)
		.where(eq(bucketKeys.bucketId, bucket[0].id));

	console.log(
		`Bucket ${bucketName}: existing keys=${before.length}, limit=${KeyService.MAX_KEYS_PER_BUCKET}`,
	);

	let created = 0;
	for (let i = 0; i < KeyService.MAX_KEYS_PER_BUCKET + 1; i++) {
		try {
			await KeyService.createKey(bucket[0].id);
			created++;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.log(`Stopped on attempt ${i + 1}: ${msg}`);
			break;
		}
	}

	const after = await db
		.select()
		.from(bucketKeys)
		.where(eq(bucketKeys.bucketId, bucket[0].id));

	console.log(
		`After: keys=${after.length} (created ${created} this run). Expected <= ${KeyService.MAX_KEYS_PER_BUCKET}.`,
	);

	if (after.length > KeyService.MAX_KEYS_PER_BUCKET) {
		console.error("FAIL: key count exceeds limit");
		process.exit(2);
	}

	console.log("OK");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
