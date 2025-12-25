export function jsonResponse(data: any, status = 200): Response {
	return new Response(JSON.stringify(data), {
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
