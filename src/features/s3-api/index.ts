import { eq, sql } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db";
import { buckets, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import {
	rewriteDeleteObjectsResponse,
	rewriteListObjectsV2Response,
	rewriteMultipartUploadResponse,
} from "../../lib/xml-rewriter";
import {
	filterUpstreamHeaders,
	getInternalPath,
	getKeyFromRequest,
	rewriteCopySourceHeader,
	stripAuthQueryParams,
} from "./utils";

export async function handleS3Request(
	req: Request,
	user: typeof users.$inferSelect,
	bucket: typeof buckets.$inferSelect,
	mode: "authenticated" | "public",
): Promise<Response> {
	const method = req.method;

	// console.log(`[S3] ${method} ${req.url}`);
	// console.log("[S3] Headers:", JSON.stringify(Object.fromEntries(req.headers.entries())));

	if (mode === "public" && method !== "GET" && method !== "HEAD") {
		return new Response(
			`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>AccessDenied</Code>
    <Message>Access Denied</Message>
    <RequestId>0000000000000000</RequestId>
</Error>`,
			{ status: 403, headers: { "Content-Type": "application/xml" } },
		);
	}
	const url = new URL(req.url);
	const S3_DOMAIN = config.s3Domain;
	const host = req.headers.get("host") || "";
	const key = getKeyFromRequest(req, bucket.name);

	// Handle ListBuckets on root domain OR on bucket domain if the path is empty
	// Some clients (like AWS SDK) might call ListBuckets on the bucket endpoint if configured that way,
	// though standard S3 behavior is usually on the root.
	// We'll support it if the key is empty and it looks like a service-level request,
	// BUT for virtual-host style, the bucket is in the host, so it's technically a bucket-level request.
	// However, if the user asks for "ListBuckets", they expect a list of buckets.
	// Since we only have one bucket per user, we can return that.
	if (
		(host === S3_DOMAIN && url.pathname === "/") ||
		(key === "" &&
			method === "GET" &&
			!url.searchParams.has("list-type") &&
			!url.searchParams.has("uploads") &&
			!url.searchParams.has("location"))
	) {
		// If it's a bucket-specific request (virtual host), standard S3 treats GET / as ListObjects.
		// But if the client explicitly sends a ListBuckets style request (which is just GET / on the service),
		// it's ambiguous when using virtual hosts.
		// However, our logic below handles ListObjects if list-type is 2 OR if key is empty and no other params.
		// Let's refine:
		// If host is S3_DOMAIN (path style root), it's definitely ListBuckets.
		// If host is bucket.s3.domain, GET / is ListObjects.

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
			return new Response("Method Not Allowed", { status: 405 });
		}
	}
	const internalPath = getInternalPath(key, user, bucket);

	if (key === "") {
		if (method === "PUT") {
			return new Response(
				`
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>AccessDenied</Code>
  <Message>Bucket creation is not allowed. Please use the dashboard.</Message>
  <Resource>/</Resource>
  <RequestId>0000000000000000</RequestId>
</Error>`.trim(),
				{ status: 403, headers: { "Content-Type": "application/xml" } },
			);
		}
		if (method === "DELETE") {
			return new Response(
				`
<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>AccessDenied</Code>
    <Message>Bucket deletion is not allowed. Please use the dashboard.</Message>
    <Resource>/</Resource>
    <RequestId>0000000000000000</RequestId>
</Error>`.trim(),
				{ status: 403, headers: { "Content-Type": "application/xml" } },
			);
		}
	}

	if (method === "OPTIONS") {
		// Handle CORS Preflight
		const corsConfig = bucket.corsConfig
			? JSON.parse(bucket.corsConfig)
			: null;

		if (!corsConfig || !Array.isArray(corsConfig.CORSRules)) {
			return new Response(null, { status: 403 });
		}

		const origin = req.headers.get("Origin");
		const requestMethod = req.headers.get("Access-Control-Request-Method");
		const requestHeaders = req.headers.get("Access-Control-Request-Headers");

		if (!origin || !requestMethod) {
			return new Response(null, { status: 403 });
		}

		// Find matching rule
		const rule = corsConfig.CORSRules.find((r: any) => {
			const allowedOrigins = Array.isArray(r.AllowedOrigins)
				? r.AllowedOrigins
				: [r.AllowedOrigins];
			const allowedMethods = Array.isArray(r.AllowedMethods)
				? r.AllowedMethods
				: [r.AllowedMethods];

			const originMatch = allowedOrigins.some((o: string) => {
				if (o === "*") return true;
				return o === origin;
			});

			const methodMatch = allowedMethods.includes(requestMethod);

			return originMatch && methodMatch;
		});

		if (!rule) {
			return new Response(null, { status: 403 });
		}

		const headers = new Headers();
		headers.set("Access-Control-Allow-Origin", origin);
		headers.set("Access-Control-Allow-Methods", requestMethod);

		if (rule.AllowedHeaders) {
			const allowedHeaders = Array.isArray(rule.AllowedHeaders)
				? rule.AllowedHeaders
				: [rule.AllowedHeaders];
			// If request asks for headers, check if they are allowed
			// For simplicity, we just echo back what's allowed if it matches wildcard or specific
			// But strictly we should check against requestHeaders
			headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
		} else if (requestHeaders) {
			// If no allowed headers defined but request has them, maybe allow all? No, default is deny.
		}

		if (rule.ExposeHeaders) {
			const exposeHeaders = Array.isArray(rule.ExposeHeaders)
				? rule.ExposeHeaders
				: [rule.ExposeHeaders];
			headers.set("Access-Control-Expose-Headers", exposeHeaders.join(", "));
		}

		if (rule.MaxAgeSeconds) {
			headers.set("Access-Control-Max-Age", rule.MaxAgeSeconds.toString());
		}

		headers.set("Vary", "Origin, Access-Control-Request-Headers, Access-Control-Request-Method");

		return new Response(null, { status: 200, headers });
	}

	if (method === "GET") {
		if (key === "" && url.searchParams.has("cors")) {
			if (!bucket.corsConfig) {
				return new Response(
					`<?xml version="1.0" encoding="UTF-8"?>
<Error>
	   <Code>NoSuchCORSConfiguration</Code>
	   <Message>The CORS configuration does not exist</Message>
	   <RequestId>0000000000000000</RequestId>
</Error>`,
					{ status: 404, headers: { "Content-Type": "application/xml" } },
				);
			}

			const config = JSON.parse(bucket.corsConfig);
			const rulesXml = config.CORSRules.map((r: any) => {
				let rule = "<CORSRule>";
				if (r.ID) rule += `<ID>${r.ID}</ID>`;
				
				const allowedOrigins = Array.isArray(r.AllowedOrigins) ? r.AllowedOrigins : [r.AllowedOrigins];
				for (const o of allowedOrigins) {
					rule += `<AllowedOrigin>${o}</AllowedOrigin>`;
				}

				const allowedMethods = Array.isArray(r.AllowedMethods) ? r.AllowedMethods : [r.AllowedMethods];
				for (const m of allowedMethods) {
					rule += `<AllowedMethod>${m}</AllowedMethod>`;
				}

				if (r.AllowedHeaders) {
					const allowedHeaders = Array.isArray(r.AllowedHeaders) ? r.AllowedHeaders : [r.AllowedHeaders];
					for (const h of allowedHeaders) {
						rule += `<AllowedHeader>${h}</AllowedHeader>`;
					}
				}

				if (r.ExposeHeaders) {
					const exposeHeaders = Array.isArray(r.ExposeHeaders) ? r.ExposeHeaders : [r.ExposeHeaders];
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

		// Egress Limit Check
		// Rule: Manual Limit OR (Storage Limit * 3 OR 10GB, whichever is higher)
		let egressLimit: bigint | null = null;

		if (user.egressLimitBytes !== null) {
			// Manual Limit
			const manualLimit = BigInt(user.egressLimitBytes);
			if (manualLimit === -1n) {
				// Unlimited
				egressLimit = null;
			} else {
				egressLimit = manualLimit;
			}
		} else {
			// Default Logic
			// 10GB or 3x Storage Limit
			if (user.storageLimitBytes === null) {
				// If storage is unlimited, egress is unlimited by default?
				// Or should we enforce the 10GB minimum?
				// Assuming unlimited storage implies unlimited egress for now unless specified.
				egressLimit = null;
			} else {
				const storageLimit = BigInt(user.storageLimitBytes);
				const calculated = storageLimit * 3n;
				const minLimit = 10n * 1024n * 1024n * 1024n; // 10GB
				egressLimit = calculated > minLimit ? calculated : minLimit;
			}
		}

		if (egressLimit !== null && BigInt(user.egressBytes) > egressLimit) {
			return new Response(
				`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>QuotaExceeded</Code>
    <Message>You have exceeded your egress quota.</Message>
    <Resource>${key}</Resource>
    <RequestId>0000000000000000</RequestId>
</Error>`,
				{ status: 403, headers: { "Content-Type": "application/xml" } },
			);
		}

		if (key === "" && url.searchParams.has("location")) {
			return new Response(
				`<?xml version="1.0" encoding="UTF-8"?>
<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">eu-central-1</LocationConstraint>`,
				{
					headers: { "Content-Type": "application/xml" },
				},
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

			return new Response(rewrittenXml, {
				status: response.status,
				headers: { "Content-Type": "application/xml" },
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

			return new Response(rewrittenXml, {
				status: response.status,
				headers: { "Content-Type": "application/xml" },
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
				return new Response(rewrittenXml, {
					status: response.status,
					headers: { "Content-Type": "application/xml" },
				});
			}

			return new Response(response.body, {
				status: response.status,
				headers: response.headers,
			});
		} catch (_e) {
			return new Response("Internal Error", { status: 500 });
		}
	}

	if (method === "PUT") {
		if (key === "" && url.searchParams.has("cors")) {
			const bodyText = await req.text();
			// Simple XML parsing to JSON
			// We expect <CORSConfiguration><CORSRule>...</CORSRule></CORSConfiguration>
			// This is a quick and dirty parser, might need a real one if complex
			// But for now let's try to extract rules.
			
			// Using fast-xml-parser would be better if available, and it is in package.json
			const { XMLParser } = require("fast-xml-parser");
			const parser = new XMLParser({
				ignoreAttributes: false,
				isArray: (name: string) => {
					return ["CORSRule", "AllowedOrigin", "AllowedMethod", "AllowedHeader", "ExposeHeader"].indexOf(name) !== -1;
				}
			});
			
			try {
				const parsed = parser.parse(bodyText);
				if (!parsed.CORSConfiguration || !parsed.CORSConfiguration.CORSRule) {
					throw new Error("Invalid CORS Configuration");
				}

				const rules = parsed.CORSConfiguration.CORSRule.map((r: any) => ({
					ID: r.ID,
					AllowedOrigins: r.AllowedOrigin,
					AllowedMethods: r.AllowedMethod,
					AllowedHeaders: r.AllowedHeader,
					ExposeHeaders: r.ExposeHeader,
					MaxAgeSeconds: r.MaxAgeSeconds
				}));

				const corsConfig = {
					CORSRules: rules
				};

				await db
					.update(buckets)
					.set({ corsConfig: JSON.stringify(corsConfig) })
					.where(eq(buckets.id, bucket.id));

				return new Response(null, { status: 200 });
			} catch (e) {
				return new Response(
					`<?xml version="1.0" encoding="UTF-8"?>
<Error>
	   <Code>MalformedXML</Code>
	   <Message>The XML you provided was not well-formed or did not validate against our published schema</Message>
	   <RequestId>0000000000000000</RequestId>
</Error>`,
					{ status: 400, headers: { "Content-Type": "application/xml" } },
				);
			}
		}

		const limit = user.storageLimitBytes;
		const upstreamHeaders = filterUpstreamHeaders(req.headers);

		// If the client provided a SHA256 checksum, pass it through.
		// Otherwise, default to UNSIGNED-PAYLOAD.
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
				return new Response("Access Denied", { status: 403 });
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
				// Buffer the entire body to compute Content-Length and check quota
				const arrayBuffer = await req.arrayBuffer();
				actualSize = arrayBuffer.byteLength;
				requestBody = arrayBuffer;

				if (limit !== null) {
					if (
						BigInt(user.storageUsageBytes) + BigInt(actualSize) >
						BigInt(limit)
					) {
						return new Response(
							`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>QuotaExceeded</Code>
    <Message>You have exceeded your storage quota.</Message>
    <Resource>${key}</Resource>
    <RequestId>0000000000000000</RequestId>
</Error>`.trim(),
							{ status: 403, headers: { "Content-Type": "application/xml" } },
						);
					}
				}

				upstreamHeaders.set("Content-Length", actualSize.toString());
			}

			// Use 0 retries for PUT to avoid consuming the streaming body
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
						.update(users)
						.set({
							storageUsageBytes: sql`${users.storageUsageBytes} + ${actualSize}`,
						})
						.where(eq(users.id, user.id));
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
				return new Response(
					`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>QuotaExceeded</Code>
    <Message>You have exceeded your storage quota.</Message>
    <Resource>${key}</Resource>
    <RequestId>0000000000000000</RequestId>
</Error>`.trim(),
					{ status: 403, headers: { "Content-Type": "application/xml" } },
				);
			}

			return new Response(
				`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>InternalError</Code>
       <Message>${error.message}</Message>
       <Resource>/</Resource>
    <RequestId>0000000000000000</RequestId>
</Error>`,
				{ status: 500, headers: { "Content-Type": "application/xml" } },
			);
		}
	}

	if (method === "DELETE") {
		if (key === "" && url.searchParams.has("cors")) {
			await db
				.update(buckets)
				.set({ corsConfig: null })
				.where(eq(buckets.id, bucket.id));
			
			return new Response(null, { status: 204 });
		}

		try {
			const cleanUrl = stripAuthQueryParams(url);
			const queryStr = cleanUrl.searchParams.toString();
			const pathWithQuery = queryStr
				? `${internalPath}?${queryStr}`
				: internalPath;

			const response = await s3Client.fetch(pathWithQuery, {
				method: "DELETE",
				headers: filterUpstreamHeaders(req.headers),
			});

			return new Response(response.body, {
				status: response.status,
				headers: response.headers,
			});
		} catch (_e) {
			return new Response("Internal Error", { status: 500 });
		}
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
			return new Response("Internal Error", { status: 500 });
		}
	}

	if (method === "POST") {
		const query = url.searchParams;

		if (query.has("delete")) {
			const bodyText = await req.text();
			const rootPrefix = getInternalPath("", user, bucket);

			const rewrittenBody = bodyText.replace(
				/<Key>(.*?)<\/Key>/g,
				(_match, p1) => {
					return `<Key>${rootPrefix}${p1}</Key>`;
				},
			);

			const md5 = new Bun.CryptoHasher("md5")
				.update(rewrittenBody)
				.digest("base64");

			const headers = filterUpstreamHeaders(req.headers);
			headers.set("Content-MD5", md5);
			headers.delete("Content-Length");

			const response = await s3Client.fetch(`?delete`, {
				method: "POST",
				headers: headers,
				body: rewrittenBody,
			});

			const resText = await response.text();
			const rewrittenRes = rewriteDeleteObjectsResponse(resText, rootPrefix);

			return new Response(rewrittenRes, {
				status: response.status,
				headers: { "Content-Type": "application/xml" },
			});
		}

		if (query.has("uploads")) {
			const response = await s3Client.fetch(`${internalPath}?uploads`, {
				method: "POST",
				headers: filterUpstreamHeaders(req.headers),
			});
			const resText = await response.text();
			const rootPrefix = getInternalPath("", user, bucket);
			const rewrittenRes = rewriteMultipartUploadResponse(resText, rootPrefix);

			return new Response(rewrittenRes, {
				status: response.status,
				headers: { "Content-Type": "application/xml" },
			});
		}

		if (query.has("uploadId")) {
			const uploadId = query.get("uploadId");
			const response = await s3Client.fetch(
				`${internalPath}?uploadId=${uploadId}`,
				{
					method: "POST",
					headers: filterUpstreamHeaders(req.headers),
					body: req.body,
				},
			);

			const resText = await response.text();
			const rootPrefix = getInternalPath("", user, bucket);
			const rewrittenRes = rewriteMultipartUploadResponse(resText, rootPrefix);

			return new Response(rewrittenRes, {
				status: response.status,
				headers: { "Content-Type": "application/xml" },
			});
		}

		return new Response("Not Implemented", { status: 501 });
	}

	return new Response("Method Not Allowed", { status: 405 });
}
