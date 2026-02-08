import { eq } from "drizzle-orm";
import { db } from "../../db";
import { buckets } from "../../db/schema";
import { redis } from "../../lib/redis";
import { s3Client } from "../../lib/s3-client";
import { S3Errors } from "../../lib/s3-errors";
import { filterUpstreamHeaders, stripAuthQueryParams } from "./utils";

export async function handleDeleteRequest(
	req: Request,
	bucket: typeof buckets.$inferSelect,
	internalPath: string,
	url: URL,
	key: string,
) {
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

		if (response.ok || response.status === 204 || response.status === 404) {
			// Invalidate caches
			try {
				const keys = [
					`s3:body:${bucket.name}:${key}`,
					`s3:meta:${bucket.name}:${key}`,
				];
				
				// Same eventual consistency pattern as PUT
				const stream = redis.scanStream({
					match: `s3:list:${bucket.name}:*`,
					count: 100
				});
				
				stream.on('data', (keys) => {
					if (keys.length) {
						redis.del(keys);
					}
				});

				await redis.del(keys);
			} catch (e) {
				console.error("Cache invalidation error:", e);
			}
		}

		return new Response(response.body, {
			status: response.status,
			headers: response.headers,
		});
	} catch (_e) {
		return S3Errors.InternalError().toResponse();
	}
}
