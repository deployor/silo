import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { config } from "../config";
import { getKeyFromRequest } from "../lib/s3/paths";
import { db } from "../db";
import {
	bucketKeys,
	buckets,
	offboardingExportSessions,
	users,
} from "../db/schema";
import { verifyAwsV4Signature } from "../lib/auth-v4";
import { resolveBucketByHostname } from "../lib/bucket-domains";
import { context } from "../lib/context";
import {
	deriveOffboardingExportSecret,
	expireOffboardingExportSessions,
	getOffboardingExportBucketForUser,
} from "../lib/offboarding-export";
import { redis } from "../lib/redis";
import { S3Errors } from "../lib/s3-errors";
import { getBucketDeepFreezeMessage } from "../services/deep-freeze-service";

const S3_DOMAIN = config.s3Domain;
const AUTH_CACHE_TTL_SECONDS = 300;
const AUTH_USER_CACHE_TTL_SECONDS = 15;
const HEX_HMAC_SHA256 = /^[0-9a-fA-F]{64}$/;

type CachedPublicAuth = {
	bucket: typeof buckets.$inferSelect;
	userId: string | null;
};

type CachedKeyAuth = {
	bucket: typeof buckets.$inferSelect;
	key: typeof bucketKeys.$inferSelect;
	userId: string;
};

async function getBucketFromRequest(req: Request): Promise<string | null> {
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

	const bucket = await resolveBucketByHostname(host).catch(() => null);
	if (bucket) {
		return bucket.name;
	}

	return null;
}

