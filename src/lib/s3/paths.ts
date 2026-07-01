import { createHash } from "node:crypto";
import { config } from "../../config";
import type { buckets, users } from "../../db/schema";
import { s3Client } from "../s3-client";
import { createS3XmlParser } from "../s3-xml";

const PATH_TRAVERSAL_ERROR = "Invalid Key: Path traversal detected";
const USER_ID_SAFE_CHARS = /[^a-zA-Z0-9-]/g;
const RESERVED_BUCKET_NAME = /^[uw][a-z0-9]{7,}$/;
const AUTH_QUERY_PARAMS = [
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
] as const;
const listDeleteParser = createS3XmlParser({
	isArray: (name: string) => name === "Contents",
});

function decodeRepeated(input: string, rounds: number) {
	let out = input;
	for (let i = 0; i < rounds; i++) {
		try {
			out = decodeURIComponent(out);
		} catch {
			break;
		}
	}
	return out;
}

function assertNoTraversal(rawKey: string) {
	const decodedKey = decodeRepeated(rawKey, 3);

	if (decodedKey.includes("..") && decodedKey.split("/").includes("..")) {
		throw new Error(PATH_TRAVERSAL_ERROR);
	}

	const lowerRaw = rawKey.toLowerCase();
	if (
		lowerRaw.includes("%2e%2e") ||
		lowerRaw.includes("%2e.") ||
		lowerRaw.includes(".%2e")
	) {
		throw new Error(PATH_TRAVERSAL_ERROR);
	}
}

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

	assertNoTraversal(key);

	return key;
}

export function getInternalPath(
	key: string,
	user: typeof users.$inferSelect | null | undefined,
	bucket: typeof buckets.$inferSelect,
): string {
	assertNoTraversal(key);

	const cleanKey = (key.startsWith("/") ? key.slice(1) : key)
		.replace(/\?/g, "%3F")
		.replace(/#/g, "%23")
		.replace(/&/g, "%26");

	if (bucket.isSystem && !bucket.userId) {
		return `system/${bucket.name}/${cleanKey}`;
	}

	if (!user) {
		throw new Error("User required for non-system buckets");
	}

	const sanitizedUserId = user.id.replace(USER_ID_SAFE_CHARS, "_");
	return `users/${sanitizedUserId}/${bucket.name}/${cleanKey}`;
}

export function stripAuthQueryParams(url: URL): URL {
	const newUrl = new URL(url.toString());
	for (const p of AUTH_QUERY_PARAMS) {
		newUrl.searchParams.delete(p);
	}
	return newUrl;
}

export function isReservedBucketName(name: string): boolean {
	return RESERVED_BUCKET_NAME.test(name);
}

export async function deleteBucketContents(prefix: string) {
	let continuationToken: string | undefined;
	let pendingDelete: Promise<Response> | null = null;

	do {
		const query = new URLSearchParams();
		query.set("list-type", "2");
		query.set("max-keys", "1000");
		query.set("prefix", prefix);
		if (continuationToken) {
			query.set("continuation-token", continuationToken);
		}

		const listRes = await s3Client.fetch(`?${query.toString()}`, {
			method: "GET",
		});
		if (!listRes.ok)
			throw new Error(`Failed to list objects: ${listRes.status}`);

		const xml = await listRes.text();
		const result = listDeleteParser.parse(xml).ListBucketResult;
		const contents = result.Contents;

		// Wait for previous delete batch to finish before starting next
		if (pendingDelete) {
			const prev = await pendingDelete;
			if (!prev.ok)
				throw new Error(`Failed to delete objects: ${prev.status}`);
		}

		if (!contents || contents.length === 0) break;

		const objects = (Array.isArray(contents) ? contents : [contents])
			.map(
				(object: { Key: string }) =>
					`<Object><Key>${object.Key}</Key></Object>`,
			)
			.join("");

		const deleteBody = `<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${objects}</Delete>`;
		const md5 = createHash("md5").update(deleteBody).digest("base64");

		pendingDelete = s3Client.fetch("?delete", {
			method: "POST",
			headers: {
				"Content-Type": "application/xml",
				"Content-MD5": md5,
			},
			body: deleteBody,
		});

		continuationToken = result.NextContinuationToken;

		// Fire + await same-batch if this is the last page
		if (!continuationToken && pendingDelete) {
			const final = await pendingDelete;
			if (!final.ok)
				throw new Error(`Failed to delete objects: ${final.status}`);
		}
	} while (continuationToken);
}
