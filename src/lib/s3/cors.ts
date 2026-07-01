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

	const rule = config.CORSRules.find((r) => {
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
