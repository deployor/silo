export function jsonResponse(responseData: any, status = 200): Response {
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
