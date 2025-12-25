import { KeyService } from "../../../services/key-service";
import { getCurrentUser } from "../../../lib/session";
import { config } from "../../../config";
import { db } from "../../../db";
import { buckets } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { jsonResponse, errorResponse } from "../../../lib/api-utils";
import { validateOrigin } from "../../../lib/security";

export async function handleKeys(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	const url = new URL(req.url);
	const path = url.pathname;
	
    // /api/dashboard/buckets/:name/keys
    const generateKeyMatch = path.match(/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/keys$/);
    if (generateKeyMatch && req.method === "POST") {
        if (!validateOrigin(req)) return errorResponse("Invalid Origin", 403);

        const bucketName = generateKeyMatch[1];
        const bucket = await db
            .select()
            .from(buckets)
            .where(eq(buckets.name, bucketName))
            .limit(1);

        if (bucket.length === 0)
            return errorResponse("Bucket not found", 404);
        if (bucket[0].userId !== user.id && !user.isAdmin)
            return errorResponse("Unauthorized", 403);
        if (bucket[0].isPaused && !user.isAdmin)
            return errorResponse("Bucket is paused", 403);

        if (bucket[0].isCdn)
            return errorResponse("Cannot create keys for CDN bucket", 403);

        const keys = await KeyService.createKey(bucket[0].id);
        const publicUrl = `https://${config.s3Domain}/${bucketName}/file.png`;

        return jsonResponse({ ...keys, publicUrl });
    }

    // /api/dashboard/buckets/:name/keys/:keyId
    const deleteKeyMatch = path.match(/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/keys\/([^/]+)$/);
    if (deleteKeyMatch && req.method === "DELETE") {
        if (!validateOrigin(req)) return errorResponse("Invalid Origin", 403);

        const bucketName = deleteKeyMatch[1];
        const keyId = deleteKeyMatch[2];

        try {
            await KeyService.deleteKey(keyId, bucketName, user.id, user.isAdmin);
            return jsonResponse({ message: "Deleted" });
        } catch (e: any) {
            return errorResponse(e.message, 403);
        }
    }

	return errorResponse("Method not allowed", 405);
}
