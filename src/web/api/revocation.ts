import { config } from "../../config";
import { errorResponse } from "../../lib/api-utils";
import { revocationService } from "../../services/revocation-service";

export async function handleRevocationRequest(req: Request): Promise<Response> {
	if (req.method !== "POST") {
		return errorResponse("Method Not Allowed", 405);
	}

	// 1. Verify Authorization Header
	const authHeader = req.headers.get("Authorization");
	if (!authHeader) {
		return errorResponse("Missing Authorization header", 401);
	}

	const token = authHeader.startsWith("Bearer ")
		? authHeader.replace("Bearer ", "").trim()
		: authHeader.trim();

	// Check against the configured secret
	// If the secret is not configured, we should probably fail safe (deny all)
	if (!config.revocationSecret) {
		console.warn("Revocation secret is not configured. Rejecting request.");
		return errorResponse("Service unavailable", 503);
	}

	if (token !== config.revocationSecret) {
		return errorResponse("Unauthorized", 401);
	}

	// 2. Parse Body
	let body: { accessKey?: string };
	try {
		body = await req.json();
	} catch (_e) {
		return errorResponse("Invalid JSON body", 400);
	}

	const { accessKey } = body;

	if (!accessKey || typeof accessKey !== "string") {
		return errorResponse("Missing 'accessKey' in body", 400);
	}

	// 3. Revoke Key
	try {
		const result = await revocationService.revokeKey(accessKey);

		if (!result) {
			// If key not found, we can return 404.
			// However, for security/privacy, sometimes 200 is preferred even if not found.
			// But for this internal/admin tool, 404 is useful feedback.
			return errorResponse("Key not found", 404);
		}

		return new Response(JSON.stringify(result), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (e) {
		console.error("Revocation error:", e);
		return errorResponse("Internal Server Error", 500);
	}
}
