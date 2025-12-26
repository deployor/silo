import { eq, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { db } from "../../db";
import { buckets, type users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { S3Errors } from "../../lib/s3-errors";
import {
	filterUpstreamHeaders,
	isReservedBucketName,
	rewriteCopySourceHeader,
	stripAuthQueryParams,
} from "./utils";

export async function handlePutRequest(
	req: Request,
	user: typeof users.$inferSelect,
	bucket: typeof buckets.$inferSelect,
	key: string,
	internalPath: string,
	url: URL,
) {
	if (
		key === "" &&
		!url.searchParams.has("cors") &&
		!url.searchParams.has("uploadId")
	) {
		if (isReservedBucketName(bucket.name)) {
			return S3Errors.AccessDenied(
				"Bucket name is reserved for system use.",
				`/${bucket.name}`,
			).toResponse();
		}
	}

	if (key === "" && url.searchParams.has("cors")) {
		const bodyText = await req.text();
		const parser = new XMLParser({
			ignoreAttributes: false,
			isArray: (name: string) => {
				return (
					[
						"CORSRule",
						"AllowedOrigin",
						"AllowedMethod",
						"AllowedHeader",
						"ExposeHeader",
					].indexOf(name) !== -1
				);
			},
		});

		try {
			const parsed = parser.parse(bodyText);

			if (!parsed.CORSConfiguration || !parsed.CORSConfiguration.CORSRule) {
				throw new Error("Invalid CORS Configuration");
			}

			const rulesArray = Array.isArray(parsed.CORSConfiguration.CORSRule)
				? parsed.CORSConfiguration.CORSRule
				: [parsed.CORSConfiguration.CORSRule];

			const rules = rulesArray.map((r: any) => {
				const allowedOrigins = r.AllowedOrigin
					? Array.isArray(r.AllowedOrigin)
						? r.AllowedOrigin
						: [r.AllowedOrigin]
					: [];

				const allowedMethods = r.AllowedMethod
					? Array.isArray(r.AllowedMethod)
						? r.AllowedMethod
						: [r.AllowedMethod]
					: [];

				const allowedHeaders = r.AllowedHeader
					? Array.isArray(r.AllowedHeader)
						? r.AllowedHeader
						: [r.AllowedHeader]
					: undefined;

				const exposeHeaders = r.ExposeHeader
					? Array.isArray(r.ExposeHeader)
						? r.ExposeHeader
						: [r.ExposeHeader]
					: undefined;

				return {
					ID: r.ID,
					AllowedOrigins: allowedOrigins,
					AllowedMethods: allowedMethods,
					AllowedHeaders: allowedHeaders,
					ExposeHeaders: exposeHeaders,
					MaxAgeSeconds: r.MaxAgeSeconds,
				};
			});

			const corsConfig = {
				CORSRules: rules,
			};

			await db
				.update(buckets)
				.set({ corsConfig: JSON.stringify(corsConfig) })
				.where(eq(buckets.id, bucket.id));

			return new Response(null, { status: 200 });
		} catch (_e) {
			return S3Errors.MalformedXML().toResponse();
		}
	}

	const limit = user.storageLimitBytes;
	const upstreamHeaders = filterUpstreamHeaders(req.headers);

	if (!upstreamHeaders.has("x-amz-content-sha256")) {
		upstreamHeaders.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
	}

	const copySource = req.headers.get("x-amz-copy-source");

	if (copySource) {
		const rewrittenSource = await rewriteCopySourceHeader(
			req,
			copySource,
			user,
		);
		if (!rewrittenSource) {
			return S3Errors.AccessDenied().toResponse();
		}
		upstreamHeaders.set("x-amz-copy-source", rewrittenSource);
	}

	try {
		const cleanUrl = stripAuthQueryParams(url);
		const queryStr = cleanUrl.searchParams.toString();
		const pathWithQuery = queryStr
			? `${internalPath}?${queryStr}`
			: internalPath;

		let requestBody: unknown = req.body;
		let actualSize = 0;

		if (!copySource) {
			const arrayBuffer = await req.arrayBuffer();
			actualSize = arrayBuffer.byteLength;
			requestBody = arrayBuffer;

			if (limit !== null) {
				if (
					BigInt(user.storageUsageBytes) + BigInt(actualSize) >
					BigInt(limit)
				) {
					return S3Errors.QuotaExceeded(
						"You have exceeded your storage quota.",
						key,
					).toResponse();
				}
			}

			upstreamHeaders.set("Content-Length", actualSize.toString());
		}

		const response = await s3Client.fetch(
			pathWithQuery,
			{
				method: "PUT",
				headers: upstreamHeaders,
				body: requestBody,
				duplex: "half",
			} as unknown as RequestInit,
			1,
		);

		if (response.ok && !copySource) {
			if (actualSize > 0) {
				await db
					.update(buckets)
					.set({
						totalBytes: sql`${buckets.totalBytes} + ${actualSize}`,
					})
					.where(eq(buckets.id, bucket.id));
			}
		}

		if (copySource && response.ok) {
			const xml = await response.text();
			return new Response(xml, {
				status: response.status,
				headers: response.headers,
			});
		}

		return new Response(response.body, {
			status: response.status,
			headers: response.headers,
		});
	} catch (e: unknown) {
		console.error("PUT Error:", e);
		const error = e as Error;

		if (
			error.message === "QuotaExceeded" ||
			error.toString().includes("QuotaExceeded")
		) {
			return S3Errors.QuotaExceeded(
				"You have exceeded your storage quota.",
				key,
			).toResponse();
		}

		return S3Errors.InternalError(error.message).toResponse();
	}
}
