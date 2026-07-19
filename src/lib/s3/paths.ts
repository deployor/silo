import { createHash } from "node:crypto";
import { config } from "../../config";
import type { buckets, users } from "../../db/schema";
import { executeDataplaneStorage } from "../dataplane-storage-client";
import { isRegionalOriginHost } from "../regions";
import { createS3XmlParser, requireS3XmlElement } from "../s3-xml";

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
	isArray: (name: string) => name === "Contents" || name === "Error",
});

function escapeXmlText(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

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
	const isPathStyleOrigin = host === S3_DOMAIN || isRegionalOriginHost(host);

	let key = "";

	if (host.endsWith(`.${S3_DOMAIN}`) && !isPathStyleOrigin) {
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

export async function deleteBucketContents(
	prefix: string,
	bucket: Pick<typeof buckets.$inferSelect, "id" | "name" | "resolvedRegion">,
) {
	let previousBatchFingerprint: string | null = null;
	let unchangedBatches = 0;

	// Always delete the first page and list again. Continuing a listing while
	// mutating its keyspace can skip keys or invalidate provider-specific
	// continuation tokens.
	for (;;) {
		const query = new URLSearchParams();
		query.set("list-type", "2");
		query.set("max-keys", "1000");
		query.set("prefix", prefix);

		const listRes = await executeDataplaneStorage({
			bucket,
			rootPrefix: prefix,
			pathWithQuery: `?${query.toString()}`,
			method: "GET",
		});
		if (!listRes.ok)
			throw new Error(`Failed to list objects: ${listRes.status}`);

		const xml = await listRes.text();
		const result = requireS3XmlElement(
			listDeleteParser.parse(xml).ListBucketResult,
			"ListBucketResult",
		);
		const contents = result.Contents;

		if (!contents || contents.length === 0) break;
		const keys = (Array.isArray(contents) ? contents : [contents]).map(
			(object: { Key: string }) => object.Key,
		);
		const fingerprint = createHash("sha256")
			.update(keys.join("\0"))
			.digest("hex");
		unchangedBatches =
			fingerprint === previousBatchFingerprint ? unchangedBatches + 1 : 0;
		previousBatchFingerprint = fingerprint;
		if (unchangedBatches >= 3) {
			throw new Error("Object deletion made no progress");
		}

		const objects = keys
			.map((key) => `<Object><Key>${escapeXmlText(key)}</Key></Object>`)
			.join("");

		const deleteBody = `<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${objects}</Delete>`;
		const md5 = createHash("md5").update(deleteBody).digest("base64");

		const deleteRes = await executeDataplaneStorage({
			bucket,
			rootPrefix: prefix,
			pathWithQuery: "?delete",
			method: "POST",
			headers: {
				"Content-Type": "application/xml",
				"Content-MD5": md5,
			},
			body: deleteBody,
		});
		if (!deleteRes.ok) {
			throw new Error(`Failed to delete objects: ${deleteRes.status}`);
		}
		const deleteXml = await deleteRes.text();
		if (deleteXml) {
			const deleteResult = listDeleteParser.parse(deleteXml).DeleteResult;
			const errors = deleteResult?.Error;
			if (errors && (Array.isArray(errors) ? errors.length > 0 : true)) {
				throw new Error(
					"Backing storage rejected one or more object deletions",
				);
			}
		}
	}

	const verifyQuery = new URLSearchParams({
		"list-type": "2",
		"max-keys": "1",
		prefix,
	});
	const verifyRes = await executeDataplaneStorage({
		bucket,
		rootPrefix: prefix,
		pathWithQuery: `?${verifyQuery.toString()}`,
		method: "GET",
	});
	if (!verifyRes.ok) {
		throw new Error(`Failed to verify empty bucket: ${verifyRes.status}`);
	}
	const verifyResult = requireS3XmlElement(
		listDeleteParser.parse(await verifyRes.text()).ListBucketResult,
		"ListBucketResult",
	);
	if (verifyResult.Contents) {
		throw new Error("Bucket storage is not empty after deletion");
	}
}
