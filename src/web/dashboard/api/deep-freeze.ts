import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import { getCurrentUser } from "../../../lib/session";
import { deepFreezeActionSchema } from "../../../lib/validation";
import { requestBucketDeepFreezeAction } from "../../../services/deep-freeze-service";

export async function handleDeepFreeze(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);
	if (req.method !== "POST") return errorResponse("Method not allowed", 405);

	const bucketName = new URL(req.url).pathname.split("/")[4];
	if (!bucketName) return errorResponse("Invalid bucket name", 400);

	if (user.dataExported) {
		return errorResponse(
			"Account is frozen. Deep Freeze actions are not available.",
			403,
		);
	}

	try {
		const body = await req.json();
		const parsed = deepFreezeActionSchema.safeParse(body);
		if (!parsed.success) {
			return errorResponse(
				parsed.error.issues[0]?.message || "Invalid request",
				400,
			);
		}

		const snapshot = await requestBucketDeepFreezeAction({
			bucketName,
			userId: user.id,
			action: parsed.data.action,
			isAdmin: user.isAdmin,
		});

		return jsonResponse({
			message:
				parsed.data.action === "freeze"
					? "Deep Freeze started"
					: "Bucket restore started",
			deepFreeze: snapshot,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Internal Error";
		return errorResponse(message, 500);
	}
}
