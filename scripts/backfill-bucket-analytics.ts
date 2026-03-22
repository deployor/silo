import { and, asc, eq, gte, sql } from "drizzle-orm";
import { db } from "../src/db";
import {
	bucketAnalyticsMinute,
	bucketObjectAnalytics,
	requestLogs,
} from "../src/db/schema";
import { analyticsService } from "../src/services/analytics-service";

const DEFAULT_DAYS = 30;
const DEFAULT_BATCH_SIZE = 5000;

function floorToMinute(date: Date) {
	const next = new Date(date);
	next.setSeconds(0, 0);
	return next;
}

function parseArgs() {
	const args = process.argv.slice(2);
	let since = new Date(Date.now() - DEFAULT_DAYS * 24 * 60 * 60 * 1000);
	let batchSize = DEFAULT_BATCH_SIZE;

	for (let i = 0; i < args.length; i += 1) {
		const value = args[i];
		if (value === "--since" && args[i + 1]) {
			since = new Date(args[i + 1]);
			i += 1;
			continue;
		}
		if (value === "--batch" && args[i + 1]) {
			batchSize = Math.max(100, Number.parseInt(args[i + 1], 10) || DEFAULT_BATCH_SIZE);
			i += 1;
		}
	}

	return { since, batchSize };
}

function objectKeyFromPath(path: string) {
	return path.startsWith("/")
		? path.split("/").filter(Boolean).slice(1).join("/")
		: path;
}

