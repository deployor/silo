import { buckets } from "../../db/schema";

// Helper to handle CORS preflight
export async function handleCorsPreflight(
	req: Request,
	bucket: typeof buckets.$inferSelect,
) {
	const corsConfig = bucket.corsConfig ? JSON.parse(bucket.corsConfig) : null;

	if (!corsConfig || !Array.isArray(corsConfig.CORSRules)) {
		return new Response(null, { status: 403 });
	}

	const origin = req.headers.get("Origin");
	const requestMethod = req.headers.get("Access-Control-Request-Method");
	const requestHeaders = req.headers.get("Access-Control-Request-Headers");

	if (!origin || !requestMethod) {
		return new Response(null, { status: 403 });
	}

	const rule = corsConfig.CORSRules.find((r: any) => {
		const allowedOrigins = Array.isArray(r.AllowedOrigins)
			? r.AllowedOrigins
			: [r.AllowedOrigins];
		const allowedMethods = Array.isArray(r.AllowedMethods)
			? r.AllowedMethods
			: [r.AllowedMethods];

		const originMatch = allowedOrigins.some((o: string) => {
			if (o === "*") return true;
			return o === origin;
		});

		const methodMatch = allowedMethods.includes(requestMethod);

		return originMatch && methodMatch;
	});

	if (!rule) {
		return new Response(null, { status: 403 });
	}

	const headers = new Headers();
	headers.set("Access-Control-Allow-Origin", origin);
	headers.set("Access-Control-Allow-Methods", requestMethod);

	if (rule.AllowedHeaders) {
		const allowedHeaders = Array.isArray(rule.AllowedHeaders)
			? rule.AllowedHeaders
			: [rule.AllowedHeaders];
		headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
	} else if (requestHeaders) {
		// Default deny if not explicitly allowed
	}

	if (rule.ExposeHeaders) {
		const exposeHeaders = Array.isArray(rule.ExposeHeaders)
			? rule.ExposeHeaders
			: [rule.ExposeHeaders];
		headers.set("Access-Control-Expose-Headers", exposeHeaders.join(", "));
	}

	if (rule.MaxAgeSeconds) {
		headers.set("Access-Control-Max-Age", rule.MaxAgeSeconds.toString());
	}

	headers.set(
		"Vary",
		"Origin, Access-Control-Request-Headers, Access-Control-Request-Method",
	);

	return new Response(null, { status: 200, headers });
}

// Helper to get CORS headers for a request
export function getCorsHeaders(
	req: Request,
	bucket: typeof buckets.$inferSelect,
): Headers {
	const origin = req.headers.get("Origin");
	const corsHeaders = new Headers();

	if (origin && bucket.corsConfig) {
		try {
			const corsConfig = JSON.parse(bucket.corsConfig);
			if (Array.isArray(corsConfig.CORSRules)) {
				const rule = corsConfig.CORSRules.find((r: any) => {
					const allowedOrigins = Array.isArray(r.AllowedOrigins)
						? r.AllowedOrigins
						: [r.AllowedOrigins];
					const allowedMethods = Array.isArray(r.AllowedMethods)
						? r.AllowedMethods
						: [r.AllowedMethods];

					const originMatch = allowedOrigins.some(
						(o: string) => o === "*" || o === origin,
					);
					const methodMatch = allowedMethods.includes(req.method);

					return originMatch && methodMatch;
				});

				if (rule) {
					corsHeaders.set("Access-Control-Allow-Origin", origin);
					if (rule.ExposeHeaders) {
						const exposeHeaders = Array.isArray(rule.ExposeHeaders)
							? rule.ExposeHeaders
							: [rule.ExposeHeaders];
						corsHeaders.set(
							"Access-Control-Expose-Headers",
							exposeHeaders.join(", "),
						);
					}
					corsHeaders.set("Vary", "Origin");
				}
			}
		} catch (e) {
			console.error("Failed to parse CORS config", e);
		}
	}
	return corsHeaders;
}
