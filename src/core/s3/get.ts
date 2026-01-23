import { config } from "../../config";
import type { buckets, users } from "../../db/schema";
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

export async function handleGetRequest(
	req: Request,
	user: typeof users.$inferSelect,
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

	if (egressLimit !== null && BigInt(user.egressBytes) > egressLimit) {
		return S3Errors.QuotaExceeded(
			"You have exceeded your egress quota.",
		).toResponse();
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
		const userPrefix = query.get("prefix") || "";
		const internalPrefix = getInternalPath(userPrefix, user, bucket);

		const newQuery = new URLSearchParams(query);
		newQuery.set("prefix", internalPrefix);

		if (query.has("start-after")) {
			newQuery.set(
				"start-after",
				getInternalPath(query.get("start-after") as string, user, bucket),
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
		const rootPrefix = getInternalPath("", user, bucket);
		const rewrittenXml = rewriteListObjectsV2Response(xml, rootPrefix);

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
		const internalPrefix = getInternalPath(userPrefix, user, bucket);

		const newQuery = new URLSearchParams(query);
		newQuery.set("prefix", internalPrefix);

		if (query.has("key-marker")) {
			newQuery.set(
				"key-marker",
				getInternalPath(query.get("key-marker") as string, user, bucket),
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
		const rootPrefix = getInternalPath("", user, bucket);
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
			const rootPrefix = getInternalPath("", user, bucket);
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
		// Upstream S3 usually provides it, but sometimes it might be missing or in a different case
		if (!headers.has("Content-Length") && headers.has("content-length")) {
			headers.set("Content-Length", headers.get("content-length")!);
		}

		return new Response(response.body, {
			status: response.status,
			headers,
		});
	} catch (_e) {
		return S3Errors.InternalError().toResponse();
	}
}
