import { config } from "../config";
import { db } from "../db";
import { buckets } from "../db/schema";
import { revalidateVerifiedCustomDomainsForBucket } from "./bucket-service";
import { getMaintenanceStatus } from "./maintenance-service";

export class CustomDomainRevalidationService {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	start() {
		if (this.timer) return;
		const intervalMs = Math.max(
			60_000,
			config.customDomainRevalidateIntervalMs || 0,
		);
		this.timer = setInterval(() => {
			void this.revalidateAll();
		}, intervalMs);
		if (this.timer.unref) this.timer.unref();
	}

	stop() {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	async revalidateAll() {
		if (this.running) return;
		if ((await getMaintenanceStatus()).fullMaintenanceMode) return;
		this.running = true;
		try {
			const allBuckets = await db.select({ id: buckets.id }).from(buckets);
			for (const bucket of allBuckets) {
				try {
					await revalidateVerifiedCustomDomainsForBucket(bucket.id);
				} catch (error) {
					console.error(
						`[custom-domain-revalidation] failed for bucket ${bucket.id}`,
						error,
					);
				}
			}
		} finally {
			this.running = false;
		}
	}
}

export const customDomainRevalidationService =
	new CustomDomainRevalidationService();
