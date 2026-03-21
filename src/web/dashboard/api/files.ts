import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { config } from "../../../config";
import { getCorsHeaders } from "../../../core/s3/cors";
import { handleGetRequest } from "../../../core/s3/get";
import { getInternalPath } from "../../../core/s3/utils";
import { db } from "../../../db";
import { buckets, users } from "../../../db/schema";
import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import {
	consumeStorageQuota,
	releaseStorageQuota,
} from "../../../lib/quota-cache";
import { s3Client } from "../../../lib/s3-client";
import { getCurrentUser } from "../../../lib/session";

type BucketRecord = typeof buckets.$inferSelect;
type UserRecord = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

type FileItem = {
	key: string;
	name: string;
	size: number;
	lastModified: string;
	url: string;
	type: "file";
	extension: string;
	parentPrefix: string;
	relativePath: string;
};

type FolderItem = {
	prefix: string;
	name: string;
	type: "folder";
	parentPrefix: string;
};

type DirectoryTotals = {
	totalFiles: number;
	totalFolders: number;
};

type BucketContext = {
	bucket: BucketRecord;
	owner: typeof users.$inferSelect;
};

const parser = new XMLParser();
const MAX_BULK_KEYS = 250;
const MAX_UPLOAD_FILES = 100;
const MAX_SEARCH_PAGES = 25;
const S3_LIST_PAGE_SIZE = 200;

function cloneOwnerUser(user: typeof users.$inferSelect) {
	return {
		...user,
		sessionId: "",
		accessToken: null,
		refreshToken: null,
		tokenExpiresAt: null,
	};
}

async function getBucketAndOwner(
	requestUser: UserRecord,
	bucketName: string,
): Promise<BucketContext> {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);

	if (bucket.length === 0) {
		throw new Error("Bucket not found");
	}

	if (bucket[0].userId !== requestUser.id && !requestUser.isAdmin) {
		throw new Error("Unauthorized");
	}

	if (bucket[0].isPaused && !requestUser.isAdmin) {
		throw new Error("Bucket is paused");
	}

	if (bucket[0].userId === requestUser.id) {
		return { bucket: bucket[0], owner: requestUser };
	}

	if (!bucket[0].userId) {
		throw new Error("Owner not found");
	}

	const ownerResult = await db
		.select()
		.from(users)
		.where(eq(users.id, bucket[0].userId))
		.limit(1);

	if (ownerResult.length === 0) {
		throw new Error("Owner not found");
	}

	return { bucket: bucket[0], owner: cloneOwnerUser(ownerResult[0]) };
}

function responseForBucketError(error: unknown): Response | null {
	const message = error instanceof Error ? error.message : "Internal Error";
	if (message === "Bucket not found") return errorResponse(message, 404);
	if (message === "Unauthorized") return errorResponse(message, 403);
	if (message === "Bucket is paused") return errorResponse(message, 403);
	if (message === "Owner not found") return errorResponse(message, 404);
	return null;
}

function normalizeUserKey(
	rawKey: string,
	options?: { allowEmpty?: boolean },
): string {
	const key = rawKey.replace(/\\/g, "/").replace(/^\/+/, "");
	const cleaned = key
		.split("/")
		.filter((segment) => segment.length > 0)
		.join("/");

	if (!options?.allowEmpty && !cleaned) {
		throw new Error("Invalid key");
	}

	if (
		[...cleaned].some((char) => {
			const code = char.charCodeAt(0);
			return code < 32 || code === 127;
		})
	) {
		throw new Error("Invalid key");
	}

	if (cleaned.length > 1024) {
		throw new Error("Key too long");
	}

	const segments = cleaned.split("/");
	if (segments.some((segment) => segment === "." || segment === "..")) {
		throw new Error("Invalid key");
	}

	return cleaned;
}

