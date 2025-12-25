import { buckets } from "../../db/schema";
import type { CORSConfiguration, CORSRule } from "./types";

// Simple in-memory cache for parsed CORS configs
// Key: bucket.id + bucket.updatedAt timestamp (to invalidate on updates)
// Value: Parsed CORSConfiguration
const corsCache = new Map<string, CORSConfiguration>();

function getParsedCorsConfig(
	bucket: typeof buckets.$inferSelect,
): CORSConfiguration | null {
	if (!bucket.corsConfig) return null;

	const cacheKey = `${bucket.id}-${bucket.updatedAt?.getTime() || 0}`;
	if (corsCache.has(cacheKey)) {
		return corsCache.get(cacheKey)!;
	}

	try {
		const config = JSON.parse(bucket.corsConfig) as CORSConfiguration;
		// Basic validation
		if (!config || !Array.isArray(config.CORSRules)) {
			return null;
		}
		
		// Prune cache if it gets too big (simple LRU-ish behavior could be added, but this is a quick fix)
		if (corsCache.size > 1000) {
			corsCache.clear();
		}
		
		corsCache.set(cacheKey, config);
		return config;
	} catch (e) {
		console.error("Failed to parse CORS config for bucket", bucket.id, e);
		return null;
	}
}

// Helper to handle CORS preflight
export async function handleCorsPreflight(
	req: Request,
	bucket: typeof buckets.$inferSelect,
) {
	const corsConfig = getParsedCorsConfig(bucket);

	if (!corsConfig) {
		return new Response(null, { status: 403 });
	}

	const origin = req.headers.get("Origin");
	const requestMethod = req.headers.get("Access-Control-Request-Method");
	const requestHeaders = req.headers.get("Access-Control-Request-Headers");

	if (!origin || !requestMethod) {
		return new Response(null, { status: 403 });
	}

	const rule = corsConfig.CORSRules.find((r: CORSRule) => {
		const allowedOrigins = r.AllowedOrigins || [];
		const allowedMethods = r.AllowedMethods || [];

		const originMatch = allowedOrigins.some((o: string) => {
			if (o === "*") return true;
			return o === origin;
		});

		// For preflight, we check if the requested method is allowed
		const methodMatch = allowedMethods.some(
			(m: string) => m === "*" || m === requestMethod,
		);

		return originMatch && methodMatch;
	});

	if (!rule) {
		return new Response(null, { status: 403 });
	}

	const headers = new Headers();
	headers.set("Access-Control-Allow-Origin", origin);

	// Return ALL allowed methods for this rule, not just the requested one
	const allowedMethods = rule.AllowedMethods || [];
	headers.set("Access-Control-Allow-Methods", allowedMethods.join(", "));

	if (rule.AllowedHeaders) {
		const allowedHeaders = rule.AllowedHeaders || [];
		headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
	} else if (requestHeaders) {
		// Default deny if not explicitly allowed
	}

	if (rule.ExposeHeaders) {
		const exposeHeaders = rule.ExposeHeaders || [];
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
		const corsConfig = getParsedCorsConfig(bucket);
		if (corsConfig && Array.isArray(corsConfig.CORSRules)) {
			const rule = corsConfig.CORSRules.find((r: CORSRule) => {
				const allowedOrigins = r.AllowedOrigins || [];
				const allowedMethods = r.AllowedMethods || [];

				const originMatch = allowedOrigins.some(
					(o: string) => o === "*" || o === origin,
				);
				// Check if the method is allowed (exact match or wildcard)
				const methodMatch = allowedMethods.some(
					(m: string) => m === "*" || m === req.method,
				);

				return originMatch && methodMatch;
			});

			if (rule) {
				corsHeaders.set("Access-Control-Allow-Origin", origin);
				if (rule.ExposeHeaders) {
					const exposeHeaders = rule.ExposeHeaders || [];
					corsHeaders.set(
						"Access-Control-Expose-Headers",
						exposeHeaders.join(", "),
					);
				}
				corsHeaders.set("Vary", "Origin");
			}
		}
	}
	return corsHeaders;
}
