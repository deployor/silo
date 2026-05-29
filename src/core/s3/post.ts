import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import type { buckets, users } from "../../db/schema";
import { buckets as bucketsTable } from "../../db/schema";
import {
	clearMultipartQuota,
	registerMultipartUploadQuota,
} from "../../lib/quota-cache";
import { s3Client } from "../../lib/s3-client";
import { S3Errors } from "../../lib/s3-errors";
import { parseS3Xml } from "../../lib/s3-xml";
import {
	rewriteDeleteObjectsResponse,
	rewriteMultipartUploadResponse,
} from "../../lib/xml-rewriter";
import {
	bumpListCacheVersion,
	filterUpstreamHeaders,
	getInternalPath,
	invalidateObjectCaches,
} from "./utils";

export async function handlePostRequest(
	req: Request,
	user: typeof users.$inferSelect | null,
	bucket: typeof buckets.$inferSelect,
	internalPath: string,
	url: URL,
) {
	const query = url.searchParams;

	if (query.has("delete")) {
		const bodyText = await req.text();
		const rootPrefix = getInternalPath("", user || undefined, bucket);
		const deletedKeys: string[] = [];

		let rewrittenBody: string;
		try {
			rewrittenBody = bodyText.replace(/<Key>(.*?)<\/Key>/g, (_match, p1) => {
				const key = String(p1 || "");
				deletedKeys.push(key);
				return `<Key>${getInternalPath(key, user || undefined, bucket)}</Key>`;
			});
		} catch {
			return S3Errors.AccessDenied().toResponse();
		}

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
		if (response.ok) {
			for (const deletedKey of deletedKeys) {
				invalidateObjectCaches(bucket.id, bucket.name, deletedKey);
			}
			if (deletedKeys.length === 0) bumpListCacheVersion(bucket.id);
		}

		return new Response(rewrittenRes, {
			status: response.status,
			headers: { "Content-Type": "application/xml" },
		});
	}

	if (query.has("uploads")) {
		let existingSize = 0;
		if (user && !user.isImmortal) {
			try {
				const before = await s3Client.fetch(
					internalPath,
					{ method: "HEAD" },
					1,
				);
				if (before.ok) {
					existingSize = Number(before.headers.get("content-length") || 0);
				}
			} catch {
				existingSize = 0;
			}
		}

		const response = await s3Client.fetch(
			`${internalPath}?uploads`,
			{
				method: "POST",
				headers: filterUpstreamHeaders(req.headers),
			},
			1,
		);
		const resText = await response.text();
		const rootPrefix = getInternalPath("", user || undefined, bucket);
		if (response.ok && user && !user.isImmortal) {
			try {
				const uploadId = parseS3Xml<{
					InitiateMultipartUploadResult?: { UploadId?: string };
				}>(resText).InitiateMultipartUploadResult?.UploadId;
				if (uploadId) {
					await registerMultipartUploadQuota({
						userId: user.id,
						bucketId: bucket.id,
						uploadId,
						existingSize,
					});
				}
			} catch (error) {
				console.error("Failed to register multipart quota state:", error);
			}
		}
		const rewrittenRes = rewriteMultipartUploadResponse(resText, rootPrefix);

		return new Response(rewrittenRes, {
			status: response.status,
			headers: { "Content-Type": "application/xml" },
		});
	}

	if (query.has("uploadId")) {
		const uploadId = query.get("uploadId");
		if (!uploadId)
			return S3Errors.InvalidRequest("Missing uploadId").toResponse();
		let existingSize = 0;
		try {
			const before = await s3Client.fetch(internalPath, { method: "HEAD" }, 1);
			if (before.ok) {
				existingSize = Number(before.headers.get("content-length") || 0);
			}
		} catch {
			existingSize = 0;
		}

		const uploadQuery = new URLSearchParams();
		uploadQuery.set("uploadId", uploadId);
		const response = await s3Client.fetch(
			`${internalPath}?${uploadQuery.toString()}`,
			{
				method: "POST",
				headers: filterUpstreamHeaders(req.headers),
				body: req.body,
			},
			1,
		);

		const resText = await response.text();
		const rootPrefix = getInternalPath("", user || undefined, bucket);
		const rewrittenRes = rewriteMultipartUploadResponse(resText, rootPrefix);
		if (response.ok) {
			if (user) {
				await clearMultipartQuota({
					userId: user.id,
					bucketId: bucket.id,
					uploadId,
				});
			}
			let finalSize = 0;
			try {
				const after = await s3Client.fetch(internalPath, { method: "HEAD" }, 1);
				if (after.ok) {
					finalSize = Number(after.headers.get("content-length") || 0);
				}
			} catch {
				finalSize = 0;
			}

			const bucketDelta = finalSize - existingSize;
			if (bucketDelta !== 0) {
				await db
					.update(bucketsTable)
					.set({
						totalBytes:
							bucketDelta >= 0
								? sql`${bucketsTable.totalBytes} + ${bucketDelta}`
								: sql`GREATEST(0, ${bucketsTable.totalBytes} - ${Math.abs(bucketDelta)})`,
					})
					.where(eq(bucketsTable.id, bucket.id));
			}
			invalidateObjectCaches(
				bucket.id,
				bucket.name,
				internalPath.slice(rootPrefix.length),
			);
		}

		return new Response(rewrittenRes, {
			status: response.status,
			headers: { "Content-Type": "application/xml" },
		});
	}

	return S3Errors.NotImplemented().toResponse();
}