async function main() {
	const { since, batchSize } = parseArgs();
	if (Number.isNaN(since.getTime())) {
		throw new Error("Invalid --since value. Use an ISO date.");
	}

	console.log("== Bucket analytics backfill ==");
	console.log(`Since: ${since.toISOString()}`);
	console.log(`Batch size: ${batchSize}`);
	console.log("Counting source logs...");

	const countRes = await db
		.select({ count: sql<number>`count(*)`.mapWith(Number) })
		.from(requestLogs)
		.where(gte(requestLogs.createdAt, since));
	const totalLogs = Number(countRes[0]?.count || 0);
	console.log(`Found ${totalLogs.toLocaleString()} raw logs to process.`);

	if (totalLogs === 0) {
		console.log("Nothing to backfill. Exiting cleanly.");
		return;
	}

	let offset = 0;
	let processed = 0;
	const touchedBucketIds = new Set<string>();

	while (offset < totalLogs) {
		console.log(`\n[batch] Loading logs ${offset + 1}-${Math.min(totalLogs, offset + batchSize)}...`);
		const logs = await db
			.select()
			.from(requestLogs)
			.where(gte(requestLogs.createdAt, since))
			.orderBy(asc(requestLogs.createdAt))
			.limit(batchSize)
			.offset(offset);

		console.log(`[batch] Loaded ${logs.length.toLocaleString()} logs. Building aggregations...`);

		const minuteMap = new Map<string, {
			bucketId: string;
			minuteStart: Date;
			requestCount: number;
			getCount: number;
			putCount: number;
			deleteCount: number;
			headCount: number;
			status2xx: number;
			status3xx: number;
			status4xx: number;
			status5xx: number;
			status401: number;
			status403: number;
			status404: number;
			status429: number;
			errorCount: number;
			ingressBytes: number;
			egressBytes: number;
			latencyTotalMs: number;
			latencyMaxMs: number;
		}>();

		const objectMap = new Map<string, {
			bucketId: string;
			objectKey: string;
			hitCount: number;
			errorCount: number;
			ingressBytes: number;
			egressBytes: number;
			lastAccessedAt: Date;
		}>();

		for (const log of logs) {
			if (!log.bucketId) continue;
			touchedBucketIds.add(log.bucketId);

			const minuteStart = floorToMinute(new Date(log.createdAt));
			const minuteKey = `${log.bucketId}:${minuteStart.toISOString()}`;
			const minute = minuteMap.get(minuteKey) || {
				bucketId: log.bucketId,
				minuteStart,
				requestCount: 0,
				getCount: 0,
				putCount: 0,
				deleteCount: 0,
				headCount: 0,
				status2xx: 0,
				status3xx: 0,
				status4xx: 0,
				status5xx: 0,
				status401: 0,
				status403: 0,
				status404: 0,
				status429: 0,
				errorCount: 0,
				ingressBytes: 0,
				egressBytes: 0,
				latencyTotalMs: 0,
				latencyMaxMs: 0,
			};

			minute.requestCount += 1;
			if (log.method === "GET") minute.getCount += 1;
			else if (log.method === "PUT") minute.putCount += 1;
			else if (log.method === "DELETE") minute.deleteCount += 1;
			else if (log.method === "HEAD") minute.headCount += 1;

			if (log.statusCode >= 200 && log.statusCode < 300) minute.status2xx += 1;
			else if (log.statusCode >= 300 && log.statusCode < 400) minute.status3xx += 1;
			else if (log.statusCode >= 400 && log.statusCode < 500) minute.status4xx += 1;
			else if (log.statusCode >= 500) minute.status5xx += 1;

			if (log.statusCode === 401) minute.status401 += 1;
			if (log.statusCode === 403) minute.status403 += 1;
			if (log.statusCode === 404) minute.status404 += 1;
			if (log.statusCode === 429) minute.status429 += 1;
			if (log.statusCode >= 400) minute.errorCount += 1;

			minute.ingressBytes += Number(log.ingressBytes || 0);
			minute.egressBytes += Number(log.egressBytes || 0);
			minute.latencyTotalMs += Number(log.latencyMs || 0);
			minute.latencyMaxMs = Math.max(minute.latencyMaxMs, Number(log.latencyMs || 0));
			minuteMap.set(minuteKey, minute);

			const objectKey = objectKeyFromPath(log.path);
			const objectMapKey = `${log.bucketId}:${objectKey}`;
			const objectEntry = objectMap.get(objectMapKey) || {
				bucketId: log.bucketId,
				objectKey,
				hitCount: 0,
				errorCount: 0,
				ingressBytes: 0,
				egressBytes: 0,
				lastAccessedAt: new Date(log.createdAt),
			};

			objectEntry.hitCount += 1;
			if (log.statusCode >= 400) objectEntry.errorCount += 1;
			objectEntry.ingressBytes += Number(log.ingressBytes || 0);
			objectEntry.egressBytes += Number(log.egressBytes || 0);
			if (new Date(log.createdAt) > objectEntry.lastAccessedAt) {
				objectEntry.lastAccessedAt = new Date(log.createdAt);
			}
			objectMap.set(objectMapKey, objectEntry);
		}

		console.log(
			`[batch] Prepared ${minuteMap.size.toLocaleString()} minute buckets and ${objectMap.size.toLocaleString()} object buckets. Writing to DB...`,
		);

		for (const minute of minuteMap.values()) {
			const existing = await db
				.select({ id: bucketAnalyticsMinute.id })
				.from(bucketAnalyticsMinute)
				.where(
					and(
						eq(bucketAnalyticsMinute.bucketId, minute.bucketId),
						eq(bucketAnalyticsMinute.minuteStart, minute.minuteStart),
					),
				)
				.limit(1);

			if (existing[0]) {
				await db
					.update(bucketAnalyticsMinute)
					.set({
						requestCount: sql`${bucketAnalyticsMinute.requestCount} + ${minute.requestCount}`,
						getCount: sql`${bucketAnalyticsMinute.getCount} + ${minute.getCount}`,
						putCount: sql`${bucketAnalyticsMinute.putCount} + ${minute.putCount}`,
						deleteCount: sql`${bucketAnalyticsMinute.deleteCount} + ${minute.deleteCount}`,
						headCount: sql`${bucketAnalyticsMinute.headCount} + ${minute.headCount}`,
						status2xx: sql`${bucketAnalyticsMinute.status2xx} + ${minute.status2xx}`,
						status3xx: sql`${bucketAnalyticsMinute.status3xx} + ${minute.status3xx}`,
						status4xx: sql`${bucketAnalyticsMinute.status4xx} + ${minute.status4xx}`,
						status5xx: sql`${bucketAnalyticsMinute.status5xx} + ${minute.status5xx}`,
						status401: sql`${bucketAnalyticsMinute.status401} + ${minute.status401}`,
						status403: sql`${bucketAnalyticsMinute.status403} + ${minute.status403}`,
						status404: sql`${bucketAnalyticsMinute.status404} + ${minute.status404}`,
						status429: sql`${bucketAnalyticsMinute.status429} + ${minute.status429}`,
						errorCount: sql`${bucketAnalyticsMinute.errorCount} + ${minute.errorCount}`,
						ingressBytes: sql`${bucketAnalyticsMinute.ingressBytes} + ${minute.ingressBytes}`,
						egressBytes: sql`${bucketAnalyticsMinute.egressBytes} + ${minute.egressBytes}`,
						latencyTotalMs: sql`${bucketAnalyticsMinute.latencyTotalMs} + ${minute.latencyTotalMs}`,
						latencyMaxMs: Math.max(minute.latencyMaxMs, minute.latencyMaxMs),
						updatedAt: new Date(),
					})
					.where(eq(bucketAnalyticsMinute.id, existing[0].id));
			} else {
				await db.insert(bucketAnalyticsMinute).values(minute);
			}
		}

		for (const objectEntry of objectMap.values()) {
			const existing = await db
				.select({ id: bucketObjectAnalytics.id })
				.from(bucketObjectAnalytics)
				.where(
					and(
						eq(bucketObjectAnalytics.bucketId, objectEntry.bucketId),
						eq(bucketObjectAnalytics.objectKey, objectEntry.objectKey),
					),
				)
				.limit(1);

			if (existing[0]) {
				await db
					.update(bucketObjectAnalytics)
					.set({
						hitCount: sql`${bucketObjectAnalytics.hitCount} + ${objectEntry.hitCount}`,
						errorCount: sql`${bucketObjectAnalytics.errorCount} + ${objectEntry.errorCount}`,
						ingressBytes: sql`${bucketObjectAnalytics.ingressBytes} + ${objectEntry.ingressBytes}`,
						egressBytes: sql`${bucketObjectAnalytics.egressBytes} + ${objectEntry.egressBytes}`,
						lastAccessedAt: objectEntry.lastAccessedAt,
						updatedAt: new Date(),
					})
					.where(eq(bucketObjectAnalytics.id, existing[0].id));
			} else {
				await db.insert(bucketObjectAnalytics).values(objectEntry);
			}
		}

		processed += logs.length;
		offset += logs.length;
		const percent = ((processed / totalLogs) * 100).toFixed(1);
		console.log(`[batch] Done. Processed ${processed.toLocaleString()} / ${totalLogs.toLocaleString()} logs (${percent}%).`);
	}

	console.log(`\nRefreshing snapshots for ${touchedBucketIds.size.toLocaleString()} bucket(s)...`);
	let snapshotIndex = 0;
	for (const bucketId of touchedBucketIds) {
		snapshotIndex += 1;
		console.log(`[snapshot] ${snapshotIndex}/${touchedBucketIds.size} -> ${bucketId}`);
		await analyticsService.refreshBucketSnapshot(bucketId);
	}

	console.log("\n✅ Bucket analytics backfill complete.");
	console.log(`Processed logs: ${processed.toLocaleString()}`);
	console.log(`Buckets refreshed: ${touchedBucketIds.size.toLocaleString()}`);
}

main().catch((error) => {
	console.error("\n❌ Bucket analytics backfill failed.");
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exit(1);
});
