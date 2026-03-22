import { and, eq, gte } from "drizzle-orm";
import { db } from "../src/db";
import {
	bucketAnalyticsMinute,
	bucketObjectAnalytics,
	requestLogs,
} from "../src/db/schema";
import { analyticsService } from "../src/services/analytics-service";

function floorToMinute(date: Date) {
	const next = new Date(date);
	next.setSeconds(0, 0);
	return next;
}

async function main() {
	const sinceArg = process.argv[2];
	const since = sinceArg
		? new Date(sinceArg)
		: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

	const logs = await db
		.select()
		.from(requestLogs)
		.where(gte(requestLogs.createdAt, since));

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
			ingressBytes: Number(log.ingressBytes || 0),
			egressBytes: Number(log.egressBytes || 0),
			latencyTotalMs: Number(log.latencyMs || 0),
			latencyMaxMs: Number(log.latencyMs || 0),
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

		const objectKey = log.path.startsWith("/")
			? log.path.split("/").filter(Boolean).slice(1).join("/")
			: log.path;
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

	for (const minute of minuteMap.values()) {
		await db.insert(bucketAnalyticsMinute).values(minute);
	}
	for (const objectEntry of objectMap.values()) {
		await db.insert(bucketObjectAnalytics).values(objectEntry);
	}

	const bucketIds = Array.from(new Set(logs.map((log) => log.bucketId).filter(Boolean)));
	for (const bucketId of bucketIds) {
		await analyticsService.refreshBucketSnapshot(bucketId as string);
	}

	console.log(`Backfilled analytics from ${logs.length} raw logs since ${since.toISOString()}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
