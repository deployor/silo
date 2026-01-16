import type { buckets } from "../../db/schema";
import type { CORSConfiguration, CORSRule } from "./types";

type CorsParseResult =
	| { ok: true; config: CORSConfiguration }
	| { ok: false; error: string };

function parseCorsConfig(corsConfigJson: string | null): CorsParseResult {
	if (!corsConfigJson) return { ok: false, error: "missing" };
	try {
		const parsed = JSON.parse(corsConfigJson) as unknown;
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!("CORSRules" in parsed) ||
			!Array.isArray((parsed as { CORSRules?: unknown }).CORSRules)
		) {
			return { ok: false, error: "invalid" };
		}
		return { ok: true, config: parsed as CORSConfiguration };
	} catch {
		return { ok: false, error: "invalid_json" };
	}
}

function matchExactOrWildcard(
	value: string,
	allowed: readonly string[],
): boolean {
	return allowed.some((a) => a === "*" || a === value);
}

function matchHeaders(
	requestHeaders: string | null,
	allowedHeaders: string[] | undefined,
): boolean {
	if (!requestHeaders) return true; // No headers requested, so it's fine
	if (!allowedHeaders) return false; // Headers requested but none allowed

	const requested = requestHeaders
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean)
		.map((h) => h.toLowerCase());
	const allowed = allowedHeaders.map((h) => h.toLowerCase());

	return requested.every((reqHeader) =>
		matchExactOrWildcard(reqHeader, allowed),
	);
}

function varyForCorsPreflight(headers: Headers) {
	headers.set(
		"Vary",
		"Origin, Access-Control-Request-Headers, Access-Control-Request-Method",
	);
}

function setAllowOrigin(headers: Headers, origin: string, rule: CORSRule) {
	// If AllowedOrigins is exactly "*" then allow any origin.
	// Otherwise echo the Request Origin.
	if (rule.AllowedOrigins.includes("*") && rule.AllowedOrigins.length === 1) {
		headers.set("Access-Control-Allow-Origin", "*");
		return;
	}
	headers.set("Access-Control-Allow-Origin", origin);
}

function findPreflightRule(params: {
	origin: string;
	requestMethod: string;
	requestHeaders: string | null;
	rules: CORSRule[];
}): CORSRule | undefined {
	const { origin, requestMethod, requestHeaders, rules } = params;
	return rules.find((r) => {
		const originMatch = matchExactOrWildcard(origin, r.AllowedOrigins);
		const methodMatch = matchExactOrWildcard(requestMethod, r.AllowedMethods);
		const headerMatch = matchHeaders(requestHeaders, r.AllowedHeaders);
		return originMatch && methodMatch && headerMatch;
	});
}

export async function handleCorsPreflight(
	req: Request,
	bucket: typeof buckets.$inferSelect,
) {
	const parsed = parseCorsConfig(bucket.corsConfig);
	if (!parsed.ok) return new Response(null, { status: 403 });

	const origin = req.headers.get("Origin");
	const requestMethod = req.headers.get("Access-Control-Request-Method");
	const requestHeaders = req.headers.get("Access-Control-Request-Headers");

	if (!origin || !requestMethod) return new Response(null, { status: 403 });

	const rule = findPreflightRule({
		origin,
		requestMethod,
		requestHeaders,
		rules: parsed.config.CORSRules,
	});
	if (!rule) return new Response(null, { status: 403 });

	const headers = new Headers();
	setAllowOrigin(headers, origin, rule);

	headers.set("Access-Control-Allow-Methods", rule.AllowedMethods.join(", "));

	if (rule.AllowedHeaders && rule.AllowedHeaders.length > 0) {
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

	varyForCorsPreflight(headers);
	return new Response(null, { status: 200, headers });
}

export function getCorsHeaders(
	req: Request,
	bucket: typeof buckets.$inferSelect,
): Headers {
	const origin = req.headers.get("Origin");
	const corsHeaders = new Headers();
	if (!origin) return corsHeaders;

	const parsed = parseCorsConfig(bucket.corsConfig);
	if (!parsed.ok) return corsHeaders;

	const rule = parsed.config.CORSRules.find((r) => {
		const originMatch = matchExactOrWildcard(origin, r.AllowedOrigins);
		const methodMatch = matchExactOrWildcard(req.method, r.AllowedMethods);
		return originMatch && methodMatch;
	});

	if (!rule) return corsHeaders;

	setAllowOrigin(corsHeaders, origin, rule);

	if (rule.ExposeHeaders && rule.ExposeHeaders.length > 0) {
		corsHeaders.set(
			"Access-Control-Expose-Headers",
			rule.ExposeHeaders.join(", "),
		);
	}

	corsHeaders.set("Vary", "Origin");
	return corsHeaders;
}
