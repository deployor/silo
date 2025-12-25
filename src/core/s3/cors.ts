import { buckets } from "../../db/schema";
import type { CORSConfiguration, CORSRule } from "./types";

// Helper to match origin against allowed origins (supports wildcards)
function matchOrigin(origin: string, allowedOrigins: string[]): boolean {
	return allowedOrigins.some((allowed) => {
		if (allowed === "*") return true;
		return allowed === origin;
	});
}

// Helper to match method against allowed methods
function matchMethod(method: string, allowedMethods: string[]): boolean {
	return allowedMethods.some((allowed) => {
		if (allowed === "*") return true;
		return allowed === method;
	});
}

// Helper to match headers against allowed headers
function matchHeaders(
	requestHeaders: string | null,
	allowedHeaders: string[] | undefined,
): boolean {
	if (!requestHeaders) return true; // No headers requested, so it's fine
	if (!allowedHeaders) return false; // Headers requested but none allowed

	const requested = requestHeaders
		.split(",")
		.map((h) => h.trim().toLowerCase());
	const allowed = allowedHeaders.map((h) => h.toLowerCase());

	return requested.every((reqHeader) => {
		return allowed.some((allowedHeader) => {
			if (allowedHeader === "*") return true;
			return allowedHeader === reqHeader;
		});
	});
}

// Helper to handle CORS preflight
export async function handleCorsPreflight(
	req: Request,
	bucket: typeof buckets.$inferSelect,
) {
	const corsConfig = bucket.corsConfig
		? (JSON.parse(bucket.corsConfig) as CORSConfiguration)
		: null;

	if (!corsConfig || !Array.isArray(corsConfig.CORSRules)) {
		return new Response(null, { status: 403 });
	}

	const origin = req.headers.get("Origin");
	const requestMethod = req.headers.get("Access-Control-Request-Method");
	const requestHeaders = req.headers.get("Access-Control-Request-Headers");

	if (!origin || !requestMethod) {
		return new Response(null, { status: 403 });
	}

	// Find the first matching rule
	const rule = corsConfig.CORSRules.find((r) => {
		const originMatch = matchOrigin(origin, r.AllowedOrigins);
		const methodMatch = matchMethod(requestMethod, r.AllowedMethods);
		const headerMatch = matchHeaders(requestHeaders, r.AllowedHeaders);

		return originMatch && methodMatch && headerMatch;
	});

	if (!rule) {
		return new Response(null, { status: 403 });
	}

	const headers = new Headers();
	// S3 returns the specific origin, or "*" if the rule allows "*" and the client didn't send credentials
	// But typically for S3, it echoes the origin if it matches.
	// If AllowedOrigins contains "*", we can return "*" OR the origin.
	// Safest is to return the Origin if it matches.
	headers.set("Access-Control-Allow-Origin", origin);

	headers.set("Access-Control-Allow-Methods", rule.AllowedMethods.join(", "));

	if (rule.AllowedHeaders && rule.AllowedHeaders.length > 0) {
		// If the rule has wildcards, we might want to echo the requested headers
		// But standard S3 often returns the allowed headers list.
		// However, if the request had Access-Control-Request-Headers, we should probably return what was requested if allowed.
		// For simplicity and compatibility, let's return the allowed headers from the rule, or if it's *, return requested.
		if (rule.AllowedHeaders.includes("*") && requestHeaders) {
			headers.set("Access-Control-Allow-Headers", requestHeaders);
		} else {
			headers.set(
				"Access-Control-Allow-Headers",
				rule.AllowedHeaders.join(", "),
			);
		}
	}

	if (rule.ExposeHeaders && rule.ExposeHeaders.length > 0) {
		headers.set("Access-Control-Expose-Headers", rule.ExposeHeaders.join(", "));
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
			const corsConfig = JSON.parse(bucket.corsConfig) as CORSConfiguration;
			if (Array.isArray(corsConfig.CORSRules)) {
				const rule = corsConfig.CORSRules.find((r) => {
					const originMatch = matchOrigin(origin, r.AllowedOrigins);
					// For actual requests, we check the method of the request itself
					const methodMatch = matchMethod(req.method, r.AllowedMethods);
					return originMatch && methodMatch;
				});

				if (rule) {
					corsHeaders.set("Access-Control-Allow-Origin", origin);
					if (rule.ExposeHeaders && rule.ExposeHeaders.length > 0) {
						corsHeaders.set(
							"Access-Control-Expose-Headers",
							rule.ExposeHeaders.join(", "),
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
