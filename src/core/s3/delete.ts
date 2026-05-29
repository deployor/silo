import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { buckets, type users } from "../../db/schema";
import { releaseMultipartQuota } from "../../lib/quota-cache";
import { s3Client } from "../../lib/s3-client";
import { S3Errors } from "../../lib/s3-errors";
import { buildCorsConfig } from "./cors";
import {
	filterUpstreamHeaders,
	invalidateObjectCaches,
	stripAuthQueryParams,
} from "./utils";

export async function handleDeleteRequest(
	req: Request,
	user: typeof users.$inferSelect,
	bucket: typeof buckets.$inferSelect,
	internalPath: string,
	url: URL,
	key: string,
) {
	if (key === "" && url.searchParams.has("cors")) {
		await db
			.update(buckets)
			.set({ corsConfig: JSON.stringify(buildCorsConfig()) })
			.where(eq(buckets.id, bucket.id));

		return new Response(null, { status: 204 });
	}

	try {
		const isAbortMultipartUpload =
			key !== "" && url.searchParams.has("uploadId");
		let existingSize = 0;
		try {
			if (isAbortMultipartUpload)
				throw new Error("skip HEAD for multipart abort");
			const headResponse = await s3Client.fetch(internalPath, {
				method: "HEAD",
			});
			if (headResponse.ok) {
				existingSize = Number(headResponse.headers.get("content-length") || 0);
			}
		} catch {
			existingSize = 0;
		}

		const cleanUrl = stripAuthQueryParams(url);
		const queryStr = cleanUrl.searchParams.toString();
		const pathWithQuery = queryStr
			? `${internalPath}?${queryStr}`
			: internalPath;

		const response = await s3Client.fetch(pathWithQuery, {
			method: "DELETE",
			headers: filterUpstreamHeaders(req.headers),
		});

		if (response.ok || response.status === 204 || response.status === 404) {
			if (isAbortMultipartUpload) {
				const uploadId = url.searchParams.get("uploadId");
				if (uploadId) {
					await releaseMultipartQuota({
						userId: user.id,
						bucketId: bucket.id,
						uploadId,
					});
				}
			}

			if (existingSize > 0 && response.status !== 404) {
				await db
					.update(buckets)
					.set({
						totalBytes: sql`GREATEST(0, ${buckets.totalBytes} - ${existingSize})`,
					})
					.where(eq(buckets.id, bucket.id));
			}

			invalidateObjectCaches(bucket.id, bucket.name, key);
		}

		return new Response(response.body, {
			status: response.status,
			headers: response.headers,
		});
	} catch (_e) {
		return S3Errors.InternalError().toResponse();
	}
}
