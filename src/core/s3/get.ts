import { config } from "../../config";
import type { buckets, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { S3Errors } from "../../lib/s3-errors";
import {
	rewriteListObjectsV2Response,
	rewriteMultipartUploadResponse,
} from "../../lib/xml-rewriter";
import { redis } from "../../lib/redis";
import { diskCache } from "../../lib/disk-cache";
import {
	filterUpstreamHeaders,
	getInternalPath,
	stripAuthQueryParams,
} from "./utils";

export async function handleGetRequest(
	req: Request,
	user: typeof users.$inferSelect | null,
	bucket: typeof buckets.$inferSelect,
	key: string,
	internalPath: string,
	url: URL,
	corsHeaders: Headers,
) {
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

	let egressLimit: bigint | null = null;
	if (user && !user.isImmortal) {
		if (user.egressLimitBytes !== null) {
			const manualLimit = BigInt(user.egressLimitBytes);
			if (manualLimit !== -1n) {
				egressLimit = manualLimit;
			}
		} else {
			if (user.storageLimitBytes !== null) {
				const storageLimit = BigInt(user.storageLimitBytes);
				const calculated = storageLimit * 3n;
				const minLimit = 10n * 1024n * 1024n * 1024n; // 10GB
				egressLimit = calculated > minLimit ? calculated : minLimit;
			}
		}

		if (
			egressLimit !== null &&
			BigInt(user.egressBytes) > egressLimit &&
			!user.isImmortal
		) {
			return S3Errors.QuotaExceeded(
				"You have exceeded your egress quota.",
			).toResponse();
		}
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
			redis.set(cacheKeyList, rewrittenXml, "EX", 3600).catch((e) => {
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
		// Redis & Disk Cache Check for Object
		const cacheKeyBody = `s3:body:${bucket.name}:${key}`;
		const cacheKeyMeta = `s3:meta:${bucket.name}:${key}`;

		if (!url.searchParams.has("uploadId") && !req.headers.has("range")) {
			try {
	               // 1. Try Redis first (faster)
				const [cachedBody, cachedMeta] = await Promise.all([
					redis.getBuffer(cacheKeyBody),
					redis.get(cacheKeyMeta),
				]);

				if (cachedBody && cachedMeta) {
					const headers = new Headers(JSON.parse(cachedMeta));
					for (const [k, v] of corsHeaders.entries()) {
						headers.set(k, v);
					}
					return new Response(cachedBody, {
						status: 200,
						headers,
					});
				}

	               // 2. Try Disk Cache (if Redis miss)
	               // We still need the metadata from Redis to serve the response correctly.
	               // If Redis meta is missing, we must go to upstream anyway to get fresh metadata (and likely body).
	               // However, if we found Redis meta but body was evicted/missing from Redis,
	               // we can check Disk Cache for the body.
	               
	               // BUT: The previous logic returned early if `cachedBody && cachedMeta`.
	               // If we are here, one or both are missing.
	               
	               // If we have meta but no body, check disk.
	               if (cachedMeta && !cachedBody) {
	               	const diskBody = await diskCache.get(bucket.name, key);
	               	if (diskBody) {
	               		const headers = new Headers(JSON.parse(cachedMeta));
	               		for (const [k, v] of corsHeaders.entries()) {
	               			headers.set(k, v);
	               		}
	               		return new Response(diskBody, {
	               			status: 200,
	               			headers,
	               		});
	               	}
	               }
			} catch (e) {
				console.error("Cache read error:", e);
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
		if (contentLength) {
			headers.set("Content-Length", contentLength);
		}

		// Cleanup headers that might conflict with Content-Length or cause issues with streaming
		headers.delete("Transfer-Encoding");
		headers.delete("transfer-encoding");

		let responseBody: ReadableStream | Blob | null = response.body;

		// Redis & Disk Cache Write (Side Effect)
		if (
			!url.searchParams.has("uploadId") &&
			response.status === 200 &&
			response.body
		) {
			const sizeHint = contentLength ? parseInt(contentLength) : 0;
		          // 10MB limit for Redis, 1GB limit for Disk
			const shouldCacheRedis = sizeHint > 0 && sizeHint < 10 * 1024 * 1024;
		          const shouldCacheDisk = sizeHint > 0 && sizeHint < 1024 * 1024 * 1024;

			if (shouldCacheRedis || shouldCacheDisk) {
				const [stream1, stream2] = response.body.tee();
				responseBody = stream1;

				// Background cache population
				(async () => {
					try {
		                      // If it fits in Redis, we read it all into memory first
		                      if (shouldCacheRedis) {
		                          const reader = stream2.getReader();
		                          const chunks: Uint8Array[] = [];
		                          let totalSize = 0;
		                          const MAX_REDIS_SIZE = 10 * 1024 * 1024;

		                          while (true) {
		                              const { done, value } = await reader.read();
		                              if (done) break;

		                              totalSize += value.length;
		                              if (totalSize > MAX_REDIS_SIZE) {
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
		                          headers.forEach((v, k) => (headersObj[k] = v));

		                          await Promise.all([
		                              redis.set(cacheKeyMeta, JSON.stringify(headersObj)),
		                              redis.set(cacheKeyBody, Buffer.from(buffer)),
		                          ]);
		     // Opportunistically write to disk too if it fits
		     if (shouldCacheDisk) {
		      diskCache.put(bucket.name, key, buffer).catch(console.error);
		     }
		                      }
		                      // If too big for Redis but fits in Disk, stream to disk
		                      else if (shouldCacheDisk) {
		     // We still need to cache metadata in Redis so we know it exists!
		     const headersObj: Record<string, string> = {};
		     headers.forEach((v, k) => (headersObj[k] = v));
		     
		     await Promise.all([
		      redis.set(cacheKeyMeta, JSON.stringify(headersObj)),
		      diskCache.put(bucket.name, key, stream2)
		     ]);
		                      }
					} catch (e) {
						console.error("Failed to cache S3 object in background:", e);
					}
				})();
			} else {
				// Just cache metadata if too big for body
				const headersObj: Record<string, string> = {};
				headers.forEach((v, k) => (headersObj[k] = v));
				redis.set(cacheKeyMeta, JSON.stringify(headersObj)).catch((e) => {
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
