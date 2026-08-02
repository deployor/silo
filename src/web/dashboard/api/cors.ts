import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import { getCurrentUser } from "../../../lib/session";
import { updateCorsSchema } from "../../../lib/validation";
import {
	type CorsRule,
	deleteCorsConfig,
	updateCorsConfig,
} from "../../../services/bucket-service";

export async function handleCors(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	const url = new URL(req.url);
	const path = url.pathname;

	const corsMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/cors$/,
	);
	if (corsMatch) {
		const bucketName = corsMatch[1];

		if (req.method === "PUT") {
			try {
				const body = await req.json();
				const result = updateCorsSchema.safeParse(body);

				if (!result.success) {
					return errorResponse(result.error.issues[0].message, 400);
				}

				const corsRules = result.data.rules as CorsRule[];

				await updateCorsConfig(bucketName, user.id, corsRules, user.isAdmin);

				return jsonResponse({ message: "Updated" });
			} catch (e) {
				const message = e instanceof Error ? e.message : "Invalid JSON";
				return errorResponse(message, 400);
			}
		}

		if (req.method === "DELETE") {
			try {
				await deleteCorsConfig(bucketName, user.id, user.isAdmin);
				return jsonResponse({ message: "Deleted" });
			} catch (e) {
				const message = e instanceof Error ? e.message : "Unknown error";
				return errorResponse(message, 403);
			}
		}
	}

	return errorResponse("Method not allowed", 405);
}
