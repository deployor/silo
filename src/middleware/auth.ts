import { db } from "../db";
import { buckets, users } from "../db/schema";
import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { config } from "../config";

const S3_DOMAIN = config.s3Domain;

function getBucketFromRequest(req: Request): string | null {
  const url = new URL(req.url);
  const host = url.host;

  if (host.endsWith(`.${S3_DOMAIN}`) && host !== S3_DOMAIN) {
    return host.slice(0, -(S3_DOMAIN.length + 1));
  }

  if (
    host === S3_DOMAIN ||
    (S3_DOMAIN === "localhost:3000" && host.startsWith("localhost"))
  ) {
    const parts = url.pathname.split("/");
    if (parts.length > 1 && parts[1]) {
      return parts[1];
    }
  }

  return null;
}

function getCredential(req: Request) {
  const authHeader = req.headers.get("Authorization");

  if (authHeader && authHeader.startsWith("AWS4-HMAC-SHA256")) {
    const params = authHeader.slice("AWS4-HMAC-SHA256".length).trim();
    const credentialPart = params
      .split(",")
      .find((p) => p.trim().startsWith("Credential="));
    if (credentialPart) {
      return credentialPart.split("=")[1];
    }
  }

  const url = new URL(req.url);
  const query =
    url.searchParams.get("X-Amz-Credential") ||
    url.searchParams.get("x-amz-credential");
  if (query) return query;

  return null;
}

function getDate(req: Request) {
  const url = new URL(req.url);
  return (
    req.headers.get("X-Amz-Date") ||
    req.headers.get("x-amz-date") ||
    url.searchParams.get("X-Amz-Date") ||
    url.searchParams.get("x-amz-date")
  );
}

export type AuthResult =
  | {
      user: typeof users.$inferSelect;
      bucket: typeof buckets.$inferSelect;
    }
  | Response;

export const authenticate = async (req: Request): Promise<AuthResult> => {
  const credential = getCredential(req);

  if (!credential) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Access Denied", { status: 403 });
    }

    const requestedBucket = getBucketFromRequest(req);
    if (!requestedBucket) {
      return new Response("Access Denied", { status: 403 });
    }

    const bucketResult = await db
      .select({
        bucket: buckets,
        user: users,
      })
      .from(buckets)
      .innerJoin(users, eq(buckets.userId, users.id))
      .where(eq(buckets.name, requestedBucket))
      .limit(1);

    if (bucketResult.length === 0) {
      return new Response("Access Denied", { status: 403 });
    }

    const { bucket, user } = bucketResult[0];

    if (!bucket.isPublic) {
      return new Response("Access Denied", { status: 403 });
    }

    return { user, bucket };
  }

  const [accessKeyId, dateStamp, region, service, requestType] =
    credential.split("/");

  if (service !== "s3") {
    return new Response("Invalid Service", { status: 400 });
  }

  const bucketResult = await db
    .select({
      bucket: buckets,
      user: users,
    })
    .from(buckets)
    .innerJoin(users, eq(buckets.userId, users.id))
    .where(eq(buckets.accessKey, accessKeyId))
    .limit(1);

  if (bucketResult.length === 0) {
    return new Response("Invalid Access Key Id", { status: 403 });
  }

  const { bucket, user } = bucketResult[0];

  const requestedBucket = getBucketFromRequest(req);

  // If requestedBucket is present (Path-Style or Virtual-Host), it MUST match the key's bucket.
  // If it is NOT present (Implicit Mode), we allow it and assume the key's bucket.
  if (requestedBucket && requestedBucket !== bucket.name) {
    return new Response("Access Denied", { status: 403 });
  }

  const amzDate = getDate(req);
  if (!amzDate) return new Response("Missing Date", { status: 403 });

  return { user, bucket };
};
