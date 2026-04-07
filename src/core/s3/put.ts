import { eq, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { db } from "../../db";
import { buckets, type users } from "../../db/schema";
import { AwsChunkedDecoder } from "../../lib/aws-chunked-decoder";
import { diskCacheInvalidate } from "../../lib/disk-cache";
import {
	consumeStorageQuota,
	releaseStorageQuota,
} from "../../lib/quota-cache";
import { redis } from "../../lib/redis";
import { s3Client } from "../../lib/s3-client";
import { S3Errors } from "../../lib/s3-errors";
import { getCorsHeaders } from "./cors";
import {
	filterUpstreamHeaders,
	isReservedBucketName,
	rewriteCopySourceHeader,
	stripAuthQueryParams,
} from "./utils";

export async function handlePutRequest(
	req: Request,
	user: typeof users.$inferSelect | null,
	bucket: typeof buckets.$inferSelect,
	key: string,
	internalPath: string,
	url: URL,
) {
	const corsHeaders = getCorsHeaders(req, bucket);
	const withCors = (response: Response) => {
		if (!req.headers.get("Origin")) return response;

		const headers = new Headers(response.headers);
		for (const [headerKey, headerValue] of corsHeaders.entries()) {
			headers.set(headerKey, headerValue);
		}

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};

	const partNumber = url.searchParams.get("partNumber");
	const uploadId = url.searchParams.get("uploadId");
	const isMultipartPartUpload = Boolean(partNumber && uploadId);
	const requestStart = Date.now();

	const logPutResult = (message: string, extra?: Record<string, unknown>) => {
		console.log(
			JSON.stringify({
				message,
				bucket: bucket.name,
				key,
				method: req.method,
				origin: req.headers.get("Origin"),
				isMultipartPartUpload,
				partNumber,
				uploadId,
				durationMs: Date.now() - requestStart,
				...extra,
			}),
		);
	};

	if (
		key === "" &&
		!url.searchParams.has("cors") &&
		!url.searchParams.has("uploadId")
	) {
		if (isReservedBucketName(bucket.name)) {
			return withCors(
				S3Errors.AccessDenied(
				"Bucket name is reserved for system use.",
				`/${bucket.name}`,
				).toResponse(),
			);
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

			type ParsedCorsRule = {
				ID?: string;
				AllowedOrigin?: string | string[];
				AllowedMethod?: string | string[];
				AllowedHeader?: string | string[];
				ExposeHeader?: string | string[];
				MaxAgeSeconds?: number;
			};

			const rulesArray: ParsedCorsRule[] = Array.isArray(
				parsed.CORSConfiguration.CORSRule,
			)
				? parsed.CORSConfiguration.CORSRule
				: [parsed.CORSConfiguration.CORSRule];

			const rules = rulesArray.map((r) => {
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

			return withCors(new Response(null, { status: 200 }));
		} catch (_e) {
			return withCors(S3Errors.MalformedXML().toResponse());
		}
	}

	const limit = user ? user.storageLimitBytes : null;
	const upstreamHeaders = filterUpstreamHeaders(req.headers);

	const isAwsChunked =
		req.headers.get("content-encoding")?.toLowerCase() === "aws-chunked" ||
		req.headers.get("x-amz-content-sha256")?.startsWith("STREAMING-");

	if (!upstreamHeaders.has("x-amz-content-sha256")) {
		upstreamHeaders.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
	} else if (isAwsChunked) {
		// If streaming with aws-chunked, we decode it, so upstream sees a normal payload.
		// Upstream expects UNSIGNED-PAYLOAD or a specific hash if we are not signing it as chunked ourselves.
		// Since we are decoding, the payload becomes "unsigned" plain data.
		upstreamHeaders.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
	}

	const copySource = req.headers.get("x-amz-copy-source");
	let storageQuotaReserved = false;
	let actualSize = 0;
	let existingSize = 0;

	if (copySource && user) {
		const rewrittenSource = await rewriteCopySourceHeader(
			req,
			copySource,
			user,
			bucket,
		);
		if (!rewrittenSource) {
			return withCors(S3Errors.AccessDenied().toResponse());
		}
		upstreamHeaders.set("x-amz-copy-source", rewrittenSource);
	}

	try {
		if (!copySource) {
			try {
				const existingObject = await s3Client.fetch(internalPath, { method: "HEAD" });
				if (existingObject.ok) {
					existingSize = Number(
						existingObject.headers.get("content-length") || 0,
					);
				}
			} catch {
				existingSize = 0;
			}
		}

		const cleanUrl = stripAuthQueryParams(url);
		const queryStr = cleanUrl.searchParams.toString();
		const pathWithQuery = queryStr
			? `${internalPath}?${queryStr}`
			: internalPath;

		let requestBody: unknown = req.body;

		if (!copySource) {
			const body = req.body;
			if (!body) {
				return withCors(
					S3Errors.InvalidRequest("Missing request body").toResponse(),
				);
			}

			// If input is aws-chunked, we MUST decode it to get the real content.
			// And we also need to strip the `aws-chunked` encoding from upstream headers
			// because we are decoding it here.
			if (isAwsChunked) {
				console.log(`[PUT] Detected aws-chunked encoding for ${key}`);

				// Remove content-encoding: aws-chunked so upstream doesn't try to decode it again
				// (since we are sending raw bytes)
				if (
					upstreamHeaders.get("content-encoding")?.toLowerCase() ===
					"aws-chunked"
				) {
					upstreamHeaders.delete("content-encoding");
				}

				// The Content-Length header from client includes the chunk metadata overhead.
				// We don't know the real size until we decode.
				// We must use a transform stream to decode on the fly.
				// However, upstream S3 needs a Content-Length if we are not chunking ourselves.
				//
				// If we stream the decoded output, we don't know the size.
				// If we buffer, we know the size.
				//
				// Given we are already doing store-and-forward for reliability (see below),
				// we can decode into a Blob/Buffer.

				// Use our custom decoder
				const decoder = new AwsChunkedDecoder();
				const decodedStream = body.pipeThrough(decoder);

				const decodedLengthHeader = req.headers.get(
					"x-amz-decoded-content-length",
				);

				if (decodedLengthHeader) {
					// Optimization: If we have the decoded length, we can stream directly
					// without buffering the whole file in memory.
					actualSize = parseInt(decodedLengthHeader, 10);
					requestBody = decodedStream;
					upstreamHeaders.set("Content-Length", actualSize.toString());
				} else {
					// Fallback: Buffer if we don't know the size
					// This should be rare for valid aws-chunked requests
					const chunks: Uint8Array[] = [];
					const reader = decodedStream.getReader();
					let totalDecodedLength = 0;

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						chunks.push(value);
						totalDecodedLength += value.byteLength;
					}

					const combined = new Uint8Array(totalDecodedLength);
					let offset = 0;
					for (const chunk of chunks) {
						combined.set(chunk, offset);
						offset += chunk.byteLength;
					}

					requestBody = combined;
					actualSize = totalDecodedLength;
					upstreamHeaders.set("Content-Length", actualSize.toString());
				}

				// Quota Check
				if (limit !== null && user && !user.isImmortal) {
					if (
						BigInt(user.storageUsageBytes) + BigInt(actualSize) >
						BigInt(limit)
					) {
						return withCors(
							S3Errors.QuotaExceeded(
							"You have exceeded your storage quota.",
							key,
							).toResponse(),
						);
					}
				}
			} else {
				// Standard (non-chunked) upload path

				const contentLengthHeader = req.headers.get("content-length");
				const declared = contentLengthHeader
					? Number(contentLengthHeader)
					: null;
				if (declared !== null && (!Number.isFinite(declared) || declared < 0)) {
					return withCors(
						S3Errors.InvalidRequest(
						"Invalid Content-Length header",
						).toResponse(),
					);
				}

				if (declared !== null) {
					actualSize = declared;
					if (contentLengthHeader) {
						upstreamHeaders.set("Content-Length", contentLengthHeader);
					}

					if (limit !== null && user && !user.isImmortal) {
						if (
							BigInt(user.storageUsageBytes) + BigInt(actualSize) >
							BigInt(limit)
						) {
							return withCors(
								S3Errors.QuotaExceeded(
								"You have exceeded your storage quota.",
								key,
								).toResponse(),
							);
						}
					}
				}

				if (declared === null) {
					// If content-length is missing, we must read the whole body to know the size.
					// Use blob() to avoid OOM on large files if the runtime supports disk-backed blobs.
					// This is safer than reading into a Uint8Array in memory.
					const blob = await req.blob();
					requestBody = blob;
					actualSize = blob.size;

					// Explicitly set the Content-Length header for the upstream request
					upstreamHeaders.set("Content-Length", actualSize.toString());

					if (limit !== null && user && !user.isImmortal) {
						if (
							BigInt(user.storageUsageBytes) + BigInt(actualSize) >
							BigInt(limit)
						) {
							return withCors(
								S3Errors.QuotaExceeded(
								"You have exceeded your storage quota.",
								key,
								).toResponse(),
							);
						}
					}
				} else {
					// Special optimization:
					// If `declared` length is small (e.g., < 10MB), buffer it to ensure upstream S3 gets a clean Content-Length.
					// This avoids issues where streaming bodies drop the Content-Length header in some runtimes/proxies.
					// 10MB is a reasonable tradeoff for memory vs reliability.
					const BUFFER_THRESHOLD = 10 * 1024 * 1024; // 10 MB

					if (declared !== null && declared < BUFFER_THRESHOLD) {
						const chunks: Uint8Array[] = [];
						const reader = body.getReader();
						let totalLength = 0;

						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							chunks.push(value);
							totalLength += value.byteLength;
						}

						const combined = new Uint8Array(totalLength);
						let offset = 0;
						for (const chunk of chunks) {
							combined.set(chunk, offset);
							offset += chunk.byteLength;
						}

						if (totalLength !== declared) {
							return withCors(
								S3Errors.InvalidRequest(
								`Content-Length mismatch: declared=${declared} actual=${totalLength}`,
								).toResponse(),
							);
						}

						// Update quota check just in case
						if (limit !== null && user && !user.isImmortal) {
							if (
								BigInt(user.storageUsageBytes) + BigInt(totalLength) >
								BigInt(limit)
							) {
								return withCors(
									S3Errors.QuotaExceeded(
									"You have exceeded your storage quota.",
									key,
									).toResponse(),
								);
							}
						}

						requestBody = combined;
						actualSize = totalLength;
					} else {
						// Fallback for large files
						// Using a raw stream with fetch() in Bun/Node often forces Transfer-Encoding: chunked
						// and strips Content-Length, which upstream S3 providers (like MinIO/AWS) reject
						// if expecting a standard PUT.
						//
						// To guarantee Content-Length is sent, we must use a Blob or ArrayBuffer.
						// Bun's request.blob() is efficient and handles large files (potentially backing to disk),
						// enabling a "Store-and-Forward" approach that preserves Content-Length.
						if (declared !== null) {
							requestBody = await req.blob();
							actualSize = declared;
						} else {
							// Should not happen as per logic above, but fallback to stream
							requestBody = body;
							actualSize = declared;
						}
					}
				}
			}
		}

		const sizeDelta = Math.max(0, actualSize - existingSize);

		if (!copySource && sizeDelta > 0 && user && !user.isImmortal) {
			storageQuotaReserved = await consumeStorageQuota(
				{
					id: user.id,
					isImmortal: user.isImmortal,
					storageLimitBytes: user.storageLimitBytes,
					egressLimitBytes: user.egressLimitBytes,
				},
				Number(user.storageUsageBytes) || 0,
				sizeDelta,
			);

			if (!storageQuotaReserved) {
				return withCors(
					S3Errors.QuotaExceeded(
					"You have exceeded your storage quota.",
					key,
					).toResponse(),
				);
			}
		}

		// Debug logging for Content-Length
		if (
			upstreamHeaders.has("Content-Length") ||
			upstreamHeaders.has("content-length")
		) {
			console.log(
				`[PUT] Content-Length present in upstreamHeaders: ${upstreamHeaders.get("Content-Length") || upstreamHeaders.get("content-length")}`,
			);
		} else {
			console.log("[PUT] Content-Length MISSING in upstreamHeaders");
		}

		// Convert Headers to plain object to ensure control over casing
		// This is critical because some fetch implementations (and S3) might strictly look for
		// "Content-Length" (PascalCase) when deciding whether to send a stream with length vs chunked.
		const headersObj: Record<string, string> = {};
		upstreamHeaders.forEach((v, k) => {
			headersObj[k] = v;
		});

		// Normalize Content-Length to PascalCase if present
		if (headersObj["content-length"]) {
			headersObj["Content-Length"] = headersObj["content-length"];
			delete headersObj["content-length"];
		}

		// Force set Content-Length with PascalCase if we know the size
		if (actualSize > 0) {
			headersObj["Content-Length"] = actualSize.toString();
		} else if (copySource) {
			// For CopyObject, the body is empty, so Content-Length should be 0.
			// Ensure it's explicitly set to "0" if missing or otherwise.
			headersObj["Content-Length"] = "0";
		} else {
			// If actualSize is 0 and it's not a copy, it might be an empty PUT.
			// Ensure Content-Length is set if it was in the upstream headers (already normalized above),
			// or default to "0" if we know the body is empty?
			// But if actualSize is 0, it might mean we didn't count it (streamed without buffering)?
			// No, if declared is null, we buffered and actualSize is set.
			// If declared is not null, actualSize is set to declared.
			// So actualSize represents the intended Content-Length.

			// If actualSize is 0, explicitly set it to "0" to be safe.
			// This covers empty files.
			headersObj["Content-Length"] = "0";
		}

		const response = await s3Client.fetch(
			pathWithQuery,
			{
				method: "PUT",
				headers: headersObj,
				body: requestBody,
				duplex: "half",
			} as unknown as RequestInit,
			1,
		);

		if (
			!response.ok &&
			storageQuotaReserved &&
			user &&
			!copySource &&
			actualSize > 0
		) {
			await releaseStorageQuota(user.id, sizeDelta);
		}

		if (response.ok) {
			logPutResult("s3.put.success", {
				status: response.status,
				actualSize,
				sizeDelta,
			});

			// Invalidate all cache layers (Redis L1 + Disk L2)
			try {
				const redisKeys = [
					`s3:body:${bucket.name}:${key}`,
					`s3:meta:${bucket.name}:${key}`,
				];

				// Fire-and-forget background invalidation
				(async () => {
					try {
						await redis.del(redisKeys);

						// SCAN is slow, but acceptable in background for "eventual" list consistency
						const stream = redis.scanStream({
							match: `s3:list:${bucket.name}:*`,
							count: 100,
						});

						stream.on("data", (foundKeys: string[]) => {
							if (foundKeys.length) {
								redis.del(foundKeys);
							}
						});
					} catch (e) {
						console.error("Background cache invalidation error:", e);
					}
				})();

				// Invalidate disk cache (non-blocking)
				diskCacheInvalidate(bucket.name, key);
			} catch (e) {
				console.error("Cache invalidation error:", e);
			}

			if (!copySource && actualSize > 0) {
				const bucketDelta = actualSize - existingSize;
				await db
					.update(buckets)
					.set({
						totalBytes:
							bucketDelta >= 0
								? sql`${buckets.totalBytes} + ${bucketDelta}`
								: sql`GREATEST(0, ${buckets.totalBytes} - ${Math.abs(bucketDelta)})`,
					})
					.where(eq(buckets.id, bucket.id));
			}
		}

		if (copySource && response.ok) {
			const xml = await response.text();
			return withCors(new Response(xml, {
				status: response.status,
				headers: response.headers,
			}));
		}

		const resHeaders = new Headers(response.headers);
		if (!response.ok) {
			logPutResult("s3.put.upstream_error", {
				status: response.status,
				actualSize,
				sizeDelta,
			});
		}

		return withCors(new Response(response.body, {
			status: response.status,
			headers: resHeaders,
		}));
	} catch (e: unknown) {
		const sizeDelta = Math.max(0, actualSize - existingSize);
		if (storageQuotaReserved && user && !copySource && sizeDelta > 0) {
			await releaseStorageQuota(user.id, sizeDelta);
		}

		logPutResult("s3.put.exception", {
			actualSize,
			sizeDelta,
			error: e instanceof Error ? e.message : String(e),
		});
		console.error("PUT Error:", e);
		const error = e as Error;

		if (
			error.message === "QuotaExceeded" ||
			error.toString().includes("QuotaExceeded")
		) {
			return withCors(
				S3Errors.QuotaExceeded(
				"You have exceeded your storage quota.",
				key,
				).toResponse(),
			);
		}

		return withCors(S3Errors.InternalError(error.message).toResponse());
	}
}
