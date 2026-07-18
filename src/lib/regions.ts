export const AUTOMATIC_REGION_ID = "auto" as const;
export const DEFAULT_STORAGE_REGION_ID = "eu-central" as const;

/**
 * Product-facing storage region registry. Adding a region should start here;
 * persistence and storage-client selection consume these stable IDs.
 */
export const STORAGE_REGIONS = [
	{
		id: "eu-central",
		flag: "🇩🇪",
		name: "Europe",
		location: "Germany",
		description: "Recommended for European users",
		endpoint: "onsilo.dev",
		regionalEndpoint: "eu.onsilo.dev",
		isDefault: true,
	},
	{
		id: "us-east",
		flag: "🇺🇸",
		name: "United States",
		location: "US East",
		description: "Recommended for users and workloads in North America",
		endpoint: "us.onsilo.dev",
		regionalEndpoint: "us.onsilo.dev",
		isDefault: false,
	},
] as const;

export type StorageRegionId = (typeof STORAGE_REGIONS)[number]["id"];
export type RequestedBucketRegion =
	| typeof AUTOMATIC_REGION_ID
	| StorageRegionId;

const storageRegionIds = new Set<string>(
	STORAGE_REGIONS.map((region) => region.id),
);
const regionalOriginHosts = new Set<string>(
	STORAGE_REGIONS.flatMap((region) => [
		region.endpoint,
		region.regionalEndpoint,
	]),
);

export function isStorageRegionId(value: unknown): value is StorageRegionId {
	return typeof value === "string" && storageRegionIds.has(value);
}

export function isRequestedBucketRegion(
	value: unknown,
): value is RequestedBucketRegion {
	return value === AUTOMATIC_REGION_ID || isStorageRegionId(value);
}

export function resolveRequestedRegion(
	requestedRegion: RequestedBucketRegion,
): StorageRegionId {
	return requestedRegion === AUTOMATIC_REGION_ID
		? DEFAULT_STORAGE_REGION_ID
		: requestedRegion;
}

export function normalizeRequestedRegion(
	value: unknown,
): RequestedBucketRegion {
	return isRequestedBucketRegion(value) ? value : AUTOMATIC_REGION_ID;
}

export function normalizeStorageRegion(value: unknown): StorageRegionId {
	return isStorageRegionId(value) ? value : DEFAULT_STORAGE_REGION_ID;
}

/** Missing values are legacy EU buckets; explicit unknown values fail closed. */
export function getBucketStorageRegion(bucket: {
	resolvedRegion?: unknown;
}): StorageRegionId {
	const value = bucket.resolvedRegion;
	if (value === null || value === undefined || value === "") {
		return DEFAULT_STORAGE_REGION_ID;
	}
	if (!isStorageRegionId(value)) {
		throw new Error(`Unsupported bucket storage region: ${String(value)}`);
	}
	return value;
}

export function getStorageRegion(regionId: StorageRegionId) {
	const region = STORAGE_REGIONS.find((candidate) => candidate.id === regionId);
	if (!region) throw new Error(`Unknown storage region: ${regionId}`);
	return region;
}

export function isRegionalOriginHost(host: string): boolean {
	return regionalOriginHosts.has(host.toLowerCase().replace(/:\d+$/, ""));
}
