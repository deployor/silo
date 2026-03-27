import { config } from "../config";
import type {
	BucketCustomDomain,
	DomainSslValidationRecord,
	DomainVerificationRecord,
} from "./bucket-domains";

type CloudflareResponse<T> = {
	success: boolean;
	errors?: Array<{ message?: string }>;
	result: T;
};

type CloudflareCustomHostname = {
	id: string;
	hostname: string;
	status?: string;
	created_at?: string;
	verification_errors?: string[];
	ownership_verification?: {
		type?: string;
		name?: string;
		value?: string;
	} | null;
	ssl?: {
		status?: string;
		validation_records?: Array<{
			cname?: string;
			cname_target?: string;
			status?: string;
			txt_name?: string;
			txt_value?: string;
		}>;
		dcv_delegation_records?: Array<{
			cname?: string;
			cname_target?: string;
			status?: string;
			txt_name?: string;
			txt_value?: string;
		}>;
	} | null;
};

function getApiBase() {
	return `https://api.cloudflare.com/client/v4/zones/${config.cloudflareForSaas.zoneId}/custom_hostnames`;
}

function getHeaders() {
	return {
		Authorization: `Bearer ${config.cloudflareForSaas.apiToken}`,
		"Content-Type": "application/json",
	};
}

async function cloudflareRequest<T>(
	path: string,
	init?: RequestInit,
): Promise<T> {
	if (!config.cloudflareForSaas.configured) {
		throw new Error("Cloudflare for SaaS is not configured");
	}
	const response = await fetch(`${getApiBase()}${path}`, {
		...init,
		headers: {
			...getHeaders(),
			...(init?.headers || {}),
		},
	});
	const payload = (await response.json()) as CloudflareResponse<T>;
	if (!response.ok || !payload.success) {
		throw new Error(
			payload.errors?.map((error) => error.message).filter(Boolean).join(", ") ||
				`Cloudflare API request failed with status ${response.status}`,
		);
	}
	return payload.result;
}

function mapOwnershipVerification(
	input: CloudflareCustomHostname["ownership_verification"],
	hostname: string,
	fallbackValue: string,
): DomainVerificationRecord {
	return {
		type: String(input?.type || "txt"),
		name: String(input?.name || `_cf-custom-hostname.${hostname}`),
		value: String(input?.value || fallbackValue),
	};
}

function mapSslValidationRecords(
	input: CloudflareCustomHostname["ssl"] extends infer T
		? T extends { validation_records?: infer R }
			? R
			: never
		: never,
): DomainSslValidationRecord[] {
	if (!Array.isArray(input)) return [];
	return input.map((record) => ({
		txtName: String(record?.txt_name || ""),
		txtValue: String(record?.txt_value || ""),
		status: String(record?.status || "pending"),
	}));
}

function mergeSslValidationRecords(result: CloudflareCustomHostname) {
	const direct = mapSslValidationRecords(result.ssl?.validation_records);
	const delegated = mapSslValidationRecords(result.ssl?.dcv_delegation_records);
	const all = [...direct, ...delegated].filter(
		(record) => record.txtName || record.txtValue,
	);
	const unique = new Map<string, DomainSslValidationRecord>();
	for (const record of all) {
		unique.set(`${record.txtName}:${record.txtValue}`, record);
	}
	return Array.from(unique.values());
}

export function isCloudflareForSaasConfigured() {
	return config.cloudflareForSaas.configured;
}

export function getCloudflareCustomHostnameTarget() {
	return config.cloudflareForSaas.targetHostname;
}

export function getCloudflareFallbackOrigin() {
	return config.cloudflareForSaas.fallbackOrigin;
}

export async function createCloudflareCustomHostname(
	domain: BucketCustomDomain,
) {
	const result = await cloudflareRequest<CloudflareCustomHostname>("", {
		method: "POST",
		body: JSON.stringify({
			hostname: domain.domain,
			custom_origin_server: config.cloudflareForSaas.fallbackOrigin,
			ssl: {
				bundle_method: "ubiquitous",
				method: "txt",
				type: "dv",
				settings: {
					min_tls_version: config.cloudflareForSaas.minTlsVersion,
				},
			},
		}),
	});

	return {
		hostnameId: result.id,
		status: result.status || "pending",
		sslStatus: result.ssl?.status || "initializing",
		verificationErrors: result.verification_errors || [],
		ownershipVerification: mapOwnershipVerification(
			result.ownership_verification,
			domain.domain,
			domain.verificationToken,
		),
		sslValidationRecords: mergeSslValidationRecords(result),
		lastCheckedAt: new Date().toISOString(),
	};
}

export async function deleteCloudflareCustomHostname(hostnameId: string) {
	await cloudflareRequest<{ id: string }>(`/${hostnameId}`, {
		method: "DELETE",
	});
}

export async function getCloudflareCustomHostname(hostnameId: string) {
	return cloudflareRequest<CloudflareCustomHostname>(`/${hostnameId}`, {
		method: "GET",
	});
}

export function applyCloudflareHostnameState(
	domain: BucketCustomDomain,
	result: CloudflareCustomHostname,
): BucketCustomDomain {
	const status = result.status || domain.status || "pending";
	const sslStatus = result.ssl?.status || domain.sslStatus || "initializing";
	const verified = status === "active" && sslStatus === "active";
	return {
		...domain,
		hostnameId: result.id,
		status,
		sslStatus,
		verified,
		verifiedAt: verified ? domain.verifiedAt || new Date().toISOString() : null,
		verificationErrors: result.verification_errors || [],
		ownershipVerification: mapOwnershipVerification(
			result.ownership_verification,
			domain.domain,
			domain.verificationToken,
		),
		verificationToken:
			result.ownership_verification?.value ||
			domain.verificationToken,
		sslValidationRecords: mergeSslValidationRecords(result),
		lastCheckedAt: new Date().toISOString(),
	};
}
