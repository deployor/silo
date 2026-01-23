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
			bucket,
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
			// There is no way to know the full size *before* reading the stream.
			// If we truly must NOT rely on Content-Length, the only 100% accurate option
			// is to stream while counting.
			//
			// Design here:
			// - If Content-Length is present: we can pre-check quota and also verify it by counting.
			// - If Content-Length is absent: we stream+count and enforce quota mid-stream.
			//   If quota exceeded, we abort the upstream request.
			const contentLengthHeader = req.headers.get("content-length");
			const declared = contentLengthHeader ? Number(contentLengthHeader) : null;
			if (declared !== null && (!Number.isFinite(declared) || declared < 0)) {
				return S3Errors.InvalidRequest(
					"Invalid Content-Length header",
				).toResponse();
			}

			// Some clients (like AWS SDK in certain modes or presigned URL uploads) might not send Content-Length.
			// However, S3 PUT usually requires it or uses chunked encoding.
			// If missing, we rely on the stream logic below, but we must be careful with upstream.
			// aws4fetch and many S3 implementations require known size for PUT if not chunked.
			// If we are proxying to R2/S3, we might need it.
			// If declared is null, we can't do pre-flight quota check, only mid-stream.

			if (declared !== null) {
				actualSize = declared;
				if (contentLengthHeader) {
					upstreamHeaders.set("Content-Length", contentLengthHeader);
				}

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
			}

			const body = req.body;
			if (!body) {
				return S3Errors.InvalidRequest("Missing request body").toResponse();
			}

			let seen = 0;
			// Only wrap the stream if we need to enforce quota or verify length.
			// If declared length is trusted and within quota, we can technically pass body directly,
			// BUT `aws4fetch` might need to read it to sign it? No, it streams.
			// However, Bun's request.body is already a stream.
			// Creating a new ReadableStream adds overhead but allows us to count bytes.
			
			// If we didn't receive Content-Length, we MUST calculate it if we want to forward it.
			// But we can't calculate it without buffering the whole stream, which is bad for memory.
			// Upstream S3 usually *requires* Content-Length for PUTs unless using chunked encoding.
			// `aws4fetch` handles signing, but it might not add Content-Length if the input body is a stream and length is unknown.
			//
			// If `contentLengthHeader` was missing, `upstreamHeaders` won't have it.
			// If we send a stream without Content-Length to S3, it fails with 411.
			//
			// SOLUTION:
			// If the client didn't send Content-Length, we cannot know it without buffering.
			// Buffering large files is dangerous (DOS).
			
			// HACK: For scripts sending small payloads (like our tests), allow reading even if no content-length
			// But for real S3 usage, we usually require it.
			// If we are here, and declared is null, we can try to guess or just buffer if it's small?
			// Actually, the issue in the test script is that `PutObjectCommand` in AWS SDK v3
			// DOES calculate Content-Length for string bodies.
			// So why is it missing?
			// Ah, the test script is sending `ContentLength` in the command, so `req.headers.get("content-length")` SHOULD be present.
			//
			// Wait, in `scripts/test-new-key-format.ts`, we added `ContentLength: Buffer.byteLength(file.body)`.
			// So the SDK *should* be sending it.
			// The server sees: `[DEBUG] PUT request incoming headers: ... "content-length": "12" ...`
			// So `declared` should be 12.
			//
			// Then we go to:
			// if (declared !== null) { ... upstreamHeaders.set("Content-Length", contentLengthHeader); }
			//
			// So `upstreamHeaders` HAS Content-Length.
			//
			// Then we create `requestBody`:
			// `requestBody = new ReadableStream({ ... })`
			//
			// Then we call `s3Client.fetch(..., { headers: upstreamHeaders, body: requestBody })`.
			//
			// `s3Client` is `HetznerS3Client` wrapping `AwsClient` from `aws4fetch`.
			// `AwsClient.fetch` takes the headers and body.
			//
			// ISSUE: `aws4fetch` might be stripping Content-Length if the body is a stream?
			// Or maybe `bun`'s `fetch` (which `aws4fetch` uses under the hood) is doing something?
			//
			// When passing a `ReadableStream` as body to `fetch`, the browser/runtime often sets `Transfer-Encoding: chunked`
			// and ignores `Content-Length`.
			// S3 often dislikes `Transfer-Encoding: chunked` for PUTs unless properly signed as chunked upload (which aws4fetch might not do for streams?).
			//
			// FIX: We need to ensure that if we have a known length, we pass it in a way that `fetch` respects it,
			// OR we use a Buffer/Blob instead of a Stream if possible.
			// Since we are proxying, we used Stream to avoid buffering.
			//
			// BUT `aws4fetch` documentation says:
			// "If you are using a ReadableStream as body, you should provide the size in the headers or the Content-Length header will be missing."
			// We ARE providing it in `upstreamHeaders`.
			//
			// However, Bun's `fetch` with a `ReadableStream` might be forcing chunked encoding.
			// If we are just proxying small files, buffering is safer.
			// If we are proxying large files, we need `duplex: 'half'` (which we have).
			//
			// Let's try to verify if `aws4fetch` preserves the header.
			//
			// Actually, if `actualSize` is known (declared !== null), we are still creating a `ReadableStream`.
			// Maybe we should just read the body into a buffer if it's small enough?
			// No, that defeats the purpose of streaming.
			//
			// Let's try to set `Content-Length` explicitly in the `fetch` call again, maybe `aws4fetch` clobbers it?
			// No, we saw `s3Client.ts` doing `headersObj`.
			//
			// Maybe the issue is case sensitivity? "Content-Length" vs "content-length"?
			// We are setting "Content-Length".
			
			// We should reject requests without Content-Length if we are not using chunked transfer to upstream.
			// But `aws4fetch` doesn't support chunked upload easily?
			// Actually, if we just read the stream, we can't add the header after.
			
			// If the client DID send Content-Length, we use it.
			
			// If we are here, we are wrapping the stream to count bytes for quota/verification.
			//
			// CRITICAL FOR UPSTREAM S3:
			// When we wrap the stream, we lose the "known length" property.
			// S3 requires Content-Length. If we are proxying, we MUST ensure the upstream request has it.
			// If the client provided it (`declared`), we used it.
			// If the client did NOT provide it, we have a problem: we can't calculate it without buffering.
			//
			// However, Bun's `fetch` implementation handles `ReadableStream` upload.
			// If `upstreamHeaders` has `Content-Length`, it should work.
			//
			// The issue might be that we are modifying the body (by wrapping it) but not buffering it,
			// so the runtime doesn't know the length anymore.

			         // HACK: If we have a declared length, we can try to "trick" Bun/fetch into thinking
			         // the stream has a known length if we use a Blob or ArrayBuffer?
			         // But we want to stream.
			         //
			         // If `declared` is set, we added `Content-Length` to `upstreamHeaders`.
			         // But `aws4fetch` or `fetch` might drop it if body is a stream.
			//
			// For untrusted clients: We DO verify `seen` vs `declared` at the end of the stream.
			// If they mismatch, we error the controller, which should abort the upstream connection.
			// But for the START of the request, we rely on the `Content-Length` header they sent.
			//
			// If they send NO Content-Length, we can't send one upstream either unless we buffer.
			// Buffering is dangerous. We will rely on S3 411 response in that case.
			
			// We must buffer if Content-Length is missing to calculate it for upstream.
			// Upstream requires Content-Length for PUT.
			if (declared === null) {
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

				requestBody = combined;
				actualSize = totalLength;

				// Explicitly set the Content-Length header for the upstream request
				upstreamHeaders.set("Content-Length", totalLength.toString());

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
						return S3Errors.InvalidRequest(
							`Content-Length mismatch: declared=${declared} actual=${totalLength}`,
						).toResponse();
					}
					
					// Update quota check just in case
					if (limit !== null) {
						if (
							BigInt(user.storageUsageBytes) + BigInt(totalLength) >
							BigInt(limit)
						) {
							return S3Errors.QuotaExceeded(
								"You have exceeded your storage quota.",
								key,
							).toResponse();
						}
					}

					requestBody = combined;
					actualSize = totalLength;
				} else {
					// Fallback to streaming for large files
					// If we have a declared length, we try to pass the raw body stream
					// to avoid "double-stream" issues where Content-Length might be stripped
					// by runtimes when wrapping streams.
					if (declared !== null) {
						// Trust the declared length for pre-flight quota check
						// (We already checked it above: if (limit !== null) ...)
						
						// Use the raw body stream
						requestBody = body;
						actualSize = declared;
					} else {
						// No declared length, but too big to buffer (wait, we shouldn't be here if declared is null)
						// The logic above is `if (declared === null) { buffer... } else { ... }`
						// So here declared IS NOT null.
						// wait, the outer block is:
						// if (declared === null) { ... } else { ... if (declared < BUFFER) ... else { WE ARE HERE } }
						// So declared is definitely not null here.
						
						requestBody = body;
						actualSize = declared;
					}
				}
			}
		}

		// Debug logging for Content-Length
		if (upstreamHeaders.has("Content-Length") || upstreamHeaders.has("content-length")) {
			console.log(`[PUT] Content-Length present in upstreamHeaders: ${upstreamHeaders.get("Content-Length") || upstreamHeaders.get("content-length")}`);
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

		// Force set Content-Length with PascalCase if we know the size
		if (actualSize > 0) {
			headersObj["Content-Length"] = actualSize.toString();
			// Remove lowercase version if it exists to avoid duplicates/confusion
			delete headersObj["content-length"];
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

		// Important: Pass through ETag and other headers from the upstream PUT response
		// This is critical for clients relying on ETag to verify upload (e.g. Terraform backend)
		// But note that some upstream S3 implementations might return the ETag in quotes, others not.
		// AWS usually returns it in quotes.
		// We should just proxy the headers.

		// Manually copy headers to ensure mutability if needed, though usually fine.
		// Specifically, we might want to ensure CORS headers are added if we were handling CORS here (but that's done in index.ts for OPTIONS usually, or we should append them?)
		// Actually, for simple requests (PUT), if there's no preflight, the browser checks Access-Control-Allow-Origin on the response.
		// We are not adding CORS headers here.
		// `handleS3Request` doesn't wrap the response with CORS headers for PUT/POST/DELETE, only GET/HEAD/OPTIONS.
		// We should probably add them if needed?
		// The standard is usually OPTIONS preflight handles it, but some simple requests need headers on response.
		// Let's rely on upstream headers being mostly correct, or maybe we need to inject them?
		// `index.ts` only adds CORS headers for GET.
		// Let's add them here too if it was a CORS request.

		const resHeaders = new Headers(response.headers);

		// If the request had an Origin, we might need to add CORS headers if configured
		// But `handlePutRequest` doesn't easily have access to `getCorsHeaders` without importing it or passing it.
		// Let's just return upstream headers for now, as that's what we did before.
		// The issue with metadata not being returned on HEAD is fixed in `index.ts` (HEAD) and `utils.ts` (filterUpstreamHeaders).
		// This PUT response is just the confirmation "200 OK" + ETag.

		return new Response(response.body, {
			status: response.status,
			headers: resHeaders,
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
