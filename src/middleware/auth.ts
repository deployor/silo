import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { bucketKeys, buckets, users } from "../db/schema";
import { verifyAwsV4Signature } from "../lib/auth-v4";
import { context } from "../lib/context";
import { redis } from "../lib/redis";
import { S3Errors } from "../lib/s3-errors";

const S3_DOMAIN = config.s3Domain;
const AUTH_CACHE_TTL_SECONDS = 300;
const AUTH_USER_CACHE_TTL_SECONDS = 15;

type CachedPublicAuth = {
	bucket: typeof buckets.$inferSelect;
	userId: string | null;
};

type CachedKeyAuth = {
	bucket: typeof buckets.$inferSelect;
	key: typeof bucketKeys.$inferSelect;
	userId: string;
};

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

async function getFreshUserById(userId: string) {
	const cacheKey = `auth:user:${userId}`;

	try {
		const cached = await redis.get(cacheKey);
		if (cached) {
			return JSON.parse(cached) as typeof users.$inferSelect;
		}
	} catch (e) {
		console.error("Redis user cache error:", e);
	}

	const userRow = await db
		.select()
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (userRow.length === 0) return null;
	const user = userRow[0];

	try {
		await redis.set(
			cacheKey,
			JSON.stringify(user),
			"EX",
			AUTH_USER_CACHE_TTL_SECONDS,
		);
	} catch (e) {
		console.error("Failed to cache user auth state:", e);
	}

	return user;
}

async function getPublicAuthContext(requestedBucket: string): Promise<{
	bucket: typeof buckets.$inferSelect;
	userId: string | null;
} | null> {
	const cacheKeyPub = `auth:pub:${requestedBucket}`;

	try {
		const cachedStr = await redis.get(cacheKeyPub);
		if (cachedStr) {
			const cached = JSON.parse(cachedStr) as CachedPublicAuth;
			if (cached?.bucket) {
				return { bucket: cached.bucket, userId: cached.userId ?? null };
			}
		}
	} catch (e) {
		console.error("Redis pub cache error:", e);
	}

	const bucketResult = await db
		.select({
			bucket: buckets,
			user: users,
		})
		.from(buckets)
		.leftJoin(users, eq(buckets.userId, users.id))
		.where(eq(buckets.name, requestedBucket))
		.limit(1);

	if (bucketResult.length === 0) {
		return null;
	}

	const bucket = bucketResult[0].bucket;
	const userId = bucketResult[0].user?.id ?? null;

	try {
		await redis.set(
			cacheKeyPub,
			JSON.stringify({ bucket, userId }),
			"EX",
			AUTH_CACHE_TTL_SECONDS,
		);
	} catch (e) {
		console.error("Failed to cache public bucket:", e);
	}

	return { bucket, userId };
}

async function getSignedAuthContext(accessKeyId: string): Promise<{
	bucket: typeof buckets.$inferSelect;
	key: typeof bucketKeys.$inferSelect;
	userId: string;
} | null> {
	const cacheKeyAuth = `auth:key:${accessKeyId}`;

	try {
		const cachedStr = await redis.get(cacheKeyAuth);
		if (cachedStr) {
			const cached = JSON.parse(cachedStr) as CachedKeyAuth;
			if (cached?.bucket && cached?.key && cached?.userId) {
				return cached;
			}
		}
	} catch (e) {
		console.error("Redis auth cache error:", e);
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
		return null;
	}

	const resolved = {
		bucket: keyResult[0].bucket,
		key: keyResult[0].key,
		userId: keyResult[0].user.id,
	};

	try {
		await redis.set(
			cacheKeyAuth,
			JSON.stringify(resolved),
			"EX",
			AUTH_CACHE_TTL_SECONDS,
		);
	} catch (e) {
		console.error("Failed to cache auth:", e);
	}

	return resolved;
}

export type AuthResult =
	| {
			user: typeof users.$inferSelect | null;
			bucket: typeof buckets.$inferSelect;
			mode: "authenticated" | "public";
	  }
	| Response;

