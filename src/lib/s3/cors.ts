import type { buckets } from "../../db/schema";
import type { CORSConfiguration, CORSRule } from "./protocol";

export const DEFAULT_CORS_RULES: CORSRule[] = [
	{
		AllowedOrigins: ["*"],
		AllowedMethods: ["GET", "HEAD", "PUT", "POST", "DELETE"],
		AllowedHeaders: ["*"],
		ExposeHeaders: ["*"],
		MaxAgeSeconds: 86400,
	},
];

export function buildCorsConfig(
	rules: CORSRule[] = DEFAULT_CORS_RULES,
): CORSConfiguration {
	return { CORSRules: rules };
}

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

function setAllowOrigin(headers: Headers, origin: string, rule: CORSRule) {
	if (rule.AllowedOrigins.includes("*") && rule.AllowedOrigins.length === 1) {
		headers.set("Access-Control-Allow-Origin", "*");
		return;
	}
	headers.set("Access-Control-Allow-Origin", origin);
}

export function getCorsHeaders(
	req: Request,
	bucket: typeof buckets.$inferSelect,
): Headers {
	const origin = req.headers.get("Origin");
	const corsHeaders = new Headers();
	if (!origin) return corsHeaders;

	const parsed = parseCorsConfig(bucket.corsConfig);
	const config = parsed.ok ? parsed.config : buildCorsConfig();

	const requestedMethod =
		req.method === "OPTIONS"
			? req.headers.get("Access-Control-Request-Method") || ""
			: req.method;

	const rule = config.CORSRules.find((r) => {
		const originMatch = matchExactOrWildcard(origin, r.AllowedOrigins);
		const methodMatch = matchExactOrWildcard(
			requestedMethod,
			r.AllowedMethods,
		);
		return originMatch && methodMatch;
	});

	if (!rule) return corsHeaders;

	setAllowOrigin(corsHeaders, origin, rule);

	if (req.method === "OPTIONS") {
		corsHeaders.set(
			"Access-Control-Allow-Methods",
			rule.AllowedMethods.join(", "),
		);
		const requestedHeaders = req.headers.get(
			"Access-Control-Request-Headers",
		);
		if (requestedHeaders) {
			corsHeaders.set("Access-Control-Allow-Headers", requestedHeaders);
		} else if (rule.AllowedHeaders?.length) {
			corsHeaders.set(
				"Access-Control-Allow-Headers",
				rule.AllowedHeaders.join(", "),
			);
		}
		if (rule.MaxAgeSeconds !== undefined) {
			corsHeaders.set(
				"Access-Control-Max-Age",
				String(rule.MaxAgeSeconds),
			);
		}
	}

	if (rule.ExposeHeaders && rule.ExposeHeaders.length > 0) {
		corsHeaders.set(
			"Access-Control-Expose-Headers",
			rule.ExposeHeaders.join(", "),
		);
	}

	corsHeaders.set("Vary", "Origin");
	return corsHeaders;
}
