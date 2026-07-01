import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { buckets, users } from "../db/schema";
import { getContext } from "../lib/context";
import { redis } from "../lib/redis";

const FLUSH_INTERVAL_MS = 30_000; // 30 seconds
const KEY_PREFIX_USER = "stats:user:";
const KEY_PREFIX_BUCKET = "stats:bucket:";
const ACTIVE_USERS_KEY = "stats:active:users";
const ACTIVE_BUCKETS_KEY = "stats:active:buckets";

function currentEgressPeriod() {
	return new Date().toISOString().slice(0, 7);
}

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
			pipeline.sadd(ACTIVE_USERS_KEY, userId);

			if (ctx?.bucket) {
				pipeline.incr(`${KEY_PREFIX_BUCKET}${ctx.bucket.id}:requests`);
				pipeline.sadd(ACTIVE_BUCKETS_KEY, ctx.bucket.id);
			}

			await pipeline.exec();
		} catch (e) {
			console.error("Failed to record stats in Redis:", e);
		}
	}

	/**
	 * Flush accumulated stats from Redis into the database in a single transaction.
	 * Uses active-id sets to avoid scanning the full Redis keyspace.
	 */
	public async flushToDatabase() {
		try {
			const [[userSetError, userIdsResult], [bucketSetError, bucketIdsResult]] =
				(await redis
					.pipeline()
					.smembers(ACTIVE_USERS_KEY)
					.smembers(ACTIVE_BUCKETS_KEY)
					.exec()) as Array<[Error | null, string[]]>;

			if (userSetError) throw userSetError;
			if (bucketSetError) throw bucketSetError;

			const userIds = userIdsResult || [];
			const bucketIds = bucketIdsResult || [];
			if (userIds.length === 0 && bucketIds.length === 0) return;

			const activeCleanup = redis.pipeline();
			if (userIds.length > 0) activeCleanup.srem(ACTIVE_USERS_KEY, ...userIds);
			if (bucketIds.length > 0)
				activeCleanup.srem(ACTIVE_BUCKETS_KEY, ...bucketIds);
			await activeCleanup.exec();

			// Parse user stats: group by userId
			const userStats = new Map<
				string,
				{ ingress: number; egress: number; requests: number }
			>();

			if (userIds.length > 0) {
				const pipeline = redis.pipeline();
				const userKeys: string[] = [];
				for (const userId of userIds) {
					for (const metric of ["ingress", "egress", "requests"] as const) {
						const key = `${KEY_PREFIX_USER}${userId}:${metric}`;
						userKeys.push(key);
						pipeline.getdel(key);
					}
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

			if (bucketIds.length > 0) {
				const pipeline = redis.pipeline();
				const bucketKeys = bucketIds.map(
					(bucketId) => `${KEY_PREFIX_BUCKET}${bucketId}:requests`,
				);
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
				const egressPeriod = currentEgressPeriod();
				for (const [userId, stats] of userStats) {
					await tx
						.update(users)
						.set({
							ingressBytes: sql`COALESCE(${users.ingressBytes}, 0) + ${stats.ingress}`,
							egressBytes: sql`CASE WHEN ${users.egressPeriod} = ${egressPeriod} THEN COALESCE(${users.egressBytes}, 0) + ${stats.egress} ELSE ${stats.egress} END`,
							egressPeriod,
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
}

export const statsService = new StatsService();
