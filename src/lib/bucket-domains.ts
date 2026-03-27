import { randomBytes } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { buckets } from "../db/schema";
import { redis } from "./redis";

export type DomainVerificationRecord = {
	type: string;
	name: string;
	value: string;
};

export type DomainSslValidationRecord = {
	txtName: string;
	txtValue: string;
	status: string;
};

export type BucketCustomDomain = {
	domain: string;
	verified: boolean;
	primary: boolean;
	verificationToken: string;
	createdAt: string;
	verifiedAt: string | null;
	hostnameId?: string | null;
	status?: string | null;
	sslStatus?: string | null;
	verificationErrors?: string[];
	ownershipVerification?: DomainVerificationRecord | null;
	sslValidationRecords?: DomainSslValidationRecord[];
	lastCheckedAt?: string | null;
};

const CUSTOM_DOMAIN_CACHE_TTL_SECONDS = 300;
const MAX_CUSTOM_DOMAINS_PER_BUCKET = 10;

export function normalizeCustomDomain(input: string): string {
	const trimmed = input.trim().toLowerCase().replace(/\.+$/, "");
	if (!trimmed) {
		throw new Error("Custom domain is required");
	}
	if (trimmed.includes("://") || trimmed.includes("/") || trimmed.includes("?") || trimmed.includes("#")) {
		throw new Error("Enter only a hostname, without protocol or path");
	}
	if (trimmed.length > 253) {
		throw new Error("Custom domain is too long");
	}
	if (!trimmed.includes(".")) {
		throw new Error("Custom domain must include a valid hostname");
	}
	if (trimmed === config.s3Domain || trimmed === `dashboard.${config.s3Domain}`) {
		throw new Error("This domain is reserved by Silo");
	}
	if (trimmed.endsWith(`.${config.s3Domain}`)) {
		throw new Error("Silo-owned subdomains cannot be added as custom domains");
	}
	const labels = trimmed.split(".");
	for (const label of labels) {
		if (!/^[a-z0-9-]{1,63}$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
			throw new Error("Custom domain must be a valid DNS hostname");
		}
	}
	return trimmed;
}

export function parseBucketCustomDomains(raw: string | null | undefined): BucketCustomDomain[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((entry) => ({
				domain: normalizeCustomDomain(String(entry?.domain || "")),
				verified: Boolean(entry?.verified),
				primary: Boolean(entry?.primary),
				verificationToken: String(
					entry?.verificationToken || entry?.ownershipVerification?.value || "",
				),
				createdAt: String(entry?.createdAt || new Date(0).toISOString()),
				verifiedAt: entry?.verifiedAt ? String(entry.verifiedAt) : null,
				hostnameId: entry?.hostnameId ? String(entry.hostnameId) : null,
				status: entry?.status ? String(entry.status) : null,
				sslStatus: entry?.sslStatus ? String(entry.sslStatus) : null,
				verificationErrors: Array.isArray(entry?.verificationErrors)
					? entry.verificationErrors.map((value: unknown) => String(value))
					: [],
				ownershipVerification: entry?.ownershipVerification
					? {
						type: String(entry.ownershipVerification.type || "txt"),
						name: String(entry.ownershipVerification.name || ""),
						value: String(entry.ownershipVerification.value || ""),
					}
					: null,
				sslValidationRecords: Array.isArray(entry?.sslValidationRecords)
					? entry.sslValidationRecords.map((record: unknown) => {
						const typed = record as Record<string, unknown>;
						return {
							txtName: String(typed.txtName || typed.txt_name || ""),
							txtValue: String(typed.txtValue || typed.txt_value || ""),
							status: String(typed.status || "pending"),
						};
					})
					: [],
				lastCheckedAt: entry?.lastCheckedAt ? String(entry.lastCheckedAt) : null,
			}))
			.filter((entry) => Boolean(entry.domain) && entry.verificationToken.length >= 16);
	} catch {
		return [];
	}
}

export function serializeBucketCustomDomains(domains: BucketCustomDomain[]): string {
	return JSON.stringify(domains);
}