function normalizeDirectoryPrefix(
	rawPrefix: string | null | undefined,
): string {
	const normalized = normalizeUserKey(rawPrefix || "", { allowEmpty: true });
	if (!normalized) return "";
	return `${normalized}/`;
}

function getParentPrefix(key: string): string {
	const parts = key.split("/");
	parts.pop();
	return parts.length > 0 ? `${parts.join("/")}/` : "";
}

function getNameFromKey(key: string): string {
	return key.split("/").filter(Boolean).pop() || key;
}

function getExtension(key: string): string {
	const name = getNameFromKey(key);
	const dot = name.lastIndexOf(".");
	return dot > -1 ? name.slice(dot + 1).toLowerCase() : "";
}

function mapContentToFileItem(
	contentItem: { Key: string; Size: number; LastModified: string },
	rootPrefix: string,
): FileItem | null {
	const key = contentItem.Key;
	const relativeKey = key.startsWith(rootPrefix)
		? key.slice(rootPrefix.length)
		: key;
	const normalizedKey = normalizeUserKey(relativeKey, { allowEmpty: true });

	if (!normalizedKey) return null;

	return {
		key: normalizedKey,
		name: getNameFromKey(normalizedKey),
		size: Number(contentItem.Size) || 0,
		lastModified: contentItem.LastModified,
		url: `https://${config.s3Domain}/${normalizedKey}`,
		type: "file",
		extension: getExtension(normalizedKey),
		parentPrefix: getParentPrefix(normalizedKey),
		relativePath: normalizedKey,
	};
}

function mapPrefixToFolderItem(
	prefixItem: { Prefix: string },
	rootPrefix: string,
): FolderItem | null {
	const relativePrefix = prefixItem.Prefix.startsWith(rootPrefix)
		? prefixItem.Prefix.slice(rootPrefix.length)
		: prefixItem.Prefix;
	const normalizedPrefix = normalizeUserKey(relativePrefix, {
		allowEmpty: true,
	});

	if (!normalizedPrefix) return null;

	return {
		prefix: `${normalizedPrefix}/`,
		name: `${getNameFromKey(normalizedPrefix)}/`,
		type: "folder",
		parentPrefix: getParentPrefix(normalizedPrefix),
	};
}

async function listDirectoryPage(params: {
	bucket: BucketRecord;
	owner: typeof users.$inferSelect;
	prefix: string;
	continuationToken: string | null;
}) {
	const internalPrefix = getInternalPath(
		params.prefix,
		params.owner,
		params.bucket,
	);
	const rootPrefix = getInternalPath("", params.owner, params.bucket);
	const query = new URLSearchParams();
	query.set("list-type", "2");
	query.set("prefix", internalPrefix);
	query.set("delimiter", "/");
	query.set("max-keys", "100");
	if (params.continuationToken) {
		query.set("continuation-token", params.continuationToken);
	}

	const s3Res = await s3Client.fetch(`?${query.toString()}`, { method: "GET" });
	if (!s3Res.ok) {
		throw new Error(`S3 Error: ${s3Res.status}`);
	}

	const xml = await s3Res.text();
	const result = parser.parse(xml).ListBucketResult;

	const contents = result.Contents
		? Array.isArray(result.Contents)
			? result.Contents
			: [result.Contents]
		: [];

	const prefixes = result.CommonPrefixes
		? Array.isArray(result.CommonPrefixes)
			? result.CommonPrefixes
			: [result.CommonPrefixes]
		: [];

	const files = contents
		.map((contentItem: { Key: string; Size: number; LastModified: string }) =>
			mapContentToFileItem(contentItem, rootPrefix),
		)
		.filter((item: FileItem | null): item is FileItem => Boolean(item))
		.filter(
			(item: FileItem) =>
				item.key !== normalizeUserKey(params.prefix, { allowEmpty: true }),
		);

	const folders = prefixes
		.map((prefixItem: { Prefix: string }) =>
			mapPrefixToFolderItem(prefixItem, rootPrefix),
		)
		.filter((item: FolderItem | null): item is FolderItem => Boolean(item));

	return {
		files,
		folders,
		nextContinuationToken: result.NextContinuationToken || null,
	};
}

