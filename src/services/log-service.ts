import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { objectStats } from "../db/schema";
import { getContext } from "../lib/context";
import { getMaintenanceStatus } from "./maintenance-service";

interface LogEntry {
	id: string;
	bucketId: string;
	bucketName: string;
	ownerId: string;
	requesterId: string | null;
	method: string;
	path: string;
	statusCode: number;
	ingressBytes: number;
	egressBytes: number;
	ipAddress: string;
	userAgent: string | null;
	latencyMs: number;
}

function getObjectKeyFromLogEntry(entry: LogEntry): string | null {
	const rawPath = entry.path.startsWith("/") ? entry.path.slice(1) : entry.path;
	if (!rawPath) return null;

	const bucketPrefix = `${entry.bucketName}/`;
	const withoutBucketPrefix = rawPath.startsWith(bucketPrefix)
		? rawPath.slice(bucketPrefix.length)
		: rawPath;

	if (!withoutBucketPrefix) return null;

	try {
		return decodeURIComponent(withoutBucketPrefix);
	} catch {
		return withoutBucketPrefix;
	}
}

class LogService {
	private queue: LogEntry[] = [];
	private flushTimer: Timer | null = null;
	private readonly BATCH_SIZE = 100;
	private readonly FLUSH_INTERVAL_MS = 5000;

	public logRequest(response: Response, ingress: number = 0) {
		const ctx = getContext();
		if (!ctx?.bucket || !ctx.user) return;

		const duration = Math.round(performance.now() - ctx.startTime);
		const egress = parseInt(response.headers.get("content-length") || "0", 10);

		const entry = {
			id: ctx.requestId,
			bucketId: ctx.bucket.id,
			bucketName: ctx.bucket.name,
			ownerId: ctx.user.id,
			requesterId: ctx.mode === "authenticated" ? ctx.user.id : null,
			method: ctx.method,
			path: ctx.path,
			statusCode: response.status,
			ingressBytes: ingress,
			egressBytes: egress,
			ipAddress: ctx.ip,
			userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 255) : null,
			latencyMs: duration,
		};

		// Access telemetry is append-only analytics data. Emit a structured event
		// for the regional Vector collectors; they durably deliver it to both
		// ClickHouse nodes. S3 success never depends on either log database.
		console.log(
			JSON.stringify({
				event: "silo.request",
				event_time: new Date().toISOString(),
				request_id: entry.id,
				region: process.env.SILO_REGION || "global",
				service: "silo-control-plane",
				instance: process.env.SILO_INSTANCE_ID || "control-plane",
				storage_region: ctx.bucket.resolvedRegion || "",
				action: "dashboard",
				bucket_id: entry.bucketId,
				bucket_name: entry.bucketName,
				owner_id: entry.ownerId,
				requester_id: entry.requesterId || "",
				method: entry.method,
				path: entry.path,
				status_code: entry.statusCode,
				ingress_bytes: entry.ingressBytes,
				egress_bytes: entry.egressBytes,
				ip_address: entry.ipAddress,
				user_agent: entry.userAgent || "",
				latency_ms: entry.latencyMs,
			}),
		);

		this.queue.push(entry);

		if (this.queue.length >= this.BATCH_SIZE) {
			this.flush();
		} else {
			this.scheduleFlush();
		}
	}

	private async flush() {
		if (this.queue.length === 0) return;
		if ((await getMaintenanceStatus()).fullMaintenanceMode) {
			this.scheduleFlush();
			return;
		}

		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}

		const batch = [...this.queue];
		this.queue = [];

		try {
			const objectEntries = batch.filter(
				(entry) =>
					entry.path.startsWith("/") &&
					!entry.path.startsWith("/api/") &&
					!entry.path.startsWith("/admin") &&
					entry.path !== "/",
			);

			const aggregates = new Map<
				string,
				{
					bucketId: string;
					objectKey: string;
					hitCount: number;
					errorCount: number;
					egressBytes: number;
				}
			>();

			for (const entry of objectEntries) {
				const objectKey = getObjectKeyFromLogEntry(entry);
				if (!objectKey) continue;
				const aggregateKey = `${entry.bucketId}\0${objectKey}`;
				const aggregate = aggregates.get(aggregateKey) || {
					bucketId: entry.bucketId,
					objectKey,
					hitCount: 0,
					errorCount: 0,
					egressBytes: 0,
				};
				aggregate.hitCount += 1;
				aggregate.errorCount += entry.statusCode >= 400 ? 1 : 0;
				aggregate.egressBytes += entry.egressBytes;
				aggregates.set(aggregateKey, aggregate);
			}

			for (const aggregate of aggregates.values()) {
				const existing = await db
					.select({ id: objectStats.id })
					.from(objectStats)
					.where(
						and(
							eq(objectStats.bucketId, aggregate.bucketId),
							eq(objectStats.objectKey, aggregate.objectKey),
						),
					)
					.limit(1);

				if (existing[0]) {
					await db
						.update(objectStats)
						.set({
							hitCount: sql`${objectStats.hitCount} + ${aggregate.hitCount}`,
							errorCount:
								aggregate.errorCount > 0
									? sql`${objectStats.errorCount} + ${aggregate.errorCount}`
									: sql`${objectStats.errorCount}`,
							egressBytes: sql`${objectStats.egressBytes} + ${aggregate.egressBytes}`,
							lastAccessedAt: new Date(),
							updatedAt: new Date(),
						})
						.where(eq(objectStats.id, existing[0].id));
				} else {
					await db.insert(objectStats).values({
						bucketId: aggregate.bucketId,
						objectKey: aggregate.objectKey,
						hitCount: aggregate.hitCount,
						errorCount: aggregate.errorCount,
						egressBytes: aggregate.egressBytes,
						lastAccessedAt: new Date(),
						updatedAt: new Date(),
					});
				}
			}
		} catch (e) {
			console.error("Failed to flush log batch:", e);
		}
	}

	private scheduleFlush() {
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = null;
				this.flush();
			}, this.FLUSH_INTERVAL_MS);
		}
	}

	public async shutdown() {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flush();
	}
}

export const logService = new LogService();