export function createCustomDomainRecord(domain: string): BucketCustomDomain {
	const verificationToken = randomBytes(18).toString("hex");
	return {
		domain: normalizeCustomDomain(domain),
		verified: false,
		primary: false,
		verificationToken,
		createdAt: new Date().toISOString(),
		verifiedAt: null,
		hostnameId: null,
		status: "pending",
		sslStatus: "initializing",
		verificationErrors: [],
		ownershipVerification: {
			type: "txt",
			name: `_cf-custom-hostname.${normalizeCustomDomain(domain)}`,
			value: verificationToken,
		},
		sslValidationRecords: [],
		lastCheckedAt: null,
	};
}

export function sanitizeBucketCustomDomains(domains: BucketCustomDomain[]): BucketCustomDomain[] {
	const unique = new Map<string, BucketCustomDomain>();
	for (const domain of domains) {
		const hostname = normalizeCustomDomain(domain.domain);
		if (unique.has(hostname)) {
			throw new Error(`Duplicate custom domain: ${hostname}`);
		}
		unique.set(hostname, {
			...domain,
			domain: hostname,
			verificationErrors: domain.verificationErrors || [],
			ownershipVerification: domain.ownershipVerification || null,
			sslValidationRecords: domain.sslValidationRecords || [],
		});
	}
	if (unique.size > MAX_CUSTOM_DOMAINS_PER_BUCKET) {
		throw new Error(`A bucket can only have ${MAX_CUSTOM_DOMAINS_PER_BUCKET} custom domains`);
	}
	const values = Array.from(unique.values());
	const verifiedPrimary = values.find((entry) => entry.primary && entry.verified);
	return values.map((entry, index) => ({
		...entry,
		primary: verifiedPrimary ? verifiedPrimary.domain === entry.domain : index === 0 && entry.verified,
	}));
}

export function getPrimaryVerifiedCustomDomain(domains: BucketCustomDomain[]): BucketCustomDomain | null {
	return domains.find((entry) => entry.primary && entry.verified) || domains.find((entry) => entry.verified) || null;
}

export function buildBucketObjectUrl(params: {
	bucketName: string;
	key: string;
	customDomains?: BucketCustomDomain[];
}): string {
	const safeKey = params.key.replace(/^\/+/, "");
	const primary = getPrimaryVerifiedCustomDomain(params.customDomains || []);
	if (primary) {
		return `https://${primary.domain}/${safeKey}`;
	}
	return `https://${config.s3Domain}/${params.bucketName}/${safeKey}`;
}

export function buildBucketUrlExample(params: {
	bucketName: string;
	customDomains?: BucketCustomDomain[];
	fileName?: string;
}): string {
	return buildBucketObjectUrl({
		bucketName: params.bucketName,
		customDomains: params.customDomains,
		key: params.fileName || "file.png",
	});
}

export async function resolveBucketByHostname(hostname: string) {
	const normalized = normalizeCustomDomain(hostname);
	const cacheKey = `bucket:custom-domain:${normalized}`;
	try {
		const cached = await redis.get(cacheKey);
		if (cached) {
			const bucketId = String(cached);
			const rows = await db.select().from(buckets).where(eq(buckets.id, bucketId)).limit(1);
			return rows[0] || null;
		}
	} catch (error) {
		console.error("custom domain cache lookup failed", error);
	}

	const rows = await db.select().from(buckets).where(isNotNull(buckets.customDomains));
	for (const bucket of rows) {
		const match = parseBucketCustomDomains(bucket.customDomains).find(
			(entry) => entry.verified && entry.domain === normalized,
		);
		if (!match) continue;
		try {
			await redis.set(cacheKey, bucket.id, "EX", CUSTOM_DOMAIN_CACHE_TTL_SECONDS);
		} catch (error) {
			console.error("custom domain cache write failed", error);
		}
		return bucket;
	}

	return null;
}

export async function invalidateBucketCustomDomainCache(domains: BucketCustomDomain[]) {
	await Promise.allSettled(
		domains.map((entry) => redis.del(`bucket:custom-domain:${entry.domain}`)),
	);
}
