import { config } from "../../config";
import { buckets, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { S3Errors } from "../../lib/s3-errors";
import { XMLBuilder } from "fast-xml-parser";
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
	// Handle CORS Configuration Request
	if (key === "" && url.searchParams.has("cors")) {
		if (!bucket.corsConfig) {
			return S3Errors.NoSuchCORSConfiguration().toResponse();
		}

		const config = JSON.parse(bucket.corsConfig);
		const builder = new XMLBuilder({
			ignoreAttributes: false,
			format: true,
		});

		// Ensure CORSRules is always an array
		const rulesArray = Array.isArray(config.CORSRules)
			? config.CORSRules
			: [config.CORSRules];

		const corsConfiguration = {
			CORSConfiguration: {
				"@_xmlns": "http://s3.amazonaws.com/doc/2006-03-01/",
				CORSRule: rulesArray.map((r: any) => {
					const rule: any = {};
					if (r.ID) rule.ID = r.ID;

					const allowedOrigins = Array.isArray(r.AllowedOrigins)
						? r.AllowedOrigins
						: [r.AllowedOrigins];
					rule.AllowedOrigin = allowedOrigins;

					const allowedMethods = Array.isArray(r.AllowedMethods)
						? r.AllowedMethods
						: [r.AllowedMethods];
					rule.AllowedMethod = allowedMethods;

					if (r.AllowedHeaders) {
						const allowedHeaders = Array.isArray(r.AllowedHeaders)
							? r.AllowedHeaders
							: [r.AllowedHeaders];
						rule.AllowedHeader = allowedHeaders;
					}

					if (r.ExposeHeaders) {
						const exposeHeaders = Array.isArray(r.ExposeHeaders)
							? r.ExposeHeaders
							: [r.ExposeHeaders];
						rule.ExposeHeader = exposeHeaders;
					}

					if (r.MaxAgeSeconds) {
						rule.MaxAgeSeconds = r.MaxAgeSeconds;
					}
					return rule;
				}),
			},
		};

		const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(corsConfiguration)}`;

		return new Response(xml, {
			headers: { "Content-Type": "application/xml" },
		});
	}

	// Egress Limit Check
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
		const builder = new XMLBuilder({
			ignoreAttributes: false,
		});
		const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({
			LocationConstraint: {
				"#text": config.s3.region,
				"@_xmlns": "http://s3.amazonaws.com/doc/2006-03-01/",
			},
		})}`;

		return new Response(xml, {
			headers: { "Content-Type": "application/xml" },
		});
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

		return new Response(response.body, {
			status: response.status,
			headers,
		});
	} catch (_e) {
		return S3Errors.InternalError().toResponse();
	}
}