async function countDirectoryTotals(params: {
	bucket: BucketRecord;
	owner: typeof users.$inferSelect;
	prefix: string;
}): Promise<DirectoryTotals> {
	const internalPrefix = getInternalPath(
		params.prefix,
		params.owner,
		params.bucket,
	);
	const rootPrefix = getInternalPath("", params.owner, params.bucket);
	const normalizedCurrentPrefix = normalizeUserKey(params.prefix, {
		allowEmpty: true,
	});
	let continuationToken: string | null = null;
	let totalFiles = 0;
	const folderPrefixes = new Set<string>();

	do {
		const query = new URLSearchParams();
		query.set("list-type", "2");
		query.set("prefix", internalPrefix);
		query.set("delimiter", "/");
		query.set("max-keys", "1000");
		if (continuationToken) {
			query.set("continuation-token", continuationToken);
		}

		const s3Res = await s3Client.fetch(`?${query.toString()}`, {
			method: "GET",
		});
		if (!s3Res.ok) {
			throw new Error(`S3 Error: ${s3Res.status}`);
		}

		const xml = await s3Res.text();
		const result = parser.parse(xml).ListBucketResult;
		const contents = result.Contents
			? Array.isArray(result.Contents)
				? result.Contents
				: [result.Contents]
			: [];
		const prefixes = result.CommonPrefixes
			? Array.isArray(result.CommonPrefixes)
				? result.CommonPrefixes
				: [result.CommonPrefixes]
			: [];

		for (const contentItem of contents as Array<{ Key: string }>) {
			const relativeKey = contentItem.Key.startsWith(rootPrefix)
				? contentItem.Key.slice(rootPrefix.length)
				: contentItem.Key;
			if (relativeKey !== normalizedCurrentPrefix) {
				totalFiles += 1;
			}
		}

		for (const prefixItem of prefixes as Array<{ Prefix: string }>) {
			folderPrefixes.add(prefixItem.Prefix);
		}

		continuationToken = result.NextContinuationToken || null;
	} while (continuationToken);

	return {
		totalFiles,
		totalFolders: folderPrefixes.size,
	};
}

async function searchFiles(params: {
	bucket: BucketRecord;
	owner: typeof users.$inferSelect;
	query: string;
	currentPrefix: string;
	scope: "current" | "all";
	limit: number;
	cursor: string | null;
}) {
	const trimmedQuery = params.query.trim().toLowerCase();
	const scanPrefix =
		params.scope === "current"
			? normalizeUserKey(params.currentPrefix, { allowEmpty: true })
			: "";
	const internalPrefix = getInternalPath(
		scanPrefix,
		params.owner,
		params.bucket,
	);
	const rootPrefix = getInternalPath("", params.owner, params.bucket);
	const query = new URLSearchParams();
	query.set("list-type", "2");
	query.set("prefix", internalPrefix);
	query.set("max-keys", String(S3_LIST_PAGE_SIZE));
	if (params.cursor) query.set("continuation-token", params.cursor);

	const matches: FileItem[] = [];
	let pagesScanned = 0;
	let nextCursor = params.cursor;
	let truncated = false;

	while (matches.length < params.limit && pagesScanned < MAX_SEARCH_PAGES) {
		if (pagesScanned > 0) {
			query.delete("continuation-token");
			if (nextCursor) query.set("continuation-token", nextCursor);
		}

		const s3Res = await s3Client.fetch(`?${query.toString()}`, {
			method: "GET",
		});
		if (!s3Res.ok) {
			throw new Error(`S3 Error: ${s3Res.status}`);
		}

		const xml = await s3Res.text();
		const result = parser.parse(xml).ListBucketResult;
		const contents = result.Contents
			? Array.isArray(result.Contents)
				? result.Contents
				: [result.Contents]
			: [];

		for (const contentItem of contents) {
			const mapped = mapContentToFileItem(contentItem, rootPrefix);
			if (!mapped) continue;

			const searchable = `${mapped.relativePath} ${mapped.name}`.toLowerCase();
			if (!searchable.includes(trimmedQuery)) continue;
			matches.push(mapped);
			if (matches.length >= params.limit) break;
		}

		nextCursor = result.NextContinuationToken || null;
		pagesScanned += 1;

		if (!nextCursor) break;
	}

	if (nextCursor) {
		truncated = true;
	}

	return {
		files: matches,
		nextCursor,
		truncated,
		scannedPages: pagesScanned,
	};
}

