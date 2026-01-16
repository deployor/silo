import { eq } from "drizzle-orm";
import { config } from "../../../config";
import { db } from "../../../db";
import { buckets } from "../../../db/schema";
import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import { getCurrentUser } from "../../../lib/session";
import { bucketNameSchema } from "../../../lib/validation";
import { createKey, deleteKey } from "../../../services/key-service";

export async function handleKeys(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	const url = new URL(req.url);
	const path = url.pathname;

	const generateKeyMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/keys$/,
	);
	if (generateKeyMatch && req.method === "POST") {
		const bucketName = generateKeyMatch[1];

		const nameValidation = bucketNameSchema.safeParse(bucketName);
		if (!nameValidation.success) {
			return errorResponse("Invalid bucket name", 400);
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

		if (bucket[0].isCdn)
			return errorResponse("Cannot create keys for CDN bucket", 403);

		try {
			const keys = await createKey(bucket[0].id);
			const publicUrl = `https://${config.s3Domain}/${bucketName}/file.png`;
			return jsonResponse({ ...keys, publicUrl });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			// Key limit is an expected/handled case.
			if (message.includes("Key limit reached"))
				return errorResponse(message, 429);
			return errorResponse(message, 400);
		}
	}

	const deleteKeyMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/keys\/([^/]+)$/,
	);
	if (deleteKeyMatch && req.method === "DELETE") {
		const bucketName = deleteKeyMatch[1];
		const keyId = deleteKeyMatch[2];

		try {
			await deleteKey(keyId, bucketName, user.id, user.isAdmin);
			return jsonResponse({ message: "Deleted" });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return errorResponse(message, 403);
		}
	}

	return errorResponse("Method not allowed", 405);
}
