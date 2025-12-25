import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { config } from "../../config";
import { db } from "../../db";
import { buckets, requestLogs, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";

// --- Types ---

interface LogEntry {
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

// --- Constants ---

const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 5000;

// --- State ---

let logQueue: LogEntry[] = [];
let flushTimer: Timer | null = null;

// --- Helper Functions ---

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

	if (path === "/" || path === `/${bucketName}`) return "";

	return path.startsWith("/") ? path.slice(1) : path;
}

export function getInternalPath(
	key: string,
	user: typeof users.$inferSelect,
	bucket: typeof buckets.$inferSelect,
): string {
	const cleanKey = key.startsWith("/") ? key.slice(1) : key;
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

export function isReservedBucketName(name: string): boolean {
	return /^[uw][a-z0-9]{7,}$/.test(name);
}

// --- Async Operations ---

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

		const deleteBody = `<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${objects}</Delete>`;
		const md5 = createHash("md5").update(deleteBody).digest("base64");

		const deleteRes = await s3Client.fetch("?delete", {
			method: "POST",
			headers: {
				"Content-Type": "application/xml",
				"Content-MD5": md5,
			},
			body: deleteBody,
		});

		if (!deleteRes.ok)
			throw new Error(`Failed to delete objects: ${deleteRes.status}`);

		continuationToken = result.NextContinuationToken;
	} while (continuationToken);
}

export async function rewriteCopySourceHeader(
	_req: Request,
	headerValue: string,
	currentUser: typeof users.$inferSelect,
): Promise<string | null> {
	const clean = headerValue.startsWith("/") ? headerValue.slice(1) : headerValue;

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

	if (sourceBucket.isCdn) return null;

	if (!currentUser || sourceBucket.userId !== currentUser.id) {
		return null;
	}

	const sanitizedUserId = sourceBucket.userId.replace(/[^a-zA-Z0-9-]/g, "_");
	const internalPath = `users/${sanitizedUserId}/${sourceBucket.name}/${key}`;

	return `/${config.s3.bucket}/${internalPath}`;
}

// --- Logging & Stats ---

async function flushLogs() {
	if (logQueue.length === 0) return;

	const batch = [...logQueue];
	logQueue = [];

	try {
		await db.insert(requestLogs).values(batch);
	} catch (e) {
		console.error("Failed to flush log batch:", e);
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

	// 1. Update aggregates immediately
	try {
		await db.transaction(async (tx) => {
			await tx
				.update(users)
				.set({
					ingressBytes: sql`COALESCE(${users.ingressBytes}, 0) + ${ingress}`,
					egressBytes: sql`COALESCE(${users.egressBytes}, 0) + ${egress}`,
					totalRequests: sql`COALESCE(${users.totalRequests}, 0) + 1`,
				})
				.where(eq(users.id, user.id));

			await tx
				.update(buckets)
				.set({
					totalRequests: sql`COALESCE(${buckets.totalRequests}, 0) + 1`,
				})
				.where(eq(buckets.id, bucket.id));
		});
	} catch (e) {
		console.error("Failed to update aggregate stats:", e);
	}

	// 2. Queue detailed log for batch insertion
	logQueue.push({
		bucketId: bucket.id,
		bucketName: bucket.name,
		ownerId: user.id,
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
		flushLogs();
	} else {
		scheduleFlush();
	}
}
