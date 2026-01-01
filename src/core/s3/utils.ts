import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { config } from "../../config";
import { db } from "../../db";
import { buckets, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";

export function getKeyFromRequest(req: Request, bucketName: string): string {
	const url = new URL(req.url);
	const host = url.host;
	const S3_DOMAIN = config.s3Domain;

	let key = "";

	if (host.endsWith(`.${S3_DOMAIN}`) && host !== S3_DOMAIN) {
		key = url.pathname.slice(1);
	} else {
		const path = url.pathname;
		const prefix = `/${bucketName}/`;

		if (path.startsWith(prefix)) {
			key = path.slice(prefix.length);
		} else if (path === "/" || path === `/${bucketName}`) {
			key = "";
		} else {
			key = path.startsWith("/") ? path.slice(1) : path;
		}
	}

	const decodedKey = decodeURIComponent(key);
	if (decodedKey.includes("..")) {
		const parts = decodedKey.split("/");
		if (parts.includes("..")) {
			throw new Error("Invalid Key: Path traversal detected");
		}
	}

	return key;
}

export function getInternalPath(
	key: string,
	user: typeof users.$inferSelect,
	bucket: typeof buckets.$inferSelect,
): string {
	if (key.includes("..")) {
		const decodedKey = decodeURIComponent(key);
		const parts = decodedKey.split("/");
		if (parts.includes("..")) {
			throw new Error("Invalid Key: Path traversal detected");
		}
	}

	const cleanKey = key.startsWith("/") ? key.slice(1) : key;
	const sanitizedUserId = user.id.replace(/[^a-zA-Z0-9-]/g, "_");
	return `users/${sanitizedUserId}/${bucket.name}/${cleanKey}`;
}

export function stripAuthQueryParams(url: URL): URL {
	const newUrl = new URL(url.toString());
	const paramsToRemove = [
		"X-Amz-Signature",
		"X-Amz-Credential",
		"X-Amz-Date",
		"X-Amz-Algorithm",
		"X-Amz-SignedHeaders",
		"X-Amz-Security-Token",
		"x-amz-signature",
		"x-amz-credential",
		"x-amz-date",
		"x-amz-algorithm",
		"x-amz-signedheaders",
		"x-amz-security-token",
		"X-Amz-Expires",
		"x-amz-expires",
	];
	for (const p of paramsToRemove) {
		newUrl.searchParams.delete(p);
	}
	return newUrl;
}

export function filterUpstreamHeaders(reqHeaders: Headers): Headers {
	const upstreamHeaders = new Headers();
	const allowedHeaders = [
		"content-type",
		"content-length",
		"content-md5",
		"cache-control",
		"content-disposition",
		"content-encoding",
		"content-language",
		"expires",
		"range",
		"if-match",
		"if-none-match",
		"if-modified-since",
		"if-unmodified-since",
	];

	reqHeaders.forEach((value, key) => {
		const lowerKey = key.toLowerCase();
		if (allowedHeaders.includes(lowerKey)) {
			upstreamHeaders.set(key, value);
		}
	});

	return upstreamHeaders;
}

export function isReservedBucketName(name: string): boolean {
	return /^[uw][a-z0-9]{7,}$/.test(name);
}

export async function deleteBucketContents(prefix: string) {
	let continuationToken: string | undefined;
	do {
		const query = new URLSearchParams();
		query.set("list-type", "2");
		query.set("prefix", prefix);
		if (continuationToken) {
			query.set("continuation-token", continuationToken);
		}

		const res = await s3Client.fetch(`?${query.toString()}`, { method: "GET" });
		if (!res.ok) throw new Error(`Failed to list objects: ${res.status}`);

		const xml = await res.text();
		const parser = new XMLParser();
		const result = parser.parse(xml).ListBucketResult;

		if (!result.Contents) break;

		const contents = Array.isArray(result.Contents)
			? result.Contents
			: [result.Contents];

		if (contents.length === 0) break;

		const objects = contents
			.map((object: { Key: string }) => `<Object><Key>${object.Key}</Key></Object>`)
			.join("");

		const deleteBody = `<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${objects}</Delete>`;
		const md5 = createHash("md5").update(deleteBody).digest("base64");

		const deleteRes = await s3Client.fetch("?delete", {
			method: "POST",
			headers: {
				"Content-Type": "application/xml",
				"Content-MD5": md5,
			},
			body: deleteBody,
		});

		if (!deleteRes.ok)
			throw new Error(`Failed to delete objects: ${deleteRes.status}`);

		continuationToken = result.NextContinuationToken;
	} while (continuationToken);
}

export async function rewriteCopySourceHeader(
	_req: Request,
	headerValue: string,
	currentUser: typeof users.$inferSelect,
	targetBucket: typeof buckets.$inferSelect,
): Promise<string | null> {
	const clean = headerValue.startsWith("/")
		? headerValue.slice(1)
		: headerValue;

	const firstSlash = clean.indexOf("/");
	if (firstSlash === -1) return null;

	const bucketName = clean.slice(0, firstSlash);
	const key = clean.slice(firstSlash + 1);

	let sourceBucket: typeof buckets.$inferSelect;

	if (bucketName === targetBucket.name) {
		sourceBucket = targetBucket;
	} else {
		const bucketResult = await db
			.select()
			.from(buckets)
			.where(eq(buckets.name, bucketName))
			.limit(1);
		if (bucketResult.length === 0) return null;
		sourceBucket = bucketResult[0];
	}

	if (sourceBucket.isCdn) return null;

	// Security Check:
	// 1. Same bucket (Self-Copy) -> Allowed
	// 2. Different bucket -> Only if source is Public
	if (sourceBucket.id !== targetBucket.id && !sourceBucket.isPublic) {
		return null;
	}

	const sanitizedUserId = sourceBucket.userId.replace(/[^a-zA-Z0-9-]/g, "_");
	const internalPath = `users/${sanitizedUserId}/${sourceBucket.name}/${key}`;

	return `/${config.s3.bucket}/${internalPath}`;
}

