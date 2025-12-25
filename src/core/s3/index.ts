import { eq } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db";
import { buckets, type users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { S3Errors } from "../../lib/s3-errors";
import { getCorsHeaders, handleCorsPreflight } from "./cors";
import { handleDeleteRequest } from "./delete";
import { handleGetRequest } from "./get";
import { handlePostRequest } from "./post";
import { handlePutRequest } from "./put";
import {
	filterUpstreamHeaders,
	getInternalPath,
	getKeyFromRequest,
	stripAuthQueryParams,
} from "./utils";

export async function handleS3Request(
	req: Request,
	user: typeof users.$inferSelect,
	bucket: typeof buckets.$inferSelect,
	mode: "authenticated" | "public",
): Promise<Response> {
	const method = req.method;

	if (
		mode === "public" &&
		method !== "GET" &&
		method !== "HEAD" &&
		method !== "OPTIONS"
	) {
		return S3Errors.AccessDenied().toResponse();
	}

	const url = new URL(req.url);
	const S3_DOMAIN = config.s3Domain;
	const host = req.headers.get("host") || "";
	const key = getKeyFromRequest(req, bucket.name);

	// Handle ListBuckets
	if (
		(host === S3_DOMAIN && url.pathname === "/") ||
		(key === "" &&
			method === "GET" &&
			!url.searchParams.has("list-type") &&
			!url.searchParams.has("uploads") &&
			!url.searchParams.has("location"))
	) {
		if (host === S3_DOMAIN) {
			if (method === "GET") {
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
			return S3Errors.MethodNotAllowed().toResponse();
		}
	}

	const internalPath = getInternalPath(key, user, bucket);

	if (key === "") {
		if (method === "PUT" && !url.searchParams.has("cors")) {
			return S3Errors.AccessDenied(
				"Bucket creation is not allowed. Please use the dashboard.",
			).toResponse();
		}
		if (method === "DELETE" && !url.searchParams.has("cors")) {
			return S3Errors.AccessDenied(
				"Bucket deletion is not allowed. Please use the dashboard.",
			).toResponse();
		}
	}

	if (method === "OPTIONS") {
		return handleCorsPreflight(req, bucket);
	}

	if (method === "GET") {
		const corsHeaders = getCorsHeaders(req, bucket);
		return handleGetRequest(
			req,
			user,
			bucket,
			key,
			internalPath,
			url,
			corsHeaders,
		);
	}

	if (method === "PUT") {
		return handlePutRequest(req, user, bucket, key, internalPath, url);
	}

	if (method === "DELETE") {
		return handleDeleteRequest(req, bucket, internalPath, url, key);
	}

	if (method === "HEAD") {
		if (key === "") {
			return new Response(null, { status: 200 });
		}
		try {
			const cleanUrl = stripAuthQueryParams(url);
			const queryStr = cleanUrl.searchParams.toString();
			const pathWithQuery = queryStr
				? `${internalPath}?${queryStr}`
				: internalPath;

			const response = await s3Client.fetch(pathWithQuery, {
				method: "HEAD",
				headers: filterUpstreamHeaders(req.headers),
			});

			return new Response(null, {
				status: response.status,
				headers: response.headers,
			});
		} catch (_e) {
			return S3Errors.InternalError().toResponse();
		}
	}

	if (method === "POST") {
		return handlePostRequest(req, user, bucket, internalPath, url);
	}

	return S3Errors.MethodNotAllowed().toResponse();
}
