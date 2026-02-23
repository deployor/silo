import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { buckets, users } from "../db/schema";
import { getContext } from "../lib/context";
import { redis } from "../lib/redis";

const FLUSH_INTERVAL_MS = 30_000; // 30 seconds
const KEY_PREFIX_USER = "stats:user:";
const KEY_PREFIX_BUCKET = "stats:bucket:";

class StatsService {
	private flushTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		this.startFlushTimer();
	}

	/**
	 * Record usage via Redis INCRBY — fire-and-forget, non-blocking.
	 * Replaces the old per-request DB transaction.
	 */
	public async recordUsage(ingress: number, egress: number) {
		const ctx = getContext();
		const userId = ctx?.user?.id;
		if (!userId) return;

		try {
			const pipeline = redis.pipeline();
			pipeline.incrby(`${KEY_PREFIX_USER}${userId}:ingress`, ingress);
			pipeline.incrby(`${KEY_PREFIX_USER}${userId}:egress`, egress);
			pipeline.incr(`${KEY_PREFIX_USER}${userId}:requests`);

			if (ctx?.bucket) {
				pipeline.incr(`${KEY_PREFIX_BUCKET}${ctx.bucket.id}:requests`);
			}

			await pipeline.exec();
		} catch (e) {
			console.error("Failed to record stats in Redis:", e);
		}
	}

	/**
	 * Flush accumulated stats from Redis into the database in a single transaction.
	 * Uses SCAN to discover keys, then GETDEL to atomically read and clear each counter.
	 */
	public async flushToDatabase() {
		try {
			// Collect all stats keys via SCAN
			const userKeys = await this.scanKeys(`${KEY_PREFIX_USER}*`);
			const bucketKeys = await this.scanKeys(`${KEY_PREFIX_BUCKET}*`);

			if (userKeys.length === 0 && bucketKeys.length === 0) return;

			// Parse user stats: group by userId
			const userStats = new Map<
				string,
				{ ingress: number; egress: number; requests: number }
			>();

			if (userKeys.length > 0) {
				const pipeline = redis.pipeline();
				for (const key of userKeys) {
					pipeline.getdel(key);
				}
				const results = await pipeline.exec();

				for (let i = 0; i < userKeys.length; i++) {
					const key = userKeys[i];
					const result = results?.[i];
					if (!result || result[0]) continue; // error or null

					const value = Number.parseInt(result[1] as string, 10);
					if (Number.isNaN(value) || value === 0) continue;

					// Parse key: stats:user:{userId}:{metric}
					const parts = key.slice(KEY_PREFIX_USER.length);
					const lastColon = parts.lastIndexOf(":");
					if (lastColon === -1) continue;

					const userId = parts.slice(0, lastColon);
					const metric = parts.slice(lastColon + 1);

					let entry = userStats.get(userId);
					if (!entry) {
						entry = { ingress: 0, egress: 0, requests: 0 };
						userStats.set(userId, entry);
					}

					if (metric === "ingress") entry.ingress += value;
					else if (metric === "egress") entry.egress += value;
					else if (metric === "requests") entry.requests += value;
				}
			}

			// Parse bucket stats: group by bucketId
			const bucketStats = new Map<string, number>();

			if (bucketKeys.length > 0) {
				const pipeline = redis.pipeline();
				for (const key of bucketKeys) {
					pipeline.getdel(key);
				}
				const results = await pipeline.exec();

				for (let i = 0; i < bucketKeys.length; i++) {
					const key = bucketKeys[i];
					const result = results?.[i];
					if (!result || result[0]) continue;

					const value = Number.parseInt(result[1] as string, 10);
					if (Number.isNaN(value) || value === 0) continue;

					// Parse key: stats:bucket:{bucketId}:requests
					const parts = key.slice(KEY_PREFIX_BUCKET.length);
					const lastColon = parts.lastIndexOf(":");
					if (lastColon === -1) continue;

					const bucketId = parts.slice(0, lastColon);
					bucketStats.set(bucketId, (bucketStats.get(bucketId) || 0) + value);
				}
			}

			// Nothing to flush after parsing
			if (userStats.size === 0 && bucketStats.size === 0) return;

			// Batch all updates into a single DB transaction
			await db.transaction(async (tx) => {
				for (const [userId, stats] of userStats) {
					await tx
						.update(users)
						.set({
							ingressBytes: sql`COALESCE(${users.ingressBytes}, 0) + ${stats.ingress}`,
							egressBytes: sql`COALESCE(${users.egressBytes}, 0) + ${stats.egress}`,
							totalRequests: sql`COALESCE(${users.totalRequests}, 0) + ${stats.requests}`,
						})
						.where(eq(users.id, userId));
				}

				for (const [bucketId, requests] of bucketStats) {
					await tx
						.update(buckets)
						.set({
							totalRequests: sql`COALESCE(${buckets.totalRequests}, 0) + ${requests}`,
						})
						.where(eq(buckets.id, bucketId));
				}
			});

			const totalUsers = userStats.size;
			const totalBuckets = bucketStats.size;
			if (totalUsers > 0 || totalBuckets > 0) {
				console.log(
					`[stats] Flushed stats for ${totalUsers} user(s) and ${totalBuckets} bucket(s)`,
				);
			}
		} catch (e) {
			console.error("Failed to flush stats to database:", e);
		}
	}

	/**
	 * Gracefully shut down: stop the timer and flush remaining stats.
	 */
	public async shutdown() {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flushToDatabase();
	}

	/**
	 * Start the periodic flush timer.
	 */
	private startFlushTimer() {
		this.flushTimer = setInterval(() => {
			this.flushToDatabase();
		}, FLUSH_INTERVAL_MS);

		// Allow the process to exit even if the timer is still running
		if (this.flushTimer.unref) {
			this.flushTimer.unref();
		}
	}

	/**
	 * Use Redis SCAN to find all keys matching a pattern.
	 * Returns an array of matching key names.
	 */
	private async scanKeys(pattern: string): Promise<string[]> {
		const keys: string[] = [];
		let cursor = "0";

		do {
			const [nextCursor, batch] = await redis.scan(
				cursor,
				"MATCH",
				pattern,
				"COUNT",
				100,
			);
			cursor = nextCursor;
			keys.push(...batch);
		} while (cursor !== "0");

		return keys;
	}
}

export const statsService = new StatsService();
