import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import {
	bucketAnalyticsMinute,
	bucketAnalyticsSnapshot,
	bucketObjectAnalytics,
	requestLogs,
} from "../db/schema";
import { getContext } from "../lib/context";
import { redis } from "../lib/redis";
import { getBucketAccessForUser } from "./collaboration-service";

const ANALYTICS_MINUTE_PREFIX = "analytics:minute:";
const ANALYTICS_OBJECT_PREFIX = "analytics:object:";
const ANALYTICS_FLUSH_INTERVAL_MS = 15_000;
const ANALYTICS_SNAPSHOT_LIMIT = 15;

function floorToMinute(date: Date) {
	const next = new Date(date);
	next.setSeconds(0, 0);
	return next;
}

function parseObjectPath(rawPath: string) {
	if (!rawPath.startsWith("/")) return rawPath;
	const parts = rawPath.split("/").filter(Boolean);
	if (parts.length < 2) return rawPath;
	return parts.slice(1).join("/");
}

function safeObjectLabel(objectKey: string) {
	const normalized = parseObjectPath(objectKey);
	if (normalized.length <= 160) return normalized;
	return `…${normalized.slice(-160)}`;
}

function timeRangeToDate(range: string) {
	const now = Date.now();
	switch (range) {
		case "1h":
			return new Date(now - 60 * 60 * 1000);
		case "7d":
			return new Date(now - 7 * 24 * 60 * 60 * 1000);
		case "30d":
			return new Date(now - 30 * 24 * 60 * 60 * 1000);
		default:
			return new Date(now - 24 * 60 * 60 * 1000);
	}
}

export async function resolveBucketAnalyticsAccess(params: {
	bucketName: string;
	userId: string;
	isAdmin?: boolean;
}) {
	return getBucketAccessForUser(params);
}

