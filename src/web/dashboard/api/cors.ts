import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import { getCurrentUser } from "../../../lib/session";
import { BucketService } from "../../../services/bucket-service";

export async function handleCors(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	const url = new URL(req.url);
	const path = url.pathname;

	// /api/dashboard/buckets/:name/cors
	const corsMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/cors$/,
	);
	if (corsMatch) {
		const bucketName = corsMatch[1];

		if (req.method === "PUT") {
			try {
				const body = await req.json();
				const rules = body.rules;

				if (!Array.isArray(rules)) {
					return errorResponse("Invalid rules format", 400);
				}

				await BucketService.updateCorsConfig(
					bucketName,
					user.id,
					rules,
					user.isAdmin,
				);

				return jsonResponse({ message: "Updated" });
			} catch (e: any) {
				return errorResponse(e.message || "Invalid JSON", 400);
			}
		}

		if (req.method === "DELETE") {
			try {
				await BucketService.deleteCorsConfig(bucketName, user.id, user.isAdmin);
				return jsonResponse({ message: "Deleted" });
			} catch (e: any) {
				return errorResponse(e.message, 403);
			}
		}
	}

	return errorResponse("Method not allowed", 405);
}
