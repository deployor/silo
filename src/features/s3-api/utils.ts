import { db } from "../../db";
import { buckets, users, requestLogs } from "../../db/schema";
import { eq, sql } from "drizzle-orm";

import { config } from "../../config";

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
  req: Request,
  headerValue: string,
  currentUser: typeof users.$inferSelect,
): Promise<string | null> {
  let clean = headerValue.startsWith("/") ? headerValue.slice(1) : headerValue;

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
  const ingress = parseInt(req.headers.get("content-length") || "0");
  const egress = parseInt(res.headers.get("content-length") || "0");
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