export const authenticate = async (req: Request): Promise<AuthResult> => {
	const credential = getCredential(req);

	if (!credential) {
		if (req.method === "OPTIONS") {
			const requestedBucket = getBucketFromRequest(req);
			if (!requestedBucket) {
				return new Response(null, { status: 400 });
			}

			const authContext = await getPublicAuthContext(requestedBucket);
			if (!authContext) {
				return new Response(null, { status: 404 });
			}

			const bucket = authContext.bucket;
			const user = authContext.userId
				? await getFreshUserById(authContext.userId)
				: null;

			if (!user && !bucket.isSystem) {
				return new Response(null, { status: 404 });
			}

			const ctx = context.getStore();
			if (ctx) {
				ctx.user = user || undefined;
				ctx.bucket = bucket;
				ctx.mode = "public";
			}
			return { user, bucket, mode: "public" };
		}

		if (req.method !== "GET" && req.method !== "HEAD") {
			return S3Errors.AccessDenied().toResponse();
		}

		const requestedBucket = getBucketFromRequest(req);
		if (!requestedBucket) {
			return S3Errors.AccessDenied().toResponse();
		}

		const authContext = await getPublicAuthContext(requestedBucket);
		if (!authContext) {
			return S3Errors.AccessDenied().toResponse();
		}

		const bucket = authContext.bucket;
		let user: typeof users.$inferSelect | null = authContext.userId
			? await getFreshUserById(authContext.userId)
			: null;

		if (!user) {
			if (bucket.isSystem) {
				if (bucket.isPaused) {
					return S3Errors.AccessDenied(
						`Bucket is temporarily paused.${bucket.pauseReason ? ` Reason: ${bucket.pauseReason}` : ""}`,
					).toResponse();
				}

				if (!bucket.isPublic) {
					return S3Errors.AccessDenied().toResponse();
				}

				const ctx = context.getStore();
				if (ctx) {
					ctx.user = undefined;
					ctx.bucket = bucket;
					ctx.mode = "public";
				}
				return { user: null, bucket, mode: "public" };
			}
			return S3Errors.AccessDenied().toResponse();
		}

		// Always refresh dynamic user fields for quota checks (storage/egress/lock/immortal).
		const freshUser = await getFreshUserById(user.id);
		if (!freshUser) {
			return S3Errors.AccessDenied().toResponse();
		}
		user = freshUser;

		if (user.isLocked) {
			return S3Errors.AccessDenied(
				"Account is temporarily locked.",
			).toResponse();
		}

		if (user.dataExported || user.filesDeleted) {
			if (req.method !== "GET" && req.method !== "HEAD") {
				return S3Errors.AccessDenied(
					"Account is frozen. Modifications are disabled.",
				).toResponse();
			}
		}

		if (bucket.isPaused) {
			return S3Errors.AccessDenied(
				`Bucket is temporarily paused.${bucket.pauseReason ? ` Reason: ${bucket.pauseReason}` : ""}`,
			).toResponse();
		}

		if (!bucket.isPublic) {
			return S3Errors.AccessDenied().toResponse();
		}

		const ctx = context.getStore();
		if (ctx) {
			ctx.user = user;
			ctx.bucket = bucket;
			ctx.mode = "public";
		}

		return { user, bucket, mode: "public" };
	}

	const [accessKeyId, _dateStamp, _region, service, _requestType] =
		credential.split("/");

	if (service !== "s3") {
		return S3Errors.InvalidRequest("Invalid Service").toResponse();
	}

	const authContext = await getSignedAuthContext(accessKeyId);
	if (!authContext) {
		return S3Errors.InvalidAccessKeyId().toResponse();
	}

	const bucket = authContext.bucket;
	const key = authContext.key;
	let user = await getFreshUserById(authContext.userId);
	if (!user) {
		return S3Errors.InvalidAccessKeyId().toResponse();
	}

	// Always refresh dynamic user fields for quota checks (storage/egress/lock/immortal).
	const freshUser = await getFreshUserById(user.id);
	if (!freshUser) {
		return S3Errors.AccessDenied().toResponse();
	}
	user = freshUser;

	if (user.isLocked) {
		return S3Errors.AccessDenied("Account is temporarily locked.").toResponse();
	}

	if (user.dataExported || user.filesDeleted) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return S3Errors.AccessDenied(
				"Account is frozen. Modifications are disabled.",
			).toResponse();
		}
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

	if (requestedBucket && requestedBucket !== bucket.name) {
		return S3Errors.AccessDenied().toResponse();
	}

	const amzDate = getDate(req);
	if (!amzDate)
		return S3Errors.AccessDenied("Missing Date Header").toResponse();

	const isValid = await verifyAwsV4Signature(req, key.secretKey);
	if (!isValid) {
		return S3Errors.SignatureDoesNotMatch().toResponse();
	}

	const ctx = context.getStore();
	if (ctx) {
		ctx.user = user;
		ctx.bucket = bucket;
		ctx.mode = "authenticated";
	}

	return { user, bucket, mode: "authenticated" };
};