async function deleteSingleObject(internalKey: string): Promise<number> {
	const headRes = await s3Client.fetch(internalKey, { method: "HEAD" });
	const size = Number(headRes.headers.get("content-length") || 0);
	const deleteRes = await s3Client.fetch(internalKey, { method: "DELETE" });
	if (!deleteRes.ok) {
		throw new Error(`S3 Delete Error: ${deleteRes.status}`);
	}
	return size;
}

async function deletePrefixObjects(params: {
	bucket: BucketRecord;
	owner: typeof users.$inferSelect;
	prefixes: string[];
}): Promise<{ deletedBytes: number; deletedKeys: string[] }> {
	const normalizedPrefixes = Array.from(
		new Set(params.prefixes.map((prefix) => normalizeDirectoryPrefix(prefix))),
	);
	if (normalizedPrefixes.some((prefix) => !prefix)) {
		throw new Error("Refusing to delete root folder");
	}
	let deletedBytes = 0;
	const deletedKeys: string[] = [];

	for (const normalizedPrefix of normalizedPrefixes) {
		const internalPrefix = getInternalPath(
			normalizedPrefix,
			params.owner,
			params.bucket,
		);
		const rootPrefix = getInternalPath("", params.owner, params.bucket);
		let continuationToken: string | null = null;

		do {
			const query = new URLSearchParams();
			query.set("list-type", "2");
			query.set("prefix", internalPrefix);
			query.set("max-keys", String(S3_LIST_PAGE_SIZE));
			if (continuationToken) {
				query.set("continuation-token", continuationToken);
			}

			const listRes = await s3Client.fetch(`?${query.toString()}`, {
				method: "GET",
			});
			if (!listRes.ok) {
				throw new Error(`S3 Error: ${listRes.status}`);
			}

			const xml = await listRes.text();
			const result = parser.parse(xml).ListBucketResult;
			const contents = result.Contents
				? Array.isArray(result.Contents)
					? result.Contents
					: [result.Contents]
				: [];

			for (const contentItem of contents as Array<{
				Key: string;
				Size: number;
			}>) {
				const objectKey = contentItem.Key;
				const relativeKey = objectKey.startsWith(rootPrefix)
					? objectKey.slice(rootPrefix.length)
					: objectKey;
				deletedBytes += await deleteSingleObject(objectKey);
				deletedKeys.push(relativeKey);
			}

			continuationToken = result.NextContinuationToken || null;
		} while (continuationToken);
	}

	return { deletedBytes, deletedKeys };
}

async function copyObject(
	sourceInternalKey: string,
	destinationInternalKey: string,
) {
	const res = await s3Client.fetch(destinationInternalKey, {
		method: "PUT",
		headers: {
			"x-amz-copy-source": `/${config.s3.bucket}/${sourceInternalKey}`,
			"Content-Length": "0",
		},
	});

	if (!res.ok) {
		throw new Error(`S3 Copy Error: ${res.status}`);
	}
}

async function headObject(internalKey: string) {
	const res = await s3Client.fetch(internalKey, { method: "HEAD" });
	if (!res.ok) {
		throw new Error(
			res.status === 404 ? "File not found" : `S3 Head Error: ${res.status}`,
		);
	}
	return {
		size: Number(res.headers.get("content-length") || 0),
		contentType: res.headers.get("content-type") || "application/octet-stream",
	};
}