class AnalyticsService {
	private flushTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		this.startFlushTimer();
	}

	public async recordRequestMetrics(response: Response) {
		const ctx = getContext();
		if (!ctx?.bucket) return;

		const minuteStart = floorToMinute(new Date()).toISOString();
		const bucketId = ctx.bucket.id;
		const statusCode = response.status;
		const ingressBytes = Number.parseInt(
			response.headers.get("x-silo-ingress-bytes") || "0",
			10,
		);
		const egressBytes = Number.parseInt(
			response.headers.get("content-length") || "0",
			10,
		);
		const latencyMs = Math.max(
			0,
			Math.round(performance.now() - ctx.startTime),
		);
		const objectKey = safeObjectLabel(ctx.path);

		const minuteKey = `${ANALYTICS_MINUTE_PREFIX}${bucketId}:${minuteStart}`;
		const objectKeyRedis = `${ANALYTICS_OBJECT_PREFIX}${bucketId}:${objectKey}`;

		const pipeline = redis.pipeline();
		pipeline.hincrby(minuteKey, "requestCount", 1);
		pipeline.hincrby(minuteKey, `${ctx.method.toLowerCase()}Count`, 1);
		pipeline.hincrby(minuteKey, `status${Math.floor(statusCode / 100)}xx`, 1);
		if (statusCode === 401) pipeline.hincrby(minuteKey, "status401", 1);
		if (statusCode === 403) pipeline.hincrby(minuteKey, "status403", 1);
		if (statusCode === 404) pipeline.hincrby(minuteKey, "status404", 1);
		if (statusCode === 429) pipeline.hincrby(minuteKey, "status429", 1);
		if (statusCode >= 400) pipeline.hincrby(minuteKey, "errorCount", 1);
		pipeline.hincrby(minuteKey, "ingressBytes", ingressBytes);
		pipeline.hincrby(minuteKey, "egressBytes", egressBytes);
		pipeline.hincrby(minuteKey, "latencyTotalMs", latencyMs);
		pipeline.hset(minuteKey, "latencyMaxMs", String(latencyMs));
		pipeline.expire(minuteKey, 60 * 60 * 6);

		if (
			objectKey &&
			!objectKey.startsWith("/api/") &&
			!objectKey.startsWith("/admin")
		) {
			pipeline.hincrby(objectKeyRedis, "hitCount", 1);
			pipeline.hincrby(objectKeyRedis, "egressBytes", egressBytes);
			pipeline.hincrby(objectKeyRedis, "ingressBytes", ingressBytes);
			if (statusCode >= 400) pipeline.hincrby(objectKeyRedis, "errorCount", 1);
			pipeline.hset(objectKeyRedis, "lastAccessedAt", new Date().toISOString());
			pipeline.expire(objectKeyRedis, 60 * 60 * 24 * 3);
		}

		await pipeline.exec().catch((error) => {
			console.error("Failed to record analytics metrics:", error);
		});
	}

	public async flushToDatabase() {
		const minuteKeys = await this.scanKeys(`${ANALYTICS_MINUTE_PREFIX}*`);
		const objectKeys = await this.scanKeys(`${ANALYTICS_OBJECT_PREFIX}*`);

		await Promise.all([
			this.flushMinuteKeys(minuteKeys),
			this.flushObjectKeys(objectKeys),
		]).catch((error) => {
			console.error("Failed analytics flush:", error);
		});
	}

	private async flushMinuteKeys(keys: string[]) {
		for (const key of keys) {
			const data = await redis.hgetall(key);
			if (!data || Object.keys(data).length === 0) continue;
			await redis.del(key);

			const [, bucketId, minuteStart] = key.split(":").slice(-3);
			const minuteDate = new Date(minuteStart);
			const existing = await db
				.select({ id: bucketAnalyticsMinute.id })
				.from(bucketAnalyticsMinute)
				.where(
					and(
						eq(bucketAnalyticsMinute.bucketId, bucketId),
						eq(bucketAnalyticsMinute.minuteStart, minuteDate),
					),
				)
				.limit(1);

			const values = {
				bucketId,
				minuteStart: minuteDate,
				requestCount: Number.parseInt(data.requestCount || "0", 10),
				getCount: Number.parseInt(data.getCount || "0", 10),
				putCount: Number.parseInt(data.putCount || "0", 10),
				deleteCount: Number.parseInt(data.deleteCount || "0", 10),
				headCount: Number.parseInt(data.headCount || "0", 10),
				status2xx: Number.parseInt(data.status2xx || "0", 10),
				status3xx: Number.parseInt(data.status3xx || "0", 10),
				status4xx: Number.parseInt(data.status4xx || "0", 10),
				status5xx: Number.parseInt(data.status5xx || "0", 10),
				status401: Number.parseInt(data.status401 || "0", 10),
				status403: Number.parseInt(data.status403 || "0", 10),
				status404: Number.parseInt(data.status404 || "0", 10),
				status429: Number.parseInt(data.status429 || "0", 10),
				errorCount: Number.parseInt(data.errorCount || "0", 10),
				ingressBytes: Number.parseInt(data.ingressBytes || "0", 10),
				egressBytes: Number.parseInt(data.egressBytes || "0", 10),
				latencyTotalMs: Number.parseInt(data.latencyTotalMs || "0", 10),
				latencyMaxMs: Number.parseInt(data.latencyMaxMs || "0", 10),
				updatedAt: new Date(),
			};

			if (existing[0]) {
				await db
					.update(bucketAnalyticsMinute)
					.set({
						requestCount: sql`${bucketAnalyticsMinute.requestCount} + ${values.requestCount}`,
						getCount: sql`${bucketAnalyticsMinute.getCount} + ${values.getCount}`,
						putCount: sql`${bucketAnalyticsMinute.putCount} + ${values.putCount}`,
						deleteCount: sql`${bucketAnalyticsMinute.deleteCount} + ${values.deleteCount}`,
						headCount: sql`${bucketAnalyticsMinute.headCount} + ${values.headCount}`,
						status2xx: sql`${bucketAnalyticsMinute.status2xx} + ${values.status2xx}`,
						status3xx: sql`${bucketAnalyticsMinute.status3xx} + ${values.status3xx}`,
						status4xx: sql`${bucketAnalyticsMinute.status4xx} + ${values.status4xx}`,
						status5xx: sql`${bucketAnalyticsMinute.status5xx} + ${values.status5xx}`,
						status401: sql`${bucketAnalyticsMinute.status401} + ${values.status401}`,
						status403: sql`${bucketAnalyticsMinute.status403} + ${values.status403}`,
						status404: sql`${bucketAnalyticsMinute.status404} + ${values.status404}`,
						status429: sql`${bucketAnalyticsMinute.status429} + ${values.status429}`,
						errorCount: sql`${bucketAnalyticsMinute.errorCount} + ${values.errorCount}`,
						ingressBytes: sql`${bucketAnalyticsMinute.ingressBytes} + ${values.ingressBytes}`,
						egressBytes: sql`${bucketAnalyticsMinute.egressBytes} + ${values.egressBytes}`,
						latencyTotalMs: sql`${bucketAnalyticsMinute.latencyTotalMs} + ${values.latencyTotalMs}`,
						latencyMaxMs: Math.max(values.latencyMaxMs, values.latencyMaxMs),
						updatedAt: new Date(),
					})
					.where(eq(bucketAnalyticsMinute.id, existing[0].id));
			} else {
				await db.insert(bucketAnalyticsMinute).values(values);
			}
		}
	}

	private async flushObjectKeys(keys: string[]) {
		for (const key of keys) {
			const data = await redis.hgetall(key);
			if (!data || Object.keys(data).length === 0) continue;
			await redis.del(key);

			const suffix = key.slice(ANALYTICS_OBJECT_PREFIX.length);
			const firstColon = suffix.indexOf(":");
			if (firstColon === -1) continue;
			const bucketId = suffix.slice(0, firstColon);
			const objectKey = suffix.slice(firstColon + 1);

			const existing = await db
				.select({ id: bucketObjectAnalytics.id })
				.from(bucketObjectAnalytics)
				.where(
					and(
						eq(bucketObjectAnalytics.bucketId, bucketId),
						eq(bucketObjectAnalytics.objectKey, objectKey),
					),
				)
				.limit(1);

			const values = {
				bucketId,
				objectKey,
				hitCount: Number.parseInt(data.hitCount || "0", 10),
				errorCount: Number.parseInt(data.errorCount || "0", 10),
				ingressBytes: Number.parseInt(data.ingressBytes || "0", 10),
				egressBytes: Number.parseInt(data.egressBytes || "0", 10),
				lastAccessedAt: data.lastAccessedAt
					? new Date(data.lastAccessedAt)
					: new Date(),
				updatedAt: new Date(),
			};

			if (existing[0]) {
				await db
					.update(bucketObjectAnalytics)
					.set({
						hitCount: sql`${bucketObjectAnalytics.hitCount} + ${values.hitCount}`,
						errorCount: sql`${bucketObjectAnalytics.errorCount} + ${values.errorCount}`,
						ingressBytes: sql`${bucketObjectAnalytics.ingressBytes} + ${values.ingressBytes}`,
						egressBytes: sql`${bucketObjectAnalytics.egressBytes} + ${values.egressBytes}`,
						lastAccessedAt: values.lastAccessedAt,
						updatedAt: new Date(),
					})
					.where(eq(bucketObjectAnalytics.id, existing[0].id));
			} else {
				await db.insert(bucketObjectAnalytics).values(values);
			}
		}
	}

	public async refreshBucketSnapshot(bucketId: string) {
		const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
		const minuteRows = await db
			.select()
			.from(bucketAnalyticsMinute)
			.where(
				and(
					eq(bucketAnalyticsMinute.bucketId, bucketId),
					gte(bucketAnalyticsMinute.minuteStart, since),
				),
			);

		const objects = await db
			.select()
			.from(bucketObjectAnalytics)
			.where(eq(bucketObjectAnalytics.bucketId, bucketId))
			.orderBy(desc(bucketObjectAnalytics.hitCount))
			.limit(ANALYTICS_SNAPSHOT_LIMIT);

		const requestCount24h = minuteRows.reduce(
			(sum, row) => sum + Number(row.requestCount || 0),
			0,
		);
		const egressBytes24h = minuteRows.reduce(
			(sum, row) => sum + Number(row.egressBytes || 0),
			0,
		);
		const ingressBytes24h = minuteRows.reduce(
			(sum, row) => sum + Number(row.ingressBytes || 0),
			0,
		);
		const errorCount24h = minuteRows.reduce(
			(sum, row) => sum + Number(row.errorCount || 0),
			0,
		);
		const status42924h = minuteRows.reduce(
			(sum, row) => sum + Number(row.status429 || 0),
			0,
		);
		const latencyTotalMs = minuteRows.reduce(
			(sum, row) => sum + Number(row.latencyTotalMs || 0),
			0,
		);
		const peakMinute = minuteRows.reduce<(typeof minuteRows)[number] | null>(
			(peak, row) => {
				if (!peak) return row;
				return Number(row.requestCount || 0) > Number(peak.requestCount || 0)
					? row
					: peak;
			},
			null,
		);

		const snapshotValues = {
			bucketId,
			windowStart: since,
			windowEnd: new Date(),
			requestCount24h,
			egressBytes24h,
			ingressBytes24h,
			errorCount24h,
			status42924h,
			avgLatencyMs24h:
				requestCount24h > 0 ? latencyTotalMs / requestCount24h : 0,
			peakMinuteRequests24h: Number(peakMinute?.requestCount || 0),
			peakMinuteAt24h: peakMinute?.minuteStart || null,
			hotObjectsJson: JSON.stringify(
				objects.map((row) => ({
					key: row.objectKey,
					hits: Number(row.hitCount || 0),
					egressBytes: Number(row.egressBytes || 0),
					errorCount: Number(row.errorCount || 0),
					lastAccessedAt: row.lastAccessedAt,
				})),
			),
			statusBreakdownJson: JSON.stringify({
				status2xx: minuteRows.reduce(
					(sum, row) => sum + Number(row.status2xx || 0),
					0,
				),
				status3xx: minuteRows.reduce(
					(sum, row) => sum + Number(row.status3xx || 0),
					0,
				),
				status4xx: minuteRows.reduce(
					(sum, row) => sum + Number(row.status4xx || 0),
					0,
				),
				status5xx: minuteRows.reduce(
					(sum, row) => sum + Number(row.status5xx || 0),
					0,
				),
			}),
			methodBreakdownJson: JSON.stringify({
				get: minuteRows.reduce(
					(sum, row) => sum + Number(row.getCount || 0),
					0,
				),
				put: minuteRows.reduce(
					(sum, row) => sum + Number(row.putCount || 0),
					0,
				),
				delete: minuteRows.reduce(
					(sum, row) => sum + Number(row.deleteCount || 0),
					0,
				),
				head: minuteRows.reduce(
					(sum, row) => sum + Number(row.headCount || 0),
					0,
				),
			}),
			updatedAt: new Date(),
		};

		await db
			.insert(bucketAnalyticsSnapshot)
			.values(snapshotValues)
			.onConflictDoUpdate({
				target: bucketAnalyticsSnapshot.bucketId,
				set: snapshotValues,
			});
	}

	public async getBucketAnalyticsSnapshot(params: {
		bucketName: string;
		userId: string;
		isAdmin?: boolean;
	}) {
		const access = await resolveBucketAnalyticsAccess(params);
		await this.refreshBucketSnapshot(access.bucket.id);

		const snapshot = await db
			.select()
			.from(bucketAnalyticsSnapshot)
			.where(eq(bucketAnalyticsSnapshot.bucketId, access.bucket.id))
			.limit(1);

		const topErrors = await db
			.select({
				statusCode: requestLogs.statusCode,
				count: sql<number>`count(*)`.mapWith(Number),
			})
			.from(requestLogs)
			.where(
				and(
					eq(requestLogs.bucketId, access.bucket.id),
					gte(
						requestLogs.createdAt,
						new Date(Date.now() - 24 * 60 * 60 * 1000),
					),
					sql`${requestLogs.statusCode} >= 400`,
				),
			)
			.groupBy(requestLogs.statusCode)
			.orderBy(desc(sql<number>`count(*)`.mapWith(Number)))
			.limit(8);

		return {
			bucket: {
				id: access.bucket.id,
				name: access.bucket.name,
				isAdminView: Boolean(params.isAdmin),
				ownerId: access.owner.id,
				permissions: access.permissions,
			},
			snapshot: snapshot[0] || null,
			topErrors,
		};
	}

	public async getBucketAnalyticsTimeseries(params: {
		bucketName: string;
		userId: string;
		isAdmin?: boolean;
		range: string;
	}) {
		const access = await resolveBucketAnalyticsAccess(params);
		const since = timeRangeToDate(params.range);
		return db
			.select()
			.from(bucketAnalyticsMinute)
			.where(
				and(
					eq(bucketAnalyticsMinute.bucketId, access.bucket.id),
					gte(bucketAnalyticsMinute.minuteStart, since),
				),
			)
			.orderBy(bucketAnalyticsMinute.minuteStart);
	}

	public async getBucketHotObjects(params: {
		bucketName: string;
		userId: string;
		isAdmin?: boolean;
	}) {
		const access = await resolveBucketAnalyticsAccess(params);
		return db
			.select()
			.from(bucketObjectAnalytics)
			.where(eq(bucketObjectAnalytics.bucketId, access.bucket.id))
			.orderBy(
				desc(bucketObjectAnalytics.hitCount),
				desc(bucketObjectAnalytics.egressBytes),
			)
			.limit(50);
	}

	public async getBucketAnalyticsLive(params: {
		bucketName: string;
		userId: string;
		isAdmin?: boolean;
	}) {
		const [summary, series, objects] = await Promise.all([
			this.getBucketAnalyticsSnapshot(params),
			this.getBucketAnalyticsTimeseries({ ...params, range: "1h" }),
			this.getBucketHotObjects(params),
		]);

		return {
			summary,
			series: series.slice(-60),
			objects: objects.slice(0, 12),
		};
	}

	public async shutdown() {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flushToDatabase();
	}

	private startFlushTimer() {
		this.flushTimer = setInterval(() => {
			this.flushToDatabase();
		}, ANALYTICS_FLUSH_INTERVAL_MS);
		this.flushTimer.unref?.();
	}

	private async scanKeys(pattern: string) {
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

export const analyticsService = new AnalyticsService();
