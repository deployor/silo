export function securityHeaders(req: Request, res: Response): Response {
	const headers = new Headers(res.headers);

	// HSTS - Force HTTPS
	headers.set(
		"Strict-Transport-Security",
		"max-age=31536000; includeSubDomains",
	);

	// Prevent MIME type sniffing
	headers.set("X-Content-Type-Options", "nosniff");

	// Prevent clickjacking (allow same origin for iframes if needed, or deny)
	headers.set("X-Frame-Options", "SAMEORIGIN");

	// XSS Protection (Legacy browsers)
	headers.set("X-XSS-Protection", "1; mode=block");

	// Referrer Policy
	headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

	// Content Security Policy (CSP)
	// This is a strict baseline. We might need to adjust for scripts/styles.
	// Allowing 'self' and 'unsafe-inline' for styles (Tailwind/common) and scripts (if needed).
	// For a production app, we should ideally use nonces or hashes.
	// We also allow data: images for the dashboard.
	headers.set(
		"Content-Security-Policy",
		"default-src 'self'; img-src 'self' data: https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:;",
	);

	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}