export async function handleFiles(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	const url = new URL(req.url);
	const path = url.pathname;

	const signPreviewMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/files\/sign$/,
	);
	if (signPreviewMatch && req.method === "POST") {
		const bucketName = signPreviewMatch[1];

		let bucketData: BucketContext;
		try {
			bucketData = await getBucketAndOwner(user, bucketName);
		} catch (error) {
			return (
				responseForBucketError(error) || errorResponse("Internal Error", 500)
			);
		}

		try {
			const body = await req.json();
			const key = normalizeUserKey(String(body.key || ""));
			getInternalPath(key, bucketData.owner, bucketData.bucket);

			const expires = Date.now() + 5 * 60 * 1000;
			const dataToSign = `${bucketName}:${key}:${expires}`;
			const signature = createHmac("sha256", config.hcAuth.clientSecret)
				.update(dataToSign)
				.digest("hex");

			const signedUrl = `/api/dashboard/buckets/${bucketName}/files/preview?key=${encodeURIComponent(
				key,
			)}&expires=${expires}&signature=${signature}`;

			return jsonResponse({ url: signedUrl });
		} catch (_error) {
			return errorResponse("Internal Error", 500);
		}
	}

	const previewFileMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/files\/preview$/,
	);
	if (previewFileMatch && req.method === "GET") {
		const bucketName = previewFileMatch[1];
		const key = url.searchParams.get("key");
		const expires = url.searchParams.get("expires");
		const signature = url.searchParams.get("signature");

		if (!key || !expires || !signature) {
			return errorResponse("Missing params", 400);
		}

		if (Date.now() > Number.parseInt(expires, 10)) {
			return errorResponse("Link expired", 410);
		}

		const safeKey = normalizeUserKey(key);
		const dataToSign = `${bucketName}:${safeKey}:${expires}`;
		const expectedSignature = createHmac("sha256", config.hcAuth.clientSecret)
			.update(dataToSign)
			.digest("hex");

		if (signature !== expectedSignature) {
			return errorResponse("Invalid signature", 403);
		}

		let bucketData: BucketContext;
		try {
			bucketData = await getBucketAndOwner(user, bucketName);
		} catch (error) {
			return (
				responseForBucketError(error) || errorResponse("Internal Error", 500)
			);
		}

		const internalKey = getInternalPath(
			safeKey,
			bucketData.owner,
			bucketData.bucket,
		);

		try {
			const corsHeaders = getCorsHeaders(req, bucketData.bucket);
			const response = await handleGetRequest(
				req,
				bucketData.owner,
				bucketData.bucket,
				safeKey,
				internalKey,
				url,
				corsHeaders,
				{ consumeQuota: false },
			);

			if (!response.ok) {
				if (response.status === 404)
					return errorResponse("File not found", 404);
				return response;
			}

			const headers = new Headers(response.headers);
			headers.set("Content-Disposition", "inline");
			headers.set("Cache-Control", "private, max-age=300");
			headers.delete("x-amz-request-id");
			headers.delete("x-amz-id-2");

			const contentType = headers.get("content-type") || "";
			const dangerousTypes = [
				"text/html",
				"application/xhtml+xml",
				"image/svg+xml",
				"text/xml",
				"application/xml",
				"text/javascript",
			];

			if (dangerousTypes.some((type) => contentType.includes(type))) {
				headers.set("Content-Type", "text/plain");
			}

			return new Response(response.body, {
				status: response.status,
				headers,
			});
		} catch (error) {
			console.error("Preview File Error:", error);
			return errorResponse("Failed to preview file", 500);
		}
	}

	const listFilesMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/files$/,
	);
	if (!listFilesMatch) {
		return errorResponse("Method not allowed", 405);
	}

	const bucketName = listFilesMatch[1];
	let bucketData: BucketContext;
	try {
		bucketData = await getBucketAndOwner(user, bucketName);
	} catch (error) {
		return (
			responseForBucketError(error) || errorResponse("Internal Error", 500)
		);
	}

	if (req.method === "GET") {
		const searchQuery = (url.searchParams.get("query") || "").trim();
		const currentPrefix = normalizeDirectoryPrefix(
			url.searchParams.get("prefix"),
		);

		if (searchQuery) {
			const scope = url.searchParams.get("scope") === "all" ? "all" : "current";
			const cursor = url.searchParams.get("cursor");
			const limit = Math.max(
				10,
				Math.min(Number(url.searchParams.get("limit") || 100), 200),
			);

			try {
				const result = await searchFiles({
					bucket: bucketData.bucket,
					owner: bucketData.owner,
					query: searchQuery,
					currentPrefix,
					scope,
					limit,
					cursor,
				});

				return jsonResponse({
					mode: "search",
					query: searchQuery,
					scope,
					currentPrefix,
					files: result.files,
					folders: [],
					nextCursor: result.nextCursor,
					truncated: result.truncated,
					scannedPages: result.scannedPages,
				});
			} catch (error) {
				console.error("Search Files Error:", error);
				return errorResponse("Failed to search files", 500);
			}
		}

		const continuationToken = url.searchParams.get("continuation-token");

		try {
			const result = await listDirectoryPage({
				bucket: bucketData.bucket,
				owner: bucketData.owner,
				prefix: currentPrefix,
				continuationToken,
			});
			const totals = await countDirectoryTotals({
				bucket: bucketData.bucket,
				owner: bucketData.owner,
				prefix: currentPrefix,
			});

			return jsonResponse({
				mode: "directory",
				currentPrefix,
				files: result.files,
				folders: result.folders,
				nextContinuationToken: result.nextContinuationToken,
				totalFiles: totals.totalFiles,
				totalFolders: totals.totalFolders,
			});
		} catch (error) {
			console.error("List Files Error:", error);
			return errorResponse("Failed to list files", 500);
		}
	}

	if (req.method === "DELETE") {
		if (user.dataExported) {
			return errorResponse("Account is frozen. Files cannot be deleted.", 403);
		}

		try {
			const body = await req.json().catch(() => null);
			const folderPrefixes = Array.isArray(body?.prefixes)
				? body.prefixes.map((prefix: unknown) => String(prefix))
				: body?.prefix
					? [String(body.prefix)]
					: [];
			const keys = Array.isArray(body?.keys)
				? body.keys
				: url.searchParams.get("key")
					? [url.searchParams.get("key")]
					: [];

			if (folderPrefixes.length > 0) {
				const result = await deletePrefixObjects({
					bucket: bucketData.bucket,
					owner: bucketData.owner,
					prefixes: folderPrefixes,
				});

				let deletedBytes = result.deletedBytes;
				const deletedKeys = [...result.deletedKeys];

				if (keys.length > 0) {
					if (keys.length > MAX_BULK_KEYS) {
						return errorResponse(
							`Too many files selected (max ${MAX_BULK_KEYS})`,
							400,
						);
					}

					const normalizedKeys = keys.map((key: unknown) =>
						normalizeUserKey(String(key)),
					);
					for (const key of normalizedKeys) {
						const internalKey = getInternalPath(
							key,
							bucketData.owner,
							bucketData.bucket,
						);
						deletedBytes += await deleteSingleObject(internalKey);
						deletedKeys.push(key);
					}
				}

				if (deletedBytes > 0) {
					await db
						.update(buckets)
						.set({
							totalBytes: sql`${buckets.totalBytes} - ${deletedBytes}`,
						})
						.where(eq(buckets.id, bucketData.bucket.id));
				}

				return jsonResponse({
					message:
						keys.length > 0 ? "Deleted folders and files" : "Deleted folders",
					deletedPrefixes: folderPrefixes.map((prefix: string) =>
						normalizeDirectoryPrefix(prefix),
					),
					deletedKeys,
					deletedBytes,
				});
			}

			if (keys.length === 0) return errorResponse("Missing key", 400);
			if (keys.length > MAX_BULK_KEYS) {
				return errorResponse(
					`Too many files selected (max ${MAX_BULK_KEYS})`,
					400,
				);
			}

			let deletedBytes = 0;
			const normalizedKeys = keys.map((key: unknown) =>
				normalizeUserKey(String(key)),
			);
			for (const key of normalizedKeys) {
				const internalKey = getInternalPath(
					key,
					bucketData.owner,
					bucketData.bucket,
				);
				deletedBytes += await deleteSingleObject(internalKey);
			}

			if (deletedBytes > 0) {
				await db
					.update(buckets)
					.set({ totalBytes: sql`${buckets.totalBytes} - ${deletedBytes}` })
					.where(eq(buckets.id, bucketData.bucket.id));
			}

			return jsonResponse({
				message: normalizedKeys.length === 1 ? "Deleted" : "Deleted files",
				deletedKeys: normalizedKeys,
				deletedBytes,
			});
		} catch (error) {
			console.error("Delete File Error:", error);
			const message =
				error instanceof Error ? error.message : "Failed to delete file";
			return errorResponse(message, 500);
		}
	}

	if (req.method === "POST") {
		const action = url.searchParams.get("action") || "upload";

		if (action === "upload") {
			if (user.dataExported) {
				return errorResponse(
					"Account is frozen. Files cannot be uploaded.",
					403,
				);
			}

			try {
				const formData = await req.formData();
				const prefix = normalizeUserKey(String(formData.get("prefix") || ""), {
					allowEmpty: true,
				});
				const entries: Array<[string, File]> = [];
				for (const [name, value] of formData.entries()) {
					if (name === "files" && typeof value !== "string") {
						entries.push([name, value]);
					}
				}

				if (entries.length === 0)
					return errorResponse("No files uploaded", 400);
				if (entries.length > MAX_UPLOAD_FILES) {
					return errorResponse(
						`Too many files selected (max ${MAX_UPLOAD_FILES})`,
						400,
					);
				}

				const uploads: Array<{
					key: string;
					name: string;
					size: number;
					status: "uploaded";
				}> = [];
				let reservedBytes = 0;

				for (const [, file] of entries) {
					const relativePathValue = formData.get(
						`path:${file.name}:${file.size}`,
					);
					const rawPath =
						typeof relativePathValue === "string" && relativePathValue.trim()
							? relativePathValue.trim()
							: file.webkitRelativePath || file.name;
					const normalizedRelativePath = normalizeUserKey(rawPath);
					const destinationKey = normalizeUserKey(
						prefix
							? `${prefix}/${normalizedRelativePath}`
							: normalizedRelativePath,
					);

					const size = file.size;
					if (!user.isImmortal && size > 0) {
						const reserved = await consumeStorageQuota(
							{
								id: user.id,
								isImmortal: user.isImmortal,
								storageLimitBytes: user.storageLimitBytes,
								egressLimitBytes: user.egressLimitBytes,
							},
							Number(user.storageUsageBytes) + reservedBytes,
							size,
						);

						if (!reserved) {
							if (reservedBytes > 0)
								await releaseStorageQuota(user.id, reservedBytes);
							return errorResponse("Quota exceeded", 403);
						}
						reservedBytes += size;
					}

					const internalKey = getInternalPath(
						destinationKey,
						bucketData.owner,
						bucketData.bucket,
					);
					const uploadRes = await s3Client.fetch(internalKey, {
						method: "PUT",
						body: file.stream(),
						headers: {
							"Content-Type": file.type || "application/octet-stream",
							"Content-Length": String(size),
						},
						duplex: "half",
					} as RequestInit);

					if (!uploadRes.ok) {
						if (reservedBytes > 0)
							await releaseStorageQuota(user.id, reservedBytes);
						return errorResponse(`Upload failed for ${destinationKey}`, 500);
					}

					uploads.push({
						key: destinationKey,
						name: file.name,
						size,
						status: "uploaded",
					});
				}

				const totalUploadedBytes = uploads.reduce(
					(sum, item) => sum + item.size,
					0,
				);
				if (totalUploadedBytes > 0) {
					await db
						.update(buckets)
						.set({
							totalBytes: sql`${buckets.totalBytes} + ${totalUploadedBytes}`,
							totalRequests: sql`${buckets.totalRequests} + ${uploads.length}`,
						})
						.where(eq(buckets.id, bucketData.bucket.id));
				}

				return jsonResponse({
					message: "Uploaded files",
					uploads,
					totalUploadedBytes,
				});
			} catch (error) {
				console.error("Upload Files Error:", error);
				const message =
					error instanceof Error ? error.message : "Upload failed";
				return errorResponse(message, 500);
			}
		}

		return errorResponse("Unknown action", 400);
	}

	if (req.method === "PATCH") {
		if (user.dataExported) {
			return errorResponse("Account is frozen. Files cannot be updated.", 403);
		}

		try {
			const body = await req.json();
			const action = String(body?.action || "");

			if (action === "rename") {
				const sourceKey = normalizeUserKey(String(body.sourceKey || ""));
				const destinationKey = normalizeUserKey(
					String(body.destinationKey || ""),
				);
				if (sourceKey === destinationKey) {
					return errorResponse("Destination must be different", 400);
				}

				const sourceInternalKey = getInternalPath(
					sourceKey,
					bucketData.owner,
					bucketData.bucket,
				);
				const destinationInternalKey = getInternalPath(
					destinationKey,
					bucketData.owner,
					bucketData.bucket,
				);

				await headObject(sourceInternalKey);
				await copyObject(sourceInternalKey, destinationInternalKey);
				await deleteSingleObject(sourceInternalKey);

				return jsonResponse({
					message: "Renamed file",
					sourceKey,
					destinationKey,
				});
			}

			if (action === "move") {
				const destinationPrefix = normalizeDirectoryPrefix(
					String(body.destinationPrefix || ""),
				);
				const sourceKeys = Array.isArray(body.sourceKeys)
					? body.sourceKeys.map((value: unknown) =>
							normalizeUserKey(String(value)),
						)
					: [];

				if (sourceKeys.length === 0) return errorResponse("Missing files", 400);
				if (sourceKeys.length > MAX_BULK_KEYS) {
					return errorResponse(
						`Too many files selected (max ${MAX_BULK_KEYS})`,
						400,
					);
				}

				const moved: Array<{ sourceKey: string; destinationKey: string }> = [];

				for (const sourceKey of sourceKeys) {
					const destinationKey = normalizeUserKey(
						destinationPrefix
							? `${destinationPrefix}/${getNameFromKey(sourceKey)}`
							: getNameFromKey(sourceKey),
					);

					const sourceInternalKey = getInternalPath(
						sourceKey,
						bucketData.owner,
						bucketData.bucket,
					);
					const destinationInternalKey = getInternalPath(
						destinationKey,
						bucketData.owner,
						bucketData.bucket,
					);

					await headObject(sourceInternalKey);
					await copyObject(sourceInternalKey, destinationInternalKey);
					await deleteSingleObject(sourceInternalKey);

					moved.push({ sourceKey, destinationKey });
				}

				return jsonResponse({
					message: "Moved files",
					moved,
					destinationPrefix,
				});
			}

			return errorResponse("Unknown action", 400);
		} catch (error) {
			console.error("Update File Error:", error);
			const message =
				error instanceof Error ? error.message : "Failed to update file";
			return errorResponse(message, 500);
		}
	}

	return errorResponse("Method not allowed", 405);
}
