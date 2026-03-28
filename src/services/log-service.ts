import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { objectStats, requestLogs } from "../db/schema";
import { getContext } from "../lib/context";

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

class LogService {
	private queue: LogEntry[] = [];
	private flushTimer: Timer | null = null;
	private readonly BATCH_SIZE = 100;
	private readonly FLUSH_INTERVAL_MS = 5000;

	public logRequest(response: Response, ingress: number = 0) {
		const ctx = getContext();
		if (!ctx || !ctx.bucket || !ctx.user) return;

		const duration = Math.round(performance.now() - ctx.startTime);
		const egress = parseInt(response.headers.get("content-length") || "0", 10);

		this.queue.push({
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
		});

		if (this.queue.length >= this.BATCH_SIZE) {
			this.flush();
		} else {
			this.scheduleFlush();
		}

	}

	private async flush() {
		if (this.queue.length === 0) return;

		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}

		const batch = [...this.queue];
		this.queue = [];

		try {
			await db.insert(requestLogs).values(batch);

			const objectEntries = batch.filter(
				(entry) =>
					entry.path.startsWith("/") &&
					!entry.path.startsWith("/api/") &&
					!entry.path.startsWith("/admin") &&
					entry.path !== "/",
			);

			for (const entry of objectEntries) {
				const objectKey = entry.path.replace(/^\/+/, "");
				const existing = await db
					.select({ id: objectStats.id })
					.from(objectStats)
					.where(
						and(
							eq(objectStats.bucketId, entry.bucketId),
							eq(objectStats.objectKey, objectKey),
						),
					)
					.limit(1);

				if (existing[0]) {
					await db
						.update(objectStats)
						.set({
							hitCount: sql`${objectStats.hitCount} + 1`,
							errorCount:
								entry.statusCode >= 400
									? sql`${objectStats.errorCount} + 1`
									: sql`${objectStats.errorCount}`,
							egressBytes: sql`${objectStats.egressBytes} + ${entry.egressBytes}`,
							lastAccessedAt: new Date(),
							updatedAt: new Date(),
						})
						.where(eq(objectStats.id, existing[0].id));
				} else {
					await db.insert(objectStats).values({
						bucketId: entry.bucketId,
						objectKey,
						hitCount: 1,
						errorCount: entry.statusCode >= 400 ? 1 : 0,
						egressBytes: entry.egressBytes,
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
