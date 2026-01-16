import { config } from "../../../config";
import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import { getCurrentUser } from "../../../lib/session";
import {
	createBucketSchema,
	updateBucketVisibilitySchema,
} from "../../../lib/validation";
import {
	createBucket,
	deleteBucket,
	emptyBucket,
	updateBucketVisibility,
} from "../../../services/bucket-service";
import { createKey } from "../../../services/key-service";

export async function handleBuckets(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	if (req.method === "POST") {
		try {
			const body = await req.json();
			const result = createBucketSchema.safeParse(body);

			if (!result.success) {
				return errorResponse(result.error.issues[0].message, 400);
			}

			const { name: bucketName } = result.data;

			const newBucket = await createBucket(user.id, bucketName);
			const keys = await createKey(newBucket.id);

			const publicUrl = `https://${config.s3Domain}/${bucketName}/file.png`;

			return jsonResponse({ ...keys, publicUrl });
		} catch (e: unknown) {
			console.error(e);
			const message = e instanceof Error ? e.message : "Internal Error";
			return errorResponse(message, 500);
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

	// NOTE: Dashboard UI sends:
	// - DELETE /api/dashboard/buckets/:name           => delete bucket
	// - DELETE /api/dashboard/buckets/:name?empty=true => empty bucket (delete all files only)
	if (req.method === "DELETE") {
		const isEmpty = url.searchParams.get("empty") === "true";

		try {
			if (isEmpty) {
				await emptyBucket(bucketName, user.id, user.isAdmin);
				return jsonResponse({ message: "Emptied" });
			}

			await deleteBucket(bucketName, user.id, user.isAdmin);
			return jsonResponse({ message: "Deleted" });
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : "Internal Error";
			return errorResponse(message, 500);
		}
	}

	if (req.method === "PATCH") {
		try {
			const body = await req.json();
			const result = updateBucketVisibilitySchema.safeParse(body);

			if (!result.success) {
				return errorResponse(result.error.issues[0].message, 400);
			}

			const { isPublic } = result.data;

			await updateBucketVisibility(bucketName, user.id, isPublic, user.isAdmin);
			return jsonResponse({ message: "Updated" });
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : "Internal Error";
			return errorResponse(message, 500);
		}
	}

	return errorResponse("Method not allowed", 405);
}
