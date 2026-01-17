import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { config } from "../../../config";
import { getInternalPath } from "../../../core/s3/utils";
import { db } from "../../../db";
import { buckets, users } from "../../../db/schema";
import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import { s3Client } from "../../../lib/s3-client";
import { getCurrentUser } from "../../../lib/session";

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

		const bucket = await db
			.select()
			.from(buckets)
			.where(eq(buckets.name, bucketName))
			.limit(1);

		if (bucket.length === 0) return errorResponse("Bucket not found", 404);
		if (bucket[0].userId !== user.id && !user.isAdmin)
			return errorResponse("Unauthorized", 403);
		if (bucket[0].isPaused && !user.isAdmin)
			return errorResponse("Bucket is paused", 403);

		try {
			const body = await req.json();
			const key = body.key;
			if (!key) return errorResponse("Missing key", 400);

			const expires = Date.now() + 5 * 60 * 1000; // 5 minutes
			const dataToSign = `${bucketName}:${key}:${expires}`;
			const signature = createHmac("sha256", config.hcAuth.clientSecret)
				.update(dataToSign)
				.digest("hex");

			const url = `/api/dashboard/buckets/${bucketName}/files/preview?key=${encodeURIComponent(key)}&expires=${expires}&signature=${signature}`;

			return jsonResponse({ url });
		} catch (_e) {
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

		if (!key || !expires || !signature)
			return errorResponse("Missing params", 400);

		// Verify expiration
		if (Date.now() > parseInt(expires, 10)) {
			return errorResponse("Link expired", 410);
		}

		// Verify signature
		const dataToSign = `${bucketName}:${key}:${expires}`;
		const expectedSignature = createHmac("sha256", config.hcAuth.clientSecret)
			.update(dataToSign)
			.digest("hex");

		if (signature !== expectedSignature) {
			return errorResponse("Invalid signature", 403);
		}

		const bucket = await db
			.select()
			.from(buckets)
			.where(eq(buckets.name, bucketName))
			.limit(1);

		if (bucket.length === 0) return errorResponse("Bucket not found", 404);
		if (bucket[0].userId !== user.id && !user.isAdmin)
			return errorResponse("Unauthorized", 403);
		if (bucket[0].isPaused && !user.isAdmin)
			return errorResponse("Bucket is paused", 403);

		let owner = user;
		if (bucket[0].userId !== user.id) {
			const ownerResult = await db
				.select()
				.from(users)
				.where(eq(users.id, bucket[0].userId))
				.limit(1);
			if (ownerResult.length > 0) {
				owner = {
					...ownerResult[0],
					sessionId: "",
					accessToken: null,
					refreshToken: null,
					tokenExpiresAt: null,
				};
			}
		}

		const internalKey = getInternalPath(key, owner, bucket[0]);

		try {
			const s3Res = await s3Client.fetch(internalKey, {
				method: "GET",
			});

			if (!s3Res.ok) {
				if (s3Res.status === 404) return errorResponse("File not found", 404);
				return new Response(s3Res.body, { status: s3Res.status });
			}

			const headers = new Headers(s3Res.headers);
			headers.set("Content-Disposition", "inline");
			headers.set("Cache-Control", "private, max-age=300"); // Cache for 5 mins
			headers.delete("x-amz-request-id");
			headers.delete("x-amz-id-2");

			// Security: Force text/plain for dangerous types in preview
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
				headers.set("Content-Type", "text/plain");
			}

			return new Response(s3Res.body, {
				status: s3Res.status,
				headers,
			});
		} catch (e) {
			console.error("Preview File Error:", e);
			return errorResponse("Failed to preview file", 500);
		}
	}

	const listFilesMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/files$/,
	);
	if (listFilesMatch && req.method === "GET") {
		const bucketName = listFilesMatch[1];
		const prefix = url.searchParams.get("prefix") || "";
		const continuationToken = url.searchParams.get("continuation-token");

		const bucket = await db
			.select()
			.from(buckets)
			.where(eq(buckets.name, bucketName))
			.limit(1);

		if (bucket.length === 0) return errorResponse("Bucket not found", 404);
		if (bucket[0].userId !== user.id && !user.isAdmin)
			return errorResponse("Unauthorized", 403);
		if (bucket[0].isPaused && !user.isAdmin)
			return errorResponse("Bucket is paused", 403);

		let owner = user;
		if (bucket[0].userId !== user.id) {
			const ownerResult = await db
				.select()
				.from(users)
				.where(eq(users.id, bucket[0].userId))
				.limit(1);
			if (ownerResult.length > 0) {
				owner = {
					...ownerResult[0],
					sessionId: "",
					accessToken: null,
					refreshToken: null,
					tokenExpiresAt: null,
				};
			}
		}

		// Construct internal prefix
		const internalPrefix = getInternalPath(prefix, owner, bucket[0]);

		const query = new URLSearchParams();
		query.set("list-type", "2");
		query.set("prefix", internalPrefix);
		query.set("delimiter", "/"); // Important for folder view
		if (continuationToken) {
			query.set("continuation-token", continuationToken);
		}

		try {
			const s3Res = await s3Client.fetch(`?${query.toString()}`, {
				method: "GET",
			});

			if (!s3Res.ok) {
				throw new Error(`S3 Error: ${s3Res.status}`);
			}

			const xml = await s3Res.text();
			const parser = new XMLParser();
			const result = parser.parse(xml).ListBucketResult;

			let files = [];
			if (result.Contents) {
				const contents = Array.isArray(result.Contents)
					? result.Contents
					: [result.Contents];
				files = contents
					.map(
						(contentItem: {
							Key: string;
							Size: number;
							LastModified: string;
						}) => {
							// Strip internal prefix to get relative path
							const key = contentItem.Key;
							// We want to show the name relative to the current prefix for display?
							// Or just the full key? The UI handles display.
							// But we must strip the user/bucket prefix part.
							const rootPrefix = getInternalPath("", user, bucket[0]);
							const relativeKey = key.startsWith(rootPrefix)
								? key.slice(rootPrefix.length)
								: key;

							return {
								key: relativeKey,
								name: relativeKey.split("/").pop(),
								size: contentItem.Size,
								lastModified: contentItem.LastModified,
								url: `https://${config.s3Domain}/${relativeKey}`,
							};
						},
					)
					.filter((f: { key: string }) => f.key !== prefix); // Exclude the folder itself if it appears
			}

			let folders = [];
			if (result.CommonPrefixes) {
				const prefixes = Array.isArray(result.CommonPrefixes)
					? result.CommonPrefixes
					: [result.CommonPrefixes];
				folders = prefixes.map((prefixItem: { Prefix: string }) => {
					const p = prefixItem.Prefix;
					const rootPrefix = getInternalPath("", user, bucket[0]);
					const relativePrefix = p.startsWith(rootPrefix)
						? p.slice(rootPrefix.length)
						: p;

					return {
						prefix: relativePrefix,
						name: `${relativePrefix.split("/").filter(Boolean).pop()}/`,
					};
				});
			}

			return jsonResponse({
				files,
				folders,
				nextContinuationToken: result.NextContinuationToken,
				userId: user.id,
			});
		} catch (e) {
			console.error("List Files Error:", e);
			return errorResponse("Failed to list files", 500);
		}
	}

	if (listFilesMatch && req.method === "DELETE") {
		if (user.dataExported) {
			return errorResponse(
				"Account is frozen. Files cannot be deleted.",
				403,
			);
		}
		const bucketName = listFilesMatch[1];
		const key = url.searchParams.get("key");

		if (!key) return errorResponse("Missing key", 400);

		const bucket = await db
			.select()
			.from(buckets)
			.where(eq(buckets.name, bucketName))
			.limit(1);

		if (bucket.length === 0) return errorResponse("Bucket not found", 404);
		if (bucket[0].userId !== user.id && !user.isAdmin)
			return errorResponse("Unauthorized", 403);
		if (bucket[0].isPaused && !user.isAdmin)
			return errorResponse("Bucket is paused", 403);

		let owner = user;
		if (bucket[0].userId !== user.id) {
			const ownerResult = await db
				.select()
				.from(users)
				.where(eq(users.id, bucket[0].userId))
				.limit(1);
			if (ownerResult.length > 0) {
				owner = {
					...ownerResult[0],
					sessionId: "",
					accessToken: null,
					refreshToken: null,
					tokenExpiresAt: null,
				};
			}
		}

		const internalKey = getInternalPath(key, owner, bucket[0]);

		try {
			// Get file size first to update quota
			const headRes = await s3Client.fetch(internalKey, { method: "HEAD" });
			const size = Number(headRes.headers.get("content-length") || 0);

			const s3Res = await s3Client.fetch(internalKey, {
				method: "DELETE",
			});

			if (!s3Res.ok) {
				throw new Error(`S3 Delete Error: ${s3Res.status}`);
			}

			if (size > 0) {
				await db
					.update(buckets)
					.set({
						totalBytes: sql`${buckets.totalBytes} - ${size}`,
					})
					.where(eq(buckets.id, bucket[0].id));
			}

			return jsonResponse({ message: "Deleted" });
		} catch (e) {
			console.error("Delete File Error:", e);
			return errorResponse("Failed to delete file", 500);
		}
	}

	return errorResponse("Method not allowed", 405);
}
