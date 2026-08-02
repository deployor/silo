import { readFileSync } from "node:fs";
import { z } from "zod";
import {
	isStorageRegionId,
	STORAGE_REGIONS,
	type StorageRegionId,
} from "./lib/regions";

const envSchema = z.object({
	S3_DOMAIN: z.string().default("localhost:3000"),
	DASHBOARD_DOMAIN: z.string().optional(),
	DASHBOARD_ORIGIN_DOMAINS: z.string().optional(),
	DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
	S3_REGION: z.string().default("auto"),
	DEEP_FREEZE_STORAGE_PREFIX: z.string().default("deep-freeze"),
	REDIS_URL: z.string().default("redis://localhost:6379"),
	HC_AUTH_CLIENT_ID: z.string().min(1, "HC_AUTH_CLIENT_ID is required"),
	HC_AUTH_CLIENT_SECRET: z.string().min(1, "HC_AUTH_CLIENT_SECRET is required"),
	HC_AUTH_REDIRECT_URI: z.string().min(1, "HC_AUTH_REDIRECT_URI is required"),
	OFFBOARDING_EXPORT_DERIVATION_SECRET: z.string().min(24).optional(),
	SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
	SLACK_SIGNING_SECRET: z.string().min(1, "SLACK_SIGNING_SECRET is required"),
	SLACK_FILE_UPLOAD_CHANNEL_ID: z.string().optional(),
	REVOCATION_SECRET: z.string().optional(),
	DOMAINS: z.string().optional(),
	DEEP_FREEZE: z.string().optional(),
	CF_API_TOKEN: z.string().optional(),
	CF_ZONE_ID: z.string().optional(),
	CF_SAAS_FALLBACK_ORIGIN: z.string().optional(),
	CF_SAAS_TARGET: z.string().optional(),
	CF_SAAS_MIN_TLS: z.string().optional(),
	DATAPLANE_INTERNAL_SECRET: z.string().min(32).optional(),
	DATAPLANE_URL: z.string().optional(),
	DATAPLANE_REGION_URLS_JSON: z.string().optional(),
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
	GIT_COMMIT_SHA: z.string().optional(),
	GIT_COMMIT_DATE: z.string().optional(),
	BUCKET_USAGE_RECONCILE_INTERVAL_MS: z.string().optional(),
	CUSTOM_DOMAIN_REVALIDATE_INTERVAL_MS: z.string().optional(),
});

const env = envSchema.parse(process.env);
if (env.NODE_ENV === "production" && !env.DATAPLANE_INTERNAL_SECRET) {
	throw new Error("DATAPLANE_INTERNAL_SECRET is required in production");
}
if (
	env.NODE_ENV === "production" &&
	!env.OFFBOARDING_EXPORT_DERIVATION_SECRET
) {
	throw new Error(
		"OFFBOARDING_EXPORT_DERIVATION_SECRET (at least 24 characters) is required in production",
	);
}

function parseDataplaneRegionUrls(raw: string | undefined) {
	if (!raw) return {} as Partial<Record<StorageRegionId, string>>;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		throw new Error("DATAPLANE_REGION_URLS_JSON must be valid JSON");
	}
	const parsed = z.record(z.string(), z.string().url()).parse(json);
	const urls: Partial<Record<StorageRegionId, string>> = {};
	for (const [regionId, value] of Object.entries(parsed)) {
		if (!isStorageRegionId(regionId)) {
			throw new Error(`Unknown dataplane region URL: ${regionId}`);
		}
		const url = new URL(value);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(url.pathname !== "/" && url.pathname !== "")
		) {
			throw new Error(
				`Dataplane region URL must be an origin without credentials, path, query, or fragment: ${regionId}`,
			);
		}
		if (env.NODE_ENV === "production" && url.protocol !== "https:") {
			throw new Error(`Production dataplane URL must use HTTPS: ${regionId}`);
		}
		urls[regionId] = url.origin;
	}
	return urls;
}

const configuredDataplaneUrls = parseDataplaneRegionUrls(
	env.DATAPLANE_REGION_URLS_JSON,
);
const defaultDataplaneUrl = (
	env.DATAPLANE_URL || "http://127.0.0.1:3001"
).replace(/\/+$/, "");
const missingDataplaneRegionUrls = STORAGE_REGIONS.filter(
	(region) => !configuredDataplaneUrls[region.id],
).map((region) => region.id);
if (env.NODE_ENV === "production" && missingDataplaneRegionUrls.length > 0) {
	throw new Error(
		`DATAPLANE_REGION_URLS_JSON must explicitly configure every storage region in production (missing: ${missingDataplaneRegionUrls.join(", ")})`,
	);
}
const dataplaneRegionUrls = Object.fromEntries(
	STORAGE_REGIONS.map((region) => [
		region.id,
		configuredDataplaneUrls[region.id] || defaultDataplaneUrl,
	]),
) as Record<StorageRegionId, string>;
const dashboardDomain =
	env.DASHBOARD_DOMAIN ||
	(env.S3_DOMAIN === "localhost:3000"
		? env.S3_DOMAIN
		: `dash.${env.S3_DOMAIN}`);

