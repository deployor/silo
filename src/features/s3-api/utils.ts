import { db } from "../../db";
import { buckets } from "../../db/schema";
import { eq, sql } from "drizzle-orm";
import { users } from "../../db/schema";

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

  const internalPath = `users/${sourceBucket.userId}/${sourceBucket.name}/${key}`;

  return `/${config.s3.bucket}/${internalPath}`;
}

export function getInternalPath(
  key: string,
  user: typeof users.$inferSelect,
  bucket: typeof buckets.$inferSelect,
): string {
  const cleanKey = key.startsWith("/") ? key.slice(1) : key;
  return `users/${user.id}/${bucket.name}/${cleanKey}`;
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

export async function updateStats(
  user: typeof users.$inferSelect,
  bucket: typeof buckets.$inferSelect,
  req: Request,
  res: Response,
) {
  const ingress = parseInt(req.headers.get("content-length") || "0");
  const egress = parseInt(res.headers.get("content-length") || "0");

  try {
    await db
      .update(users)
      .set({
        ingressBytes: sql`${users.ingressBytes} + ${ingress}`,
        egressBytes: sql`${users.egressBytes} + ${egress}`,
        totalRequests: sql`${users.totalRequests} + 1`,
      })
      .where(eq(users.id, user.id));

    await db
      .update(buckets)
      .set({
        totalRequests: sql`${buckets.totalRequests} + 1`,
      })
      .where(eq(buckets.id, bucket.id));
  } catch (e) {
    console.error("Failed to update stats:", e);
  }
}
