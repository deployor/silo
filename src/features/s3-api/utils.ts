import { eq, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { config } from "../../config";
import { db } from "../../db";
import { buckets, requestLogs, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";

export async function deleteBucketContents(prefix: string) {
	console.log(`[DELETE BUCKET] Emptying prefix: ${prefix}`);
	let continuationToken: string | undefined;
	do {
		const query = new URLSearchParams();
		query.set("list-type", "2");
		query.set("prefix", prefix);
		if (continuationToken) {
			query.set("continuation-token", continuationToken);
		}

		const res = await s3Client.fetch(`?${query.toString()}`, { method: "GET" });
		if (!res.ok) throw new Error(`Failed to list objects: ${res.status}`);

		const xml = await res.text();
		const parser = new XMLParser();
		const result = parser.parse(xml).ListBucketResult;

		if (!result.Contents) break;

		const contents = Array.isArray(result.Contents)
			? result.Contents
			: [result.Contents];

		if (contents.length === 0) break;

		console.log(`[DELETE BUCKET] Deleting ${contents.length} objects...`);

		const objects = contents
			.map((item: { Key: string }) => `<Object><Key>${item.Key}</Key></Object>`)
			.join("");

		const deleteBody = `<Delete><Quiet>true</Quiet>${objects}</Delete>`;

		const deleteRes = await s3Client.fetch("?delete", {
			method: "POST",
			body: deleteBody,
		});

		if (!deleteRes.ok)
			throw new Error(`Failed to delete objects: ${deleteRes.status}`);

		continuationToken = result.NextContinuationToken;
	} while (continuationToken);
}

export function getKeyFromRequest(req: Request, bucketName: string): string {
	const url = new URL(req.url);
	const host = url.host;
	const S3_DOMAIN = config.s3Domain;

	if (host.endsWith(`.${S3_DOMAIN}`) && host !== S3_DOMAIN) {
		return url.pathname.slice(1);
	}

	const path = url.pathname;
	const prefix = `/${bucketName}/`;

	if (path.startsWith(prefix)) {
		return path.slice(prefix.length);
	}

	// If we are in path-style mode but the path doesn't start with the bucket name,
	// it might be because we are already stripping it somewhere else or it's implicit.
	// However, for safety, if we are NOT in virtual-host mode, we should expect the bucket name.
	// But our logic in auth.ts handles the bucket extraction.
	// Here we just want the key.

	// If the path is just "/" or "/bucketName", the key is empty.
	if (path === "/" || path === `/${bucketName}`) return "";

	return path.startsWith("/") ? path.slice(1) : path;
}

export async function rewriteCopySourceHeader(
	_req: Request,
	headerValue: string,
	currentUser: typeof users.$inferSelect,
): Promise<string | null> {
	const clean = headerValue.startsWith("/")
		? headerValue.slice(1)
		: headerValue;

	const firstSlash = clean.indexOf("/");
	if (firstSlash === -1) return null;

	const bucketName = clean.slice(0, firstSlash);
	const key = clean.slice(firstSlash + 1);

	const bucketResult = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);
	if (bucketResult.length === 0) return null;

	const sourceBucket = bucketResult[0];

	if (!currentUser || sourceBucket.userId !== currentUser.id) {
		return null;
	}

	const sanitizedUserId = sourceBucket.userId.replace(/[^a-zA-Z0-9-]/g, "_");
	const internalPath = `users/${sanitizedUserId}/${sourceBucket.name}/${key}`;

	return `/${config.s3.bucket}/${internalPath}`;
}

export function getInternalPath(
	key: string,
	user: typeof users.$inferSelect,
	bucket: typeof buckets.$inferSelect,
): string {
	const cleanKey = key.startsWith("/") ? key.slice(1) : key;
	// Sanitize user ID to remove special characters that might break S3 paths
	const sanitizedUserId = user.id.replace(/[^a-zA-Z0-9-]/g, "_");
	return `users/${sanitizedUserId}/${bucket.name}/${cleanKey}`;
}

export function stripAuthQueryParams(url: URL): URL {
	const newUrl = new URL(url.toString());
	const paramsToRemove = [
		"X-Amz-Signature",
		"X-Amz-Credential",
		"X-Amz-Date",
		"X-Amz-Algorithm",
		"X-Amz-SignedHeaders",
		"X-Amz-Security-Token",
		"x-amz-signature",
		"x-amz-credential",
		"x-amz-date",
		"x-amz-algorithm",
		"x-amz-signedheaders",
		"x-amz-security-token",
		"X-Amz-Expires",
		"x-amz-expires",
	];
	for (const p of paramsToRemove) {
		newUrl.searchParams.delete(p);
	}
	return newUrl;
}

export function filterUpstreamHeaders(reqHeaders: Headers): Headers {
	const upstreamHeaders = new Headers();
	const allowedHeaders = [
		"content-type",
		"content-length",
		"content-md5",
		"cache-control",
		"content-disposition",
		"content-encoding",
		"content-language",
		"expires",
		"range",
		"if-match",
		"if-none-match",
		"if-modified-since",
		"if-unmodified-since",
	];

	reqHeaders.forEach((value, key) => {
		const lowerKey = key.toLowerCase();
		if (allowedHeaders.includes(lowerKey)) {
			upstreamHeaders.set(key, value);
		}
	});

	return upstreamHeaders;
}

// Batching configuration
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 5000;

interface LogEntry {
	bucketId: string;
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

let logQueue: LogEntry[] = [];
let flushTimer: Timer | null = null;

async function flushLogs() {
	if (logQueue.length === 0) return;

	const batch = [...logQueue];
	logQueue = [];

	try {
		await db.insert(requestLogs).values(batch);
	} catch (e) {
		console.error("Failed to flush log batch:", e);
		// Optionally re-queue failed logs or log to a fallback file
	}
}

function scheduleFlush() {
	if (!flushTimer) {
		flushTimer = setTimeout(() => {
			flushTimer = null;
			flushLogs();
		}, FLUSH_INTERVAL_MS);
	}
}

export async function updateStats(
	user: typeof users.$inferSelect,
	bucket: typeof buckets.$inferSelect,
	req: Request,
	res: Response,
	mode: "authenticated" | "public",
	durationMs: number,
) {
	const ingress = parseInt(req.headers.get("content-length") || "0", 10);
	const egress = parseInt(res.headers.get("content-length") || "0", 10);
	const method = req.method;
	const url = new URL(req.url);
	const path = url.pathname;
	const statusCode = res.status;
	const ip =
		req.headers.get("x-forwarded-for") ||
		req.headers.get("cf-connecting-ip") ||
		"unknown";
	const userAgent = req.headers.get("user-agent");

	// 1. Update aggregates immediately (critical for quotas/billing accuracy)
	// We do this individually to ensure consistency, but could also batch if needed.
	// For now, keeping it direct is safer for "live" limits.
	try {
		await db.transaction(async (tx) => {
			await tx
				.update(users)
				.set({
					ingressBytes: sql`${users.ingressBytes} + ${ingress}`,
					egressBytes: sql`${users.egressBytes} + ${egress}`,
					totalRequests: sql`${users.totalRequests} + 1`,
				})
				.where(eq(users.id, user.id));

			await tx
				.update(buckets)
				.set({
					totalRequests: sql`${buckets.totalRequests} + 1`,
				})
				.where(eq(buckets.id, bucket.id));
		});
	} catch (e) {
		console.error("Failed to update aggregate stats:", e);
	}

	// 2. Queue detailed log for batch insertion
	logQueue.push({
		bucketId: bucket.id,
		ownerId: user.id,
		// If authenticated, the requester is the user.
		// BUT, if the user is the owner, we can just store it.
		// The foreign key constraint requires requesterId to exist in users table.
		// If mode is authenticated, user object comes from DB, so it exists.
		// However, if we are in a test environment or something weird happens, maybe it fails?
		// The error says "request_logs_requester_id_users_id_fk" violation.
		// This implies `user.id` is being passed but doesn't exist in `users` table?
		// But `user` comes from `authenticate` which fetches from DB.
		// Wait, if `mode` is public, `requesterId` is null.
		// If `mode` is authenticated, `requesterId` is `user.id`.
		// Is it possible `user` is not the owner but the requester?
		// In `authenticate`, `user` is the owner of the bucket (or the key owner).
		// Ah, `authenticate` returns `{ user, bucket, mode }`.
		// If using keys, `user` is the owner of the bucket (joined from buckets->users).
		// So `user.id` is the owner.
		// Who is the requester?
		// If using keys, the requester IS the owner (or at least someone with keys for that bucket).
		// We don't have a separate "requester" user entity if they are just using keys.
		// The keys belong to the bucket, which belongs to the user.
		// So effectively the owner is the requester.
		//
		// The error might be happening if we are deleting a user but logs are still flushing?
		// Or if the user ID in the log doesn't match a user in the DB?
		//
		// Let's look at the error again: `insert or update on table "request_logs" violates foreign key constraint "request_logs_requester_id_users_id_fk"`
		// This means the value in `requester_id` column does not exist in `users.id`.
		//
		// In `updateStats`, we use `user.id` for `requesterId` if authenticated.
		// `user` is passed in.
		//
		// If this is happening during tests, maybe we delete the user before the logs flush?
		// Yes! `flushLogs` is async and batched.
		// In `scripts/test-admin.ts`, we delete users at the end.
		// If logs flush AFTER deletion, the FK constraint fails.
		//
		// We should probably set `onDelete: "set null"` for requesterId in the schema,
		// OR we just handle the error gracefully in `flushLogs` (which we do with try/catch),
		// BUT the user sees the error in the console.
		//
		// To fix the noise, we can try to flush logs before exiting tests,
		// OR we can just ignore the error in `flushLogs` more quietly.
		//
		// However, for production stability, `onDelete: "set null"` is better.
		// But I can't change schema easily without migration.
		//
		// Let's just make sure we don't log if the user might be gone, or just catch it better.
		// Actually, the user asked to "Fix this".
		//
		// If I change the schema now, I need to run migration.
		// Let's check `src/db/schema.ts` again.
		requesterId: mode === "authenticated" ? user.id : null,
		method,
		path,
		statusCode,
		ingressBytes: ingress,
		egressBytes: egress,
		ipAddress: ip,
		userAgent: userAgent ? userAgent.slice(0, 255) : null,
		latencyMs: durationMs,
	});

	if (logQueue.length >= BATCH_SIZE) {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		// Flush immediately if batch is full
		// We don't await this to keep the request handler fast
		flushLogs();
	} else {
		scheduleFlush();
	}
}
