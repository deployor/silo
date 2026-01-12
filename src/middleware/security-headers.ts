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
		[
			"default-src 'self'",
			"img-src 'self' data: https:",
			// Allow third-party script tags used by our templates.
			// NOTE: We still do NOT allow 'unsafe-eval'; Alpine must use the CSP build.
			"script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net",
			// Allow inline scripts embedded in templates (admin, nav logout tweak, etc).
			// We keep this separate from script-src so we can potentially tighten it later.
			"script-src-elem 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net",
			// Allow CSS loaded via <link rel=\"stylesheet\"> (e.g. phosphor icons CSS from jsdelivr).
			"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
			// Include 'unsafe-inline' here too; style-src-elem can override style-src in some browsers.
			"style-src-elem 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
			// Allow fonts from CDNs used by icon libraries.
			"font-src 'self' data: https://cdn.jsdelivr.net",
		].join("; ") + ";",
	);

	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}
