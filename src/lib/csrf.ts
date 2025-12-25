import { createHmac, randomBytes } from "node:crypto";
import { config } from "../config";

// Generate a CSRF token bound to the session ID
export function generateCsrfToken(sessionId: string): string {
	const secret = config.hcAuth.clientSecret; // Use a server-side secret
	const hmac = createHmac("sha256", secret);
	hmac.update(sessionId);
	return hmac.digest("hex");
}

export async function validateCsrfToken(
	req: Request,
	sessionId: string,
): Promise<boolean> {
	const formData = await req.clone().formData();
	const token = formData.get("csrf_token");

	if (!token || typeof token !== "string") {
		return false;
	}

	const expectedToken = generateCsrfToken(sessionId);
	return token === expectedToken;
}
