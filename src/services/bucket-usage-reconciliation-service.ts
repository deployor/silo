import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { buckets, users } from "../db/schema";
import { executeDataplaneStorage } from "../lib/dataplane-storage-client";
import { getInternalPath } from "../lib/s3/paths";
import { parseS3Xml, requireS3XmlElement } from "../lib/s3-xml";
import { getMaintenanceStatus } from "./maintenance-service";

const PAGE_SIZE = 1000;

type S3ListBucketResult = {
	Contents?: { Size?: number | string } | Array<{ Size?: number | string }>;
	NextContinuationToken?: string;
};

async function sumPrefixBytes(
	bucket: typeof buckets.$inferSelect,
	prefix: string,
): Promise<number> {
	let continuationToken: string | null = null;
	let totalBytes = 0;

	do {
		const query = new URLSearchParams();
		query.set("list-type", "2");
		query.set("prefix", prefix);
		query.set("max-keys", String(PAGE_SIZE));
		if (continuationToken) {
			query.set("continuation-token", continuationToken);
		}

		const response = await executeDataplaneStorage({
			bucket,
			rootPrefix: prefix,
			pathWithQuery: `?${query.toString()}`,
			method: "GET",
		});
		if (!response.ok) {
			throw new Error(
				`Failed to reconcile usage: upstream returned ${response.status}`,
			);
		}

		const xml = await response.text();
		const result = requireS3XmlElement(
			parseS3Xml<{ ListBucketResult?: S3ListBucketResult }>(xml)
				.ListBucketResult,
			"ListBucketResult",
		);
		const contents = result.Contents
			? Array.isArray(result.Contents)
				? result.Contents
				: [result.Contents]
			: [];

		for (const item of contents as Array<{ Size?: number | string }>) {
			totalBytes += Number(item.Size || 0);
		}

		continuationToken = result.NextContinuationToken || null;
	} while (continuationToken);

	return totalBytes;
}

export class BucketUsageReconciliationService {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	start() {
		if (this.timer) return;
		const intervalMs = Math.max(
			60_000,
			config.bucketUsageReconcileIntervalMs || 0,
		);
		this.timer = setInterval(() => {
			void this.reconcileAllBuckets();
		}, intervalMs);
		if (this.timer.unref) this.timer.unref();
	}

	stop() {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	async reconcileAllBuckets() {
		if (this.running) return;
		const maintenance = await getMaintenanceStatus();
		if (maintenance.fullMaintenanceMode || maintenance.s3MaintenanceMode)
			return;
		this.running = true;
		try {
			const allBuckets = await db.select().from(buckets);
			for (const bucket of allBuckets) {
				try {
					await this.reconcileBucket(bucket.id);
				} catch (error) {
					console.error(
						`[bucket-usage-reconciliation] failed for ${bucket.name}`,
						error,
					);
				}
			}
		} finally {
			this.running = false;
		}
	}

	async reconcileBucket(bucketId: string) {
		const maintenance = await getMaintenanceStatus();
		if (maintenance.fullMaintenanceMode || maintenance.s3MaintenanceMode)
			return;
		const bucketRows = await db
			.select()
			.from(buckets)
			.where(eq(buckets.id, bucketId))
			.limit(1);
		const bucket = bucketRows[0];
		if (!bucket) return;

		let prefix = "";
		if (bucket.isSystem && !bucket.userId) {
			prefix = `system/${bucket.name}/`;
		} else {
			if (!bucket.userId) return;
			const ownerRows = await db
				.select()
				.from(users)
				.where(eq(users.id, bucket.userId))
				.limit(1);
			const owner = ownerRows[0];
			if (!owner) return;
			prefix = getInternalPath("", owner, bucket);
		}

		const actualBytes = await sumPrefixBytes(bucket, prefix);
		const storedBytes = Number(bucket.totalBytes) || 0;
		if (actualBytes === storedBytes) return;

		await db
			.update(buckets)
			.set({ totalBytes: actualBytes })
			.where(eq(buckets.id, bucket.id));

		console.log(
			`[bucket-usage-reconciliation] corrected ${bucket.name} from ${storedBytes} to ${actualBytes} bytes`,
		);
	}
}

export const bucketUsageReconciliationService =
	new BucketUsageReconciliationService();
