import { config } from "../../config";
import type { buckets, users } from "../../db/schema";
import {
	diskCacheGet,
	diskCacheGetPath,
	diskCachePut,
	getDiskCacheMinSizeBytes,
	isDiskCacheEligible,
	recordDemand,
} from "../../lib/disk-cache";
import { consumeEgressQuota } from "../../lib/quota-cache";
import { redis } from "../../lib/redis";
import { s3Client } from "../../lib/s3-client";
import { S3Errors } from "../../lib/s3-errors";
import {
	rewriteListObjectsV2Response,
	rewriteMultipartUploadResponse,
} from "../../lib/xml-rewriter";
import {
	filterUpstreamHeaders,
	getInternalPath,
	stripAuthQueryParams,
} from "./utils";
import { getContext } from "../../lib/context";

// Tracks in-flight cache population for object keys so subsequent requests can
// briefly wait and then hit Redis/Disk instead of immediately re-fetching S3.
const inFlightCachePopulation = new Map<string, Promise<void>>();

async function maybeWaitForCachePopulation(cacheId: string, timeoutMs = 350) {
	const pending = inFlightCachePopulation.get(cacheId);
	if (!pending) return;
	await Promise.race([
		pending.catch(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
	]);
}

function getCachedObjectSize(
	headers: Headers | Record<string, string>,
	fallbackSize: number,
): number {
	const contentLength =
		headers instanceof Headers
			? headers.get("content-length") || headers.get("Content-Length")
			: headers["content-length"] || headers["Content-Length"];
	const parsed = contentLength
		? Number.parseInt(contentLength, 10)
		: Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSize;
}

/**
 * Parse an HTTP Range header and return the byte range.
 * Supports formats: bytes=0-499, bytes=500-, bytes=-500
 */
function parseRangeHeader(
	rangeHeader: string,
	totalSize: number,
): { start: number; end: number } | null {
	const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
	if (!match) return null;

	let start = match[1] ? Number.parseInt(match[1], 10) : -1;
	let end = match[2] ? Number.parseInt(match[2], 10) : -1;

	if (start === -1 && end === -1) return null;

	if (start === -1) {
		// Suffix range: bytes=-500 means last 500 bytes
		start = Math.max(0, totalSize - end);
		end = totalSize - 1;
	} else if (end === -1) {
		// Open-ended: bytes=500- means from 500 to end
		end = totalSize - 1;
	}

	if (start > end || start >= totalSize) return null;

	end = Math.min(end, totalSize - 1);
	return { start, end };
}

export async function handleGetRequest(
	req: Request,
	user: typeof users.$inferSelect | null,
	bucket: typeof buckets.$inferSelect,
	key: string,
	internalPath: string,
	url: URL,
	corsHeaders: Headers,
	options?: {
		consumeQuota?: boolean;
	},
) {
	const shouldConsumeQuota = options?.consumeQuota ?? true;
	if (key === "" && url.searchParams.has("cors")) {
		if (!bucket.corsConfig) {
			return S3Errors.NoSuchCORSConfiguration().toResponse();
		}

		type StoredCorsRule = {
			ID?: string;
			AllowedOrigins: string | string[];
			AllowedMethods: string | string[];
			AllowedHeaders?: string | string[];
			ExposeHeaders?: string | string[];
			MaxAgeSeconds?: number;
		};

		type StoredCorsConfig = {
			CORSRules: StoredCorsRule[];
		};

		const config = JSON.parse(bucket.corsConfig) as StoredCorsConfig;
		const rulesXml = config.CORSRules.map((r) => {
			let rule = "<CORSRule>";
			if (r.ID) rule += `<ID>${r.ID}</ID>`;

			const allowedOrigins = Array.isArray(r.AllowedOrigins)
				? r.AllowedOrigins
				: [r.AllowedOrigins];
			for (const o of allowedOrigins) {
				rule += `<AllowedOrigin>${o}</AllowedOrigin>`;
			}

			const allowedMethods = Array.isArray(r.AllowedMethods)
				? r.AllowedMethods
				: [r.AllowedMethods];
			for (const m of allowedMethods) {
				rule += `<AllowedMethod>${m}</AllowedMethod>`;
			}

			if (r.AllowedHeaders) {
				const allowedHeaders = Array.isArray(r.AllowedHeaders)
					? r.AllowedHeaders
					: [r.AllowedHeaders];
				for (const h of allowedHeaders) {
					rule += `<AllowedHeader>${h}</AllowedHeader>`;
				}
			}

			if (r.ExposeHeaders) {
				const exposeHeaders = Array.isArray(r.ExposeHeaders)
					? r.ExposeHeaders
					: [r.ExposeHeaders];
				for (const h of exposeHeaders) {
					rule += `<ExposeHeader>${h}</ExposeHeader>`;
				}
			}

			if (r.MaxAgeSeconds) {
				rule += `<MaxAgeSeconds>${r.MaxAgeSeconds}</MaxAgeSeconds>`;
			}

			rule += "</CORSRule>";
			return rule;
		}).join("");

		return new Response(
			`<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
${rulesXml}
</CORSConfiguration>`,
			{ headers: { "Content-Type": "application/xml" } },
		);
	}

		async function reserveEgressQuota(bytesToSend: number) {
			if (!shouldConsumeQuota) return true;
			if (isOffboardingExport) return true;
			if (!user || user.isImmortal) return true;
			if (!Number.isFinite(bytesToSend) || bytesToSend <= 0) return true;
return consumeEgressQuota(
			{
				id: user.id,
				isImmortal: user.isImmortal,
				storageLimitBytes: user.storageLimitBytes,
				egressLimitBytes: user.egressLimitBytes,
			},
			Number(user.egressBytes) || 0,
			bytesToSend,
		);
	}

	if (key === "" && url.searchParams.has("location")) {
		return new Response(
			`<?xml version="1.0" encoding="UTF-8"?>
<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${config.s3.region}</LocationConstraint>`,
			{ headers: { "Content-Type": "application/xml" } },
		);
	}

	const listType = url.searchParams.get("list-type");
	const isListObjects =
		listType === "2" ||
		(key === "" &&
			!url.searchParams.has("uploads") &&
			!url.searchParams.has("location"));

	if (isListObjects) {
		const query = url.searchParams;
		// Redis Cache Check for ListObjects
		const queryStr = query.toString();
		const cacheKeyList = `s3:list:${bucket.name}:${queryStr}`;

		try {
			const cachedList = await redis.get(cacheKeyList);
			if (cachedList) {
				const headers = new Headers({ "Content-Type": "application/xml" });
				for (const [k, v] of corsHeaders.entries()) {
					headers.set(k, v);
				}
				return new Response(cachedList, { headers });
			}
		} catch (e) {
			console.error("Redis list cache error:", e);
		}

		const userPrefix = query.get("prefix") || "";
		const internalPrefix = getInternalPath(
			userPrefix,
			user || undefined,
			bucket,
		);

		const newQuery = new URLSearchParams(query);
		newQuery.set("prefix", internalPrefix);

		if (query.has("start-after")) {
			newQuery.set(
				"start-after",
				getInternalPath(
					query.get("start-after") as string,
					user || undefined,
					bucket,
				),
			);
		}

		const cleanUrl = stripAuthQueryParams(
			new URL(`http://localhost/?${newQuery.toString()}`),
		);

		const response = await s3Client.fetch(
			`?${cleanUrl.searchParams.toString()}`,
			{
				method: "GET",
				headers: filterUpstreamHeaders(req.headers),
			},
		);

		const xml = await response.text();
		const rootPrefix = getInternalPath("", user || undefined, bucket);
		const rewrittenXml = rewriteListObjectsV2Response(xml, rootPrefix);

		if (response.status === 200) {
			redis.set(cacheKeyList, rewrittenXml, "EX", 21600).catch((e) => {
				// 6 hours
				console.error("Failed to cache ListObjects response:", e);
			});
		}

		const headers = new Headers({ "Content-Type": "application/xml" });
		for (const [k, v] of corsHeaders.entries()) {
			headers.set(k, v);
		}

		return new Response(rewrittenXml, {
			status: response.status,
			headers,
		});
	}

	if (key === "" && url.searchParams.has("uploads")) {
		const query = url.searchParams;
		const userPrefix = query.get("prefix") || "";
		const internalPrefix = getInternalPath(
			userPrefix,
			user || undefined,
			bucket,
		);

		const newQuery = new URLSearchParams(query);
		newQuery.set("prefix", internalPrefix);

		if (query.has("key-marker")) {
			newQuery.set(
				"key-marker",
				getInternalPath(
					query.get("key-marker") as string,
					user || undefined,
					bucket,
				),
			);
		}

		const cleanUrl = stripAuthQueryParams(
			new URL(`http://localhost/?${newQuery.toString()}`),
		);

		const response = await s3Client.fetch(
			`?${cleanUrl.searchParams.toString()}`,
			{
				method: "GET",
				headers: filterUpstreamHeaders(req.headers),
			},
		);

		const xml = await response.text();
		const rootPrefix = getInternalPath("", user || undefined, bucket);
		const rewrittenXml = rewriteMultipartUploadResponse(xml, rootPrefix);

		const headers = new Headers({ "Content-Type": "application/xml" });
		for (const [k, v] of corsHeaders.entries()) {
			headers.set(k, v);
		}

		return new Response(rewrittenXml, {
			status: response.status,
			headers,
		});
	}

	try {
		const ctx = getContext();
		const isOffboardingExport = Boolean(ctx?.isOffboardingExport);
		// Redis Cache Check for Object (L1)
		const cacheKeyBody = `s3:body:${bucket.name}:${key}`;
		const cacheKeyMeta = `s3:meta:${bucket.name}:${key}`;
		const cachePopulationId = `${bucket.name}\0${key}`;
		const rangeHeader = req.headers.get("range");
		const isCacheable = !url.searchParams.has("uploadId") && !isOffboardingExport;
		const isSimpleGet = isCacheable && !rangeHeader;
		const REDIS_CACHE_LIMIT = 10 * 1024 * 1024; // 10 MB hard ceiling
		const diskMinSize = getDiskCacheMinSizeBytes();

		// Record demand for smart disk cache admission tracking
		if (isCacheable && key !== "") {
			recordDemand(bucket.name, key, 0); // size filled in later
		}

		// Conditional request check (ETag / 304 Not Modified)
		if (isCacheable && key !== "") {
			const ifNoneMatch = req.headers.get("if-none-match");
			if (ifNoneMatch) {
				try {
					const cachedMeta = await redis.get(cacheKeyMeta);
					if (cachedMeta) {
						const meta = JSON.parse(cachedMeta);
						const cachedEtag = meta.etag || meta.ETag || "";
						// Normalize: strip weak validator prefix, compare
						const normalize = (s: string) =>
							s.replace(/^W\//, "").replace(/"/g, "");
						if (
							normalize(ifNoneMatch) === normalize(cachedEtag) ||
							ifNoneMatch === "*"
						) {
							const headers304 = new Headers();
							if (cachedEtag) headers304.set("ETag", cachedEtag);
							if (meta["last-modified"])
								headers304.set("Last-Modified", meta["last-modified"]);
							for (const [k, v] of corsHeaders.entries()) {
								headers304.set(k, v);
							}
							return new Response(null, { status: 304, headers: headers304 });
						}
					}
				} catch (_e) {
					// Ignore — fall through to normal flow
				}
			}
		}

		if (isCacheable) {
			// --- L1: Redis cache check ---
			try {
				const [cachedBody, cachedMeta] = await Promise.all([
					redis.getBuffer(cacheKeyBody),
					redis.get(cacheKeyMeta),
				]);

				if (cachedBody && cachedMeta) {
					const headers = new Headers(JSON.parse(cachedMeta));
					const cachedSize = getCachedObjectSize(
						headers,
						cachedBody.byteLength,
					);

					if (cachedSize >= diskMinSize || cachedSize >= REDIS_CACHE_LIMIT) {
						Promise.all([
							redis.del(cacheKeyBody),
							redis.del(cacheKeyMeta),
						]).catch(() => undefined);
					} else {
						recordDemand(bucket.name, key, cachedSize);
						for (const [k, v] of corsHeaders.entries()) {
							headers.set(k, v);
						}
						if (!headers.has("cache-control")) {
							if (!user) {
								headers.set("Cache-Control", "public, max-age=3600");
							} else {
								headers.set("Cache-Control", "private, no-cache");
							}
						}
						headers.set("Accept-Ranges", "bytes");

						if (rangeHeader) {
							const totalSize = cachedBody.byteLength;
							const range = parseRangeHeader(rangeHeader, totalSize);
							if (range) {
								const sliced = new Uint8Array(cachedBody).slice(
									range.start,
									range.end + 1,
								);
								const allowed = await reserveEgressQuota(sliced.byteLength);
								if (!allowed) {
									return S3Errors.QuotaExceeded(
										"You have exceeded your egress quota.",
									).toResponse();
								}
								headers.set("Content-Length", sliced.byteLength.toString());
								headers.set(
									"Content-Range",
									`bytes ${range.start}-${range.end}/${totalSize}`,
								);
								return new Response(sliced, { status: 206, headers });
							}
							return new Response(null, {
								status: 416,
								headers: {
									"Content-Range": `bytes */${totalSize}`,
								},
							});
						}

						const allowed = await reserveEgressQuota(cachedBody.byteLength);
						if (!allowed) {
							return S3Errors.QuotaExceeded(
								"You have exceeded your egress quota.",
							).toResponse();
						}

						return new Response(new Uint8Array(cachedBody), {
							status: 200,
							headers,
						});
					}
				}
			} catch (e) {
				console.error("Redis object cache error:", e);
			}

			// --- L2: Disk cache check (for larger objects) ---
			try {
				// For Range requests, use path-based access for efficient partial reads
				if (rangeHeader) {
					const diskPathHit = await diskCacheGetPath(bucket.name, key);
					if (diskPathHit) {
						const headers = new Headers(diskPathHit.meta.headers);
						for (const [k, v] of corsHeaders.entries()) {
							headers.set(k, v);
						}
						// Re-apply security headers for dangerous types
						const ct = headers.get("content-type") || "";
						if (
							[
								"text/html",
								"application/xhtml+xml",
								"image/svg+xml",
								"text/xml",
								"application/xml",
								"text/javascript",
							].some((t) => ct.includes(t))
						) {
							headers.set("Content-Disposition", "attachment");
							headers.set("Content-Type", "application/octet-stream");
						}
						headers.set("X-Cache", "DISK-HIT");
						headers.set("Accept-Ranges", "bytes");
						if (!headers.has("cache-control")) {
							if (!user) {
								headers.set("Cache-Control", "public, max-age=3600");
							} else {
								headers.set("Cache-Control", "private, no-cache");
							}
						}

						const totalSize = diskPathHit.meta.size;
						const range = parseRangeHeader(rangeHeader, totalSize);
						if (range) {
							const file = Bun.file(diskPathHit.filePath);
							const sliced = file.slice(range.start, range.end + 1);
							const bytesToSend = range.end - range.start + 1;
							const allowed = await reserveEgressQuota(bytesToSend);
							if (!allowed) {
								return S3Errors.QuotaExceeded(
									"You have exceeded your egress quota.",
								).toResponse();
							}
							headers.set("Content-Length", bytesToSend.toString());
							headers.set(
								"Content-Range",
								`bytes ${range.start}-${range.end}/${totalSize}`,
							);
							return new Response(sliced, { status: 206, headers });
						}
						// Invalid range
						return new Response(null, {
							status: 416,
							headers: {
								"Content-Range": `bytes */${totalSize}`,
							},
						});
					}
				} else {
					const diskHit = await diskCacheGet(bucket.name, key);
					if (diskHit) {
						const allowed = await reserveEgressQuota(diskHit.meta.size);
						if (!allowed) {
							return S3Errors.QuotaExceeded(
								"You have exceeded your egress quota.",
							).toResponse();
						}

						const headers = new Headers(diskHit.meta.headers);
						for (const [k, v] of corsHeaders.entries()) {
							headers.set(k, v);
						}
						// Re-apply security headers for dangerous types
						const ct = headers.get("content-type") || "";
						if (
							[
								"text/html",
								"application/xhtml+xml",
								"image/svg+xml",
								"text/xml",
								"application/xml",
								"text/javascript",
							].some((t) => ct.includes(t))
						) {
							headers.set("Content-Disposition", "attachment");
							headers.set("Content-Type", "application/octet-stream");
						}
						headers.set("X-Cache", "DISK-HIT");
						headers.set("Accept-Ranges", "bytes");
						// Add Cache-Control if not already set
						if (!headers.has("cache-control")) {
							if (!user) {
								headers.set("Cache-Control", "public, max-age=3600");
							} else {
								headers.set("Cache-Control", "private, no-cache");
							}
						}
						return new Response(diskHit.stream, {
							status: 200,
							headers,
						});
					}
				}
			} catch (e) {
				console.error("Disk cache read error:", e);
			}

			// If a prior request is currently populating cache for this object,
			// wait briefly and re-check caches before going to S3 again.
			if (isSimpleGet && key !== "") {
				await maybeWaitForCachePopulation(cachePopulationId);

				try {
					const [cachedBodyAfterWait, cachedMetaAfterWait] = await Promise.all([
						redis.getBuffer(cacheKeyBody),
						redis.get(cacheKeyMeta),
					]);

					if (cachedBodyAfterWait && cachedMetaAfterWait) {
						const headers = new Headers(JSON.parse(cachedMetaAfterWait));
						const cachedSize = getCachedObjectSize(
							headers,
							cachedBodyAfterWait.byteLength,
						);

						if (cachedSize >= diskMinSize || cachedSize >= REDIS_CACHE_LIMIT) {
							Promise.all([
								redis.del(cacheKeyBody),
								redis.del(cacheKeyMeta),
							]).catch(() => undefined);
						} else {
							recordDemand(bucket.name, key, cachedSize);
							for (const [k, v] of corsHeaders.entries()) {
								headers.set(k, v);
							}
							if (!headers.has("cache-control")) {
								if (!user) headers.set("Cache-Control", "public, max-age=3600");
								else headers.set("Cache-Control", "private, no-cache");
							}
							headers.set("Accept-Ranges", "bytes");

							const allowed = await reserveEgressQuota(
								cachedBodyAfterWait.byteLength,
							);
							if (!allowed) {
								return S3Errors.QuotaExceeded(
									"You have exceeded your egress quota.",
								).toResponse();
							}

							return new Response(new Uint8Array(cachedBodyAfterWait), {
								status: 200,
								headers,
							});
						}
					}

					const diskHitAfterWait = await diskCacheGet(bucket.name, key);
					if (diskHitAfterWait) {
						const allowed = await reserveEgressQuota(
							diskHitAfterWait.meta.size,
						);
						if (!allowed) {
							return S3Errors.QuotaExceeded(
								"You have exceeded your egress quota.",
							).toResponse();
						}

						const headers = new Headers(diskHitAfterWait.meta.headers);
						for (const [k, v] of corsHeaders.entries()) {
							headers.set(k, v);
						}
						headers.set("X-Cache", "DISK-HIT");
						headers.set("Accept-Ranges", "bytes");
						if (!headers.has("cache-control")) {
							if (!user) headers.set("Cache-Control", "public, max-age=3600");
							else headers.set("Cache-Control", "private, no-cache");
						}

						return new Response(diskHitAfterWait.stream, {
							status: 200,
							headers,
						});
					}
				} catch (e) {
					console.error("Post-wait cache read error:", e);
				}
			}
		}

		const cleanUrl = stripAuthQueryParams(url);
		const queryStr = cleanUrl.searchParams.toString();
		const pathWithQuery = queryStr
			? `${internalPath}?${queryStr}`
			: internalPath;

		const response = await s3Client.fetch(pathWithQuery, {
			method: "GET",
			headers: filterUpstreamHeaders(req.headers),
		});

		if (url.searchParams.has("uploadId")) {
			const xml = await response.text();
			const rootPrefix = getInternalPath("", user || undefined, bucket);
			const rewrittenXml = rewriteMultipartUploadResponse(xml, rootPrefix);
			const headers = new Headers({ "Content-Type": "application/xml" });
			for (const [k, v] of corsHeaders.entries()) {
				headers.set(k, v);
			}

			return new Response(rewrittenXml, {
				status: response.status,
				headers,
			});
		}

		const headers = new Headers(response.headers);
		for (const [k, v] of corsHeaders.entries()) {
			headers.set(k, v);
		}

		if (isOffboardingExport && response.ok) {
			if (!headers.has("cache-control")) {
				headers.set("Cache-Control", "private, no-store");
			}
			return new Response(response.body, {
				status: response.status,
				headers,
			});
		}

		// Security: Force download for dangerous types to prevent XSS
		const contentType = headers.get("content-type") || "";
		const dangerousTypes = [
			"text/html",
			"application/xhtml+xml",
			"image/svg+xml",
			"text/xml",
			"application/xml",
			"text/javascript",
		];

		if (dangerousTypes.some((t) => contentType.includes(t))) {
			headers.set("Content-Disposition", "attachment");
			headers.set("Content-Type", "application/octet-stream");
		}

		// Ensure Content-Length is present in the response if available
		const contentLength =
			headers.get("content-length") || headers.get("Content-Length");
		const contentLengthNum = contentLength
			? Number.parseInt(contentLength, 10)
			: 0;
		const allowed = await reserveEgressQuota(contentLengthNum);
		if (!allowed) {
			return S3Errors.QuotaExceeded(
				"You have exceeded your egress quota.",
			).toResponse();
		}

		if (contentLength) {
			headers.set("Content-Length", contentLength);
		}

		// Cleanup headers that might conflict with Content-Length or cause issues with streaming
		headers.delete("Transfer-Encoding");
		headers.delete("transfer-encoding");

		// Add Cache-Control if not already set by upstream
		if (!headers.has("cache-control")) {
			if (!user) {
			// Public bucket access — allow browser caching
				headers.set("Cache-Control", "public, max-age=3600");
			} else {
				// Authenticated access — don't cache in shared caches
				headers.set("Cache-Control", "private, no-cache");
			}
		}

		// Advertise Range request support
		headers.set("Accept-Ranges", "bytes");

		let responseBody: ReadableStream | Blob | null = response.body;

		// Cache population (background, non-blocking)
		if (isSimpleGet && response.status === 200 && response.body) {
			const sizeHint = contentLength ? parseInt(contentLength, 10) : 0;
			const shouldCacheRedis =
				sizeHint > 0 && sizeHint < REDIS_CACHE_LIMIT && sizeHint < diskMinSize;
			const shouldCacheDisk = sizeHint > 0 && isDiskCacheEligible(sizeHint);

			// Update demand tracker with actual size
			if (key !== "") {
				recordDemand(bucket.name, key, sizeHint);
			}

			if (shouldCacheRedis || shouldCacheDisk) {
				const [stream1, stream2] = response.body.tee();
				responseBody = stream1;

				// Background cache population — fires and forgets
				const cacheWritePromise = (async () => {
					try {
						const reader = stream2.getReader();
						const chunks: Uint8Array[] = [];
						let totalSize = 0;
						// Hard cap: don't buffer more than what we'd cache
						const maxBuffer = shouldCacheDisk
							? sizeHint + 1024
							: REDIS_CACHE_LIMIT;

						while (true) {
							const { done, value } = await reader.read();
							if (done) break;

							totalSize += value.length;
							if (totalSize > maxBuffer) {
								reader.cancel();
								return;
							}
							chunks.push(value);
						}

						const buffer = new Uint8Array(totalSize);
						let offset = 0;
						for (const chunk of chunks) {
							buffer.set(chunk, offset);
							offset += chunk.length;
						}

						const headersObj: Record<string, string> = {};
						for (const [k, v] of headers.entries()) {
							headersObj[k] = v;
						}

						// L1: Redis (small objects, with TTL to prevent unbounded growth)
						if (totalSize < REDIS_CACHE_LIMIT) {
							const REDIS_BODY_TTL = 21600; // 6 hours
							const REDIS_META_TTL = 43200; // 12 hours
							await Promise.all([
								redis.set(
									cacheKeyMeta,
									JSON.stringify(headersObj),
									"EX",
									REDIS_META_TTL,
								),
								redis.set(
									cacheKeyBody,
									Buffer.from(buffer),
									"EX",
									REDIS_BODY_TTL,
								),
							]);
						}

						// L2: Disk (larger objects, demand-gated)
						if (isDiskCacheEligible(totalSize)) {
							const cached = await diskCachePut(
								bucket.name,
								key,
								buffer,
								headersObj,
							);
							if (cached) {
								console.log(
									`[disk-cache] cached ${bucket.name}/${key} (${(totalSize / (1024 * 1024)).toFixed(1)} MB)`,
								);
							}
						}
					} catch (e) {
						console.error("Failed to cache S3 object in background:", e);
					}
				})();

				if (key !== "") {
					inFlightCachePopulation.set(cachePopulationId, cacheWritePromise);
					cacheWritePromise.finally(() => {
						if (
							inFlightCachePopulation.get(cachePopulationId) ===
							cacheWritePromise
						) {
							inFlightCachePopulation.delete(cachePopulationId);
						}
					});
				}
			} else {
				// Cache metadata only for objects that don't qualify for body caching
				const headersObj: Record<string, string> = {};
				for (const [k, v] of headers.entries()) {
					headersObj[k] = v;
				}
				redis
					.set(cacheKeyMeta, JSON.stringify(headersObj), "EX", 43200) // 12 hours
					.catch((e) => {
						console.error("Failed to cache S3 metadata:", e);
					});
			}
		}

		return new Response(responseBody, {
			status: response.status,
			headers,
		});
	} catch (_e) {
		return S3Errors.InternalError().toResponse();
	}
}