function hasDashboardSignedPreview(url: URL) {
	return url.searchParams.has("signature") && url.searchParams.has("expires");
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

function secureHexEquals(expected: string, actual: string) {
	if (expected.length !== actual.length || !HEX_HMAC_SHA256.test(actual)) {
		return false;
	}
	return timingSafeEqual(
		Buffer.from(expected, "hex"),
		Buffer.from(actual, "hex"),
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

async function getOffboardingExportAuthContext(accessKeyId: string) {
	await expireOffboardingExportSessions();
	const rows = await db
		.select({
			session: offboardingExportSessions,
			user: users,
		})
		.from(offboardingExportSessions)
		.innerJoin(users, eq(offboardingExportSessions.userId, users.id))
		.where(
			and(
				eq(offboardingExportSessions.accessKey, accessKeyId),
				isNull(offboardingExportSessions.revokedAt),
				gt(offboardingExportSessions.expiresAt, new Date()),
			),
		)
		.limit(1);

	return rows[0] || null;
}

export type AuthResult =
	| {
			user: typeof users.$inferSelect | null;
			bucket: typeof buckets.$inferSelect;
			mode: "authenticated" | "public";
	  }
	| Response;

export const authenticate = async (req: Request): Promise<AuthResult> => {
	if (req.method === "OPTIONS") {
		const requestedBucket = await getBucketFromRequest(req);
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

	const credential = getCredential(req);

	if (!credential) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return S3Errors.AccessDenied().toResponse();
		}

		const requestedBucket = await getBucketFromRequest(req);
		if (!requestedBucket) {
			return S3Errors.AccessDenied().toResponse();
		}

		const authContext = await getPublicAuthContext(requestedBucket);
		if (!authContext) {
			return S3Errors.AccessDenied().toResponse();
		}

		const bucket = authContext.bucket;
		const user: typeof users.$inferSelect | null = authContext.userId
			? await getFreshUserById(authContext.userId)
			: null;

		if (!user) {
			if (bucket.isSystem) {
				if (bucket.isPaused) {
					return S3Errors.AccessDenied(
						`Bucket is temporarily paused.${bucket.pauseReason ? ` Reason: ${bucket.pauseReason}` : ""}`,
					).toResponse();
				}

				const systemDeepFreezeMessage = getBucketDeepFreezeMessage(bucket);
				if (systemDeepFreezeMessage) {
					return S3Errors.AccessDenied(systemDeepFreezeMessage).toResponse();
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

		const publicDeepFreezeMessage = getBucketDeepFreezeMessage(bucket);
		if (publicDeepFreezeMessage) {
			return S3Errors.AccessDenied(publicDeepFreezeMessage).toResponse();
		}

		if (!bucket.isPublic) {
			if (!hasDashboardSignedPreview(new URL(req.url))) {
				return S3Errors.AccessDenied().toResponse();
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				return S3Errors.AccessDenied().toResponse();
			}
			let key = "";
			try {
				key = getKeyFromRequest(req, bucket.name);
			} catch {
				return S3Errors.AccessDenied().toResponse();
			}
			if (!key) {
				return S3Errors.AccessDenied().toResponse();
			}
			const url = new URL(req.url);
			const expires = url.searchParams.get("expires");
			const signature = url.searchParams.get("signature");
			if (!expires || !signature) {
				return S3Errors.AccessDenied().toResponse();
			}
			if (Date.now() > Number(expires)) {
				return S3Errors.AccessDenied("Signed URL expired.").toResponse();
			}
			const expectedSignature = createHmac("sha256", config.hcAuth.clientSecret)
				.update(`${bucket.name}:${key}:${expires}`)
				.digest("hex");
			if (!secureHexEquals(expectedSignature, signature)) {
				return S3Errors.AccessDenied("Invalid signed URL.").toResponse();
			}
		} else {
			const ctx = context.getStore();
			if (ctx) {
				ctx.user = user;
				ctx.bucket = bucket;
				ctx.mode = "public";
			}

			return { user, bucket, mode: "public" };
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
		const exportAuth = await getOffboardingExportAuthContext(accessKeyId);
		if (!exportAuth) {
			return S3Errors.InvalidAccessKeyId().toResponse();
		}

		const requestedBucket = await getBucketFromRequest(req);
		const bucket = requestedBucket
			? (
					await db
						.select()
						.from(buckets)
						.where(
							and(
								eq(buckets.name, requestedBucket),
								eq(buckets.userId, exportAuth.user.id),
							),
						)
						.limit(1)
				)[0] || null
			: await getOffboardingExportBucketForUser(exportAuth.user.id);

		if (!bucket) {
			return S3Errors.AccessDenied().toResponse();
		}

		const amzDate = getDate(req);
		if (!amzDate)
			return S3Errors.AccessDenied("Missing Date Header").toResponse();

		const derivedSecret = deriveOffboardingExportSecret(
			exportAuth.session.accessKey,
		);
		const isValid = await verifyAwsV4Signature(req, derivedSecret);
		if (!isValid) {
			return S3Errors.SignatureDoesNotMatch().toResponse();
		}

		await db
			.update(offboardingExportSessions)
			.set({
				usedAt: exportAuth.session.usedAt || new Date(),
				lastAccessedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(offboardingExportSessions.id, exportAuth.session.id));

		const ctx = context.getStore();
		if (ctx) {
			ctx.user = exportAuth.user;
			ctx.bucket = bucket;
			ctx.mode = "authenticated";
			ctx.isOffboardingExport = true;
			ctx.offboardingExportSessionId = exportAuth.session.id;
		}

		return { user: exportAuth.user, bucket, mode: "authenticated" };
	}

	const bucket = authContext.bucket;
	const key = authContext.key;
	const user = await getFreshUserById(authContext.userId);
	if (!user) {
		return S3Errors.InvalidAccessKeyId().toResponse();
	}

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

	const signedDeepFreezeMessage = getBucketDeepFreezeMessage(bucket);
	if (signedDeepFreezeMessage) {
		return S3Errors.AccessDenied(signedDeepFreezeMessage).toResponse();
	}

	if (key.isPaused) {
		return S3Errors.AccessDenied(
			`Access Key is temporarily paused.${key.pauseReason ? ` Reason: ${key.pauseReason}` : ""}`,
		).toResponse();
	}

	const requestedBucket = await getBucketFromRequest(req);

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
