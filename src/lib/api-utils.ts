export function jsonResponse(responseData: unknown, status = 200): Response {
	return new Response(JSON.stringify(responseData), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function errorResponse(
	message: string,
	status = 500,
	headers?: Headers,
): Response {
	const response = jsonResponse({ error: message }, status);
	if (headers) {
		headers.forEach((value, key) => {
			response.headers.set(key, value);
		});
	}
	return response;
}

export function getClientIp(req: Request): string {
	const forwarded = req.headers.get("x-forwarded-for");
	if (forwarded) {
		return forwarded.split(",")[0].trim();
	}
	return "unknown"; // In a real environment, we'd rely on the platform to provide this reliably
}

export function parseCookies(header: string | null): Record<string, string> {
	if (!header) return {};
	return header.split(";").reduce(
		(acc, cookie) => {
			const [key, ...v] = cookie.trim().split("=");
			if (key && v.length > 0) {
				acc[key] = decodeURIComponent(v.join("="));
			}
			return acc;
		},
		{} as Record<string, string>,
	);
}