let gitSha = env.GIT_COMMIT_SHA;
let gitDate = env.GIT_COMMIT_DATE;
let gitMessage: string | undefined;
let buildDate: string | undefined;

function knownGitValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed === "unknown") return undefined;
	return trimmed;
}

if (!knownGitValue(gitSha) || !knownGitValue(gitDate)) {
	// 1. Try file first (production build artifact)
	try {
		const gitInfo = JSON.parse(readFileSync("src/git-info.json", "utf-8"));
		if (!knownGitValue(gitSha)) gitSha = knownGitValue(gitInfo.sha);
		if (!knownGitValue(gitDate)) gitDate = knownGitValue(gitInfo.date);
		gitMessage = knownGitValue(gitInfo.message);
		buildDate = knownGitValue(gitInfo.buildDate);
	} catch {
		// 2. If file fails (local dev), try git command directly
		try {
			if (!knownGitValue(gitSha)) {
				const shaProc = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
				if (shaProc.success) gitSha = knownGitValue(shaProc.stdout.toString());
			}

			if (!knownGitValue(gitDate)) {
				const dateProc = Bun.spawnSync([
					"git",
					"show",
					"-s",
					"--format=%cI",
					"HEAD",
				]);
				if (dateProc.success)
					gitDate = knownGitValue(dateProc.stdout.toString());
			}

			const msgProc = Bun.spawnSync([
				"git",
				"show",
				"-s",
				"--format=%s",
				"HEAD",
			]);
			if (msgProc.success)
				gitMessage = knownGitValue(msgProc.stdout.toString());
		} catch {
			// ignore
		}
	}
}

export const config = {
	env: env.NODE_ENV === "production" ? "PROD" : "DEV",
	git: {
		sha: gitSha,
		shortSha: gitSha?.substring(0, 7),
		date: gitDate,
		message: gitMessage,
		buildDate,
	},
	isProduction: env.NODE_ENV === "production",
	s3Domain: env.S3_DOMAIN,
	dashboardDomain,
	dashboardOriginDomains: (env.DASHBOARD_ORIGIN_DOMAINS || "")
		.split(",")
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean),
	dashboardUrl: `${env.NODE_ENV === "production" ? "https" : "http"}://${dashboardDomain}`,
	databaseUrl: env.DATABASE_URL,
	redisUrl: env.REDIS_URL,
	// Logical S3 signature scope only. Physical provider credentials are
	// intentionally dataplane-only and must never enter the Bun process.
	s3SigningRegion: env.S3_REGION,
	deepFreeze: {
		storagePrefix: env.DEEP_FREEZE_STORAGE_PREFIX,
	},
	hcAuth: {
		clientId: env.HC_AUTH_CLIENT_ID,
		clientSecret: env.HC_AUTH_CLIENT_SECRET,
		redirectUri: env.HC_AUTH_REDIRECT_URI,
	},
	offboardingExportDerivationSecret:
		env.OFFBOARDING_EXPORT_DERIVATION_SECRET || env.HC_AUTH_CLIENT_SECRET,
	slack: {
		botToken: env.SLACK_BOT_TOKEN,
		signingSecret: env.SLACK_SIGNING_SECRET,
		fileUploadChannelId: env.SLACK_FILE_UPLOAD_CHANNEL_ID,
	},
	revocationSecret: env.REVOCATION_SECRET,
	customDomainsEnabled: env.DOMAINS === "true",
	deepFreezeEnabled: env.DEEP_FREEZE === "true",
	cloudflareForSaas: {
		apiToken: env.CF_API_TOKEN,
		zoneId: env.CF_ZONE_ID,
		fallbackOrigin: env.CF_SAAS_FALLBACK_ORIGIN,
		targetHostname: env.CF_SAAS_TARGET || env.S3_DOMAIN,
		minTlsVersion: env.CF_SAAS_MIN_TLS || "1.2",
		configured: Boolean(
			env.CF_API_TOKEN && env.CF_ZONE_ID && env.CF_SAAS_FALLBACK_ORIGIN,
		),
	},
	dataplane: {
		internalSecret: env.DATAPLANE_INTERNAL_SECRET,
		url: defaultDataplaneUrl,
		regionUrls: dataplaneRegionUrls,
	},
	bucketUsageReconcileIntervalMs: Number(
		env.BUCKET_USAGE_RECONCILE_INTERVAL_MS || 10 * 60 * 1000,
	),
	customDomainRevalidateIntervalMs: Number(
		env.CUSTOM_DOMAIN_REVALIDATE_INTERVAL_MS || 10 * 60 * 1000,
	),
};
