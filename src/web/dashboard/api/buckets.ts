import { BucketService } from "../../../services/bucket-service";
import { KeyService } from "../../../services/key-service";
import { getCurrentUser } from "../../../lib/session";
import { config } from "../../../config";
import { jsonResponse, errorResponse } from "../../../lib/api-utils";
import { validateCsrfToken } from "../../../lib/csrf";

export async function handleBuckets(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	if (req.method === "POST") {
		const isValidCsrf = await validateCsrfToken(req, user.sessionId);
		if (!isValidCsrf) return errorResponse("Invalid CSRF Token", 403);

		try {
			const body = await req.json();
			const name = body.name;

			const newBucket = await BucketService.createBucket(user.id, name);
			const keys = await KeyService.createKey(newBucket.id);

			const publicUrl = `https://${config.s3Domain}/${name}/file.png`;

			return jsonResponse({ ...keys, publicUrl });
		} catch (e: any) {
			console.error(e);
			return errorResponse(e.message || "Internal Error", 500);
		}
	}

	return errorResponse("Method not allowed", 405);
}

export async function handleBucketOperations(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	const url = new URL(req.url);
	const path = url.pathname;
	const bucketName = path.split("/")[4]; // /api/dashboard/buckets/:name

	if (!bucketName) return errorResponse("Invalid bucket name", 400);

	if (req.method === "DELETE") {
		const isValidCsrf = await validateCsrfToken(req, user.sessionId);
		if (!isValidCsrf) return errorResponse("Invalid CSRF Token", 403);

		try {
			await BucketService.deleteBucket(bucketName, user.id, user.isAdmin);
			return jsonResponse({ message: "Deleted" });
		} catch (e: any) {
			return errorResponse(e.message, 500);
		}
	}

	if (req.method === "PATCH") {
		const isValidCsrf = await validateCsrfToken(req, user.sessionId);
		if (!isValidCsrf) return errorResponse("Invalid CSRF Token", 403);

		try {
			const body = await req.json();
			if (typeof body.isPublic === "boolean") {
				await BucketService.updateBucketVisibility(
					bucketName,
					user.id,
					body.isPublic,
					user.isAdmin,
				);
				return jsonResponse({ message: "Updated" });
			}
			return errorResponse("Invalid body", 400);
		} catch (e: any) {
			return errorResponse(e.message || "Internal Error", 500);
		}
	}

	return errorResponse("Method not allowed", 405);
}
