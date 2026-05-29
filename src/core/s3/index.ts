import { eq } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db";
import { buckets, type users } from "../../db/schema";
import { context } from "../../lib/context";
import { diskCacheGetMeta } from "../../lib/disk-cache";
import { redis } from "../../lib/redis";
import { s3Client } from "../../lib/s3-client";
import { S3Errors } from "../../lib/s3-errors";
import { getCorsHeaders, handleCorsPreflight, withCorsResponse } from "./cors";
import { handleDeleteRequest } from "./delete";
import { handleGetRequest } from "./get";
import { handlePostRequest } from "./post";
import { handlePutRequest } from "./put";
import { determineAction, S3Action } from "./types";
import {
	filterUpstreamHeaders,
	getInternalPath,
	getKeyFromRequest,
	getObjectCacheKeys,
	stripAuthQueryParams,
} from "./utils";

export async function handleS3Request(
	req: Request,
	user: typeof users.$inferSelect | null,
	bucket: typeof buckets.$inferSelect,
	mode: "authenticated" | "public",
): Promise<Response> {
	const corsHeaders = getCorsHeaders(req, bucket);
	const withCors = (response: Response) =>
		withCorsResponse(response, corsHeaders);
	const method = req.method;
	const url = new URL(req.url);
	const S3_DOMAIN = config.s3Domain;
	const host = req.headers.get("host") || "";

	let key: string;
	try {
		key = getKeyFromRequest(req, bucket.name);
	} catch {
		// Treat invalid keys as AccessDenied (403) instead of 500.
		return withCors(S3Errors.AccessDenied().toResponse());
	}

	// Determine Action
	const action = determineAction(method, key, url.searchParams, req.headers);
	const ctx = context.getStore();
	const isOffboardingExport = Boolean(ctx?.isOffboardingExport);

	// Whitelist Check
	if (action === S3Action.Unknown) {
		return withCors(S3Errors.MethodNotAllowed().toResponse());
	}

	// Public Access Check
	if (mode === "public") {
		const allowedPublicActions = [
			S3Action.GetObject,
			S3Action.HeadObject,
			S3Action.ListObjectsV2,
			S3Action.Options,
		];
		if (!allowedPublicActions.includes(action)) {
			return withCors(S3Errors.AccessDenied().toResponse());
		}
	}

	if (isOffboardingExport) {
		const allowedExportActions = [
			S3Action.ListBuckets,
			S3Action.HeadBucket,
			S3Action.GetBucketLocation,
			S3Action.ListObjectsV2,
			S3Action.GetObject,
			S3Action.HeadObject,
			S3Action.Options,
		];
		if (!allowedExportActions.includes(action)) {
			return withCors(
				S3Errors.AccessDenied(
					"Offboarding export sessions are read-only.",
				).toResponse(),
			);
		}
		if (!user || bucket.userId !== user.id) {
			return withCors(S3Errors.AccessDenied().toResponse());
		}
	}

	// Handle ListBuckets (Service Root)
	if (
		(host === S3_DOMAIN && url.pathname === "/") ||
		(url.pathname === "/" &&
			key === "" &&
			method === "GET" &&
			!url.searchParams.has("list-type") &&
			!url.searchParams.has("uploads") &&
			!url.searchParams.has("location"))
	) {
		if (host === S3_DOMAIN) {
			if (method === "GET" && user) {
				const userBuckets = await db
					.select()
					.from(buckets)
					.where(eq(buckets.userId, user.id));

				const bucketsXml = userBuckets
					.map(
						(b) => `
	   <Bucket>
	     <Name>${b.name}</Name>
	     <CreationDate>${b.createdAt ? new Date(b.createdAt).toISOString() : new Date().toISOString()}</CreationDate>
	   </Bucket>`,
					)
					.join("");

				return new Response(
					`
<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
	 <Owner>
	   <ID>${user.id}</ID>
	   <DisplayName>${user.id}</DisplayName>
	 </Owner>
	 <Buckets>${bucketsXml}
	 </Buckets>
</ListAllMyBucketsResult>`.trim(),
					{
						headers: { "Content-Type": "application/xml" },
					},
				);
			}
			// If no user (public system bucket access attempt on root), or bad method
			if (!user) return withCors(S3Errors.AccessDenied().toResponse());
			return withCors(S3Errors.MethodNotAllowed().toResponse());
		}
	}

	const internalPath = getInternalPath(key, user, bucket);

	if (user) {
		if (user.dataExported && !isOffboardingExport) {
			return withCors(
				S3Errors.AccessDenied(
					"Account is frozen due to data export. No new modifications allowed.",
				).toResponse(),
			);
		}

		if (user.markedAsOverAge && !user.isImmortal) {
			if (method === "PUT" || method === "POST" || method === "DELETE") {
				return withCors(
					S3Errors.AccessDenied(
						"Account is in migration grace period. New uploads are disabled.",
					).toResponse(),
				);
			}
		}
	}

	// Explicitly block Bucket Creation/Deletion (handled by Dashboard)
	// Although determineAction maps them to Unknown if not CORS, we double check here for safety if logic changes
	if (key === "") {
		if (method === "PUT" && !url.searchParams.has("cors")) {
			return withCors(
				S3Errors.AccessDenied(
					"Bucket creation is not allowed. Please use the dashboard.",
				).toResponse(),
			);
		}
		if (method === "DELETE" && !url.searchParams.has("cors")) {
			return withCors(
				S3Errors.AccessDenied(
					"Bucket deletion is not allowed. Please use the dashboard.",
				).toResponse(),
			);
		}
	}

	if (method === "OPTIONS") {
		return handleCorsPreflight(req, bucket);
	}

	if (method === "GET") {
		return withCors(
			await handleGetRequest(
				req,
				user,
				bucket,
				key,
				internalPath,
				url,
				corsHeaders,
			),
		);
	}

	if (method === "PUT") {
		if (!user) return withCors(S3Errors.AccessDenied().toResponse());
		return withCors(
			await handlePutRequest(req, user, bucket, key, internalPath, url),
		);
	}

	if (method === "DELETE") {
		if (!user) return withCors(S3Errors.AccessDenied().toResponse());
		return withCors(
			await handleDeleteRequest(req, user, bucket, internalPath, url, key),
		);
	}

	if (method === "HEAD") {
		if (key === "") {
			return withCors(new Response(null, { status: 200 }));
		}
		try {
			const hasConditionalHead =
				req.headers.has("if-none-match") ||
				req.headers.has("if-modified-since") ||
				req.headers.has("if-match") ||
				req.headers.has("if-unmodified-since");

			// Check Redis for cached metadata
			const cacheKeyMeta = getObjectCacheKeys(bucket.id, key).meta;
			try {
				const cachedMeta = await redis.get(cacheKeyMeta);
				if (cachedMeta && !hasConditionalHead) {
					const headers = new Headers(JSON.parse(cachedMeta));
					return withCors(
						new Response(null, {
							status: 200,
							headers,
						}),
					);
				}
			} catch (e) {
				console.error("Redis meta cache error:", e);
			}

			if (!hasConditionalHead) {
				const diskMeta = await diskCacheGetMeta(bucket.id, key);
				if (diskMeta) {
					return withCors(
						new Response(null, {
							status: 200,
							headers: new Headers(diskMeta.headers),
						}),
					);
				}
			}

			const cleanUrl = stripAuthQueryParams(url);
			const queryStr = cleanUrl.searchParams.toString();
			const pathWithQuery = queryStr
				? `${internalPath}?${queryStr}`
				: internalPath;

			const response = await s3Client.fetch(pathWithQuery, {
				method: "HEAD",
				headers: filterUpstreamHeaders(req.headers),
			});

			const headers = new Headers(response.headers);
			// Cache metadata on miss if success
			if (response.status === 200) {
				const headersObj: Record<string, string> = {};
				headers.forEach((v, k) => {
					headersObj[k] = v;
				});
				redis
					.set(cacheKeyMeta, JSON.stringify(headersObj), "EX", 21600)
					.catch((e) => {
						console.error("Failed to cache HEAD metadata:", e);
					});
			}

			return withCors(
				new Response(null, {
					status: response.status,
					headers: headers,
				}),
			);
		} catch (_e) {
			return withCors(S3Errors.InternalError().toResponse());
		}
	}

	if (method === "POST") {
		if (!user) return withCors(S3Errors.AccessDenied().toResponse());
		return withCors(
			await handlePostRequest(req, user, bucket, internalPath, url),
		);
	}

	return withCors(S3Errors.MethodNotAllowed().toResponse());
}
