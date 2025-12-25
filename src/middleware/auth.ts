import { eq, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { bucketKeys, buckets, users } from "../db/schema";
import { verifyAwsV4Signature } from "../lib/auth-v4";
import { S3Errors } from "../lib/s3-errors";

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

	if (authHeader?.startsWith("AWS4-HMAC-SHA256")) {
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
			mode: "authenticated" | "public";
	  }
	| Response;

export const authenticate = async (req: Request): Promise<AuthResult> => {
	const credential = getCredential(req);

	if (!credential) {
		// Allow OPTIONS requests for CORS preflight
		if (req.method === "OPTIONS") {
			const requestedBucket = getBucketFromRequest(req);
			if (!requestedBucket) {
				return new Response(null, { status: 400 });
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
				return new Response(null, { status: 404 });
			}

			const { bucket, user } = bucketResult[0];
			return { user, bucket, mode: "public" };
		}

		if (req.method !== "GET" && req.method !== "HEAD") {
			return S3Errors.AccessDenied().toResponse();
		}

		const requestedBucket = getBucketFromRequest(req);
		if (!requestedBucket) {
			return S3Errors.AccessDenied().toResponse();
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
			return S3Errors.AccessDenied().toResponse();
		}

		const { bucket, user } = bucketResult[0];

		// Calculate storage usage from all buckets
		const usageResult = await db
			.select({ total: sql<number>`sum(${buckets.totalBytes})` })
			.from(buckets)
			.where(eq(buckets.userId, user.id));

		user.storageUsageBytes = Number(usageResult[0]?.total) || 0;

		if (user.isLocked) {
			return S3Errors.AccessDenied(
				"Account is temporarily locked.",
			).toResponse();
		}

		if (bucket.isPaused) {
			return S3Errors.AccessDenied(
				`Bucket is temporarily paused.${bucket.pauseReason ? ` Reason: ${bucket.pauseReason}` : ""}`,
			).toResponse();
		}

		if (!bucket.isPublic) {
			return S3Errors.AccessDenied().toResponse();
		}

		return { user, bucket, mode: "public" };
	}

	const [accessKeyId, _dateStamp, _region, service, _requestType] =
		credential.split("/");

	if (service !== "s3") {
		return S3Errors.InvalidRequest("Invalid Service").toResponse();
	}

	const keyResult = await db
		.select({
			bucket: buckets,
			user: users,
			key: bucketKeys,
		})
		.from(bucketKeys)
		.innerJoin(buckets, eq(bucketKeys.bucketId, buckets.id))
		.innerJoin(users, eq(buckets.userId, users.id))
		.where(eq(bucketKeys.accessKey, accessKeyId))
		.limit(1);

	if (keyResult.length === 0) {
		return S3Errors.InvalidAccessKeyId().toResponse();
	}

	const { bucket, user, key } = keyResult[0];

	// Calculate storage usage from all buckets
	const usageResult = await db
		.select({ total: sql<number>`sum(${buckets.totalBytes})` })
		.from(buckets)
		.where(eq(buckets.userId, user.id));

	user.storageUsageBytes = Number(usageResult[0]?.total) || 0;

	if (user.isLocked) {
		return S3Errors.AccessDenied("Account is temporarily locked.").toResponse();
	}

	if (bucket.isPaused) {
		return S3Errors.AccessDenied(
			`Bucket is temporarily paused.${bucket.pauseReason ? ` Reason: ${bucket.pauseReason}` : ""}`,
		).toResponse();
	}

	if (key.isPaused) {
		return S3Errors.AccessDenied(
			`Access Key is temporarily paused.${key.pauseReason ? ` Reason: ${key.pauseReason}` : ""}`,
		).toResponse();
	}

	const requestedBucket = getBucketFromRequest(req);

	// If requestedBucket is present (Path-Style or Virtual-Host), it MUST match the key's bucket.
	// If it is NOT present (Implicit Mode), we allow it and assume the key's bucket.
	if (requestedBucket && requestedBucket !== bucket.name) {
		return S3Errors.AccessDenied().toResponse();
	}

	const amzDate = getDate(req);
	if (!amzDate)
		return S3Errors.AccessDenied("Missing Date Header").toResponse();

	// Verify Signature
	const isValid = await verifyAwsV4Signature(req, key.secretKey);
	if (!isValid) {
		return S3Errors.SignatureDoesNotMatch().toResponse();
	}

	return { user, bucket, mode: "authenticated" };
};
