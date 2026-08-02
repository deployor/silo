import { config } from "../config";
import type { buckets } from "../db/schema";
import { getBucketStorageRegion } from "./regions";

type BucketRecord = Pick<
	typeof buckets.$inferSelect,
	"id" | "name" | "resolvedRegion"
>;

const INTERNAL_CONTROL_TIMEOUT_MS = 60_000;

function internalStorageUrl(
	regionId: ReturnType<typeof getBucketStorageRegion>,
) {
	return `${config.dataplane.regionUrls[regionId]}/api/internal/storage/execute`;
}

function headerEncode(value: string) {
	return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Executes storage traffic through Rust so mutation requests are covered by
 * the regional writer lease, backend generation, accounting, and replication
 * fences. The body and response remain streaming.
 */
export async function executeDataplaneStorage(params: {
	bucket: BucketRecord;
	rootPrefix: string;
	pathWithQuery: string;
	method: "GET" | "HEAD" | "PUT" | "POST" | "DELETE";
	headers?: HeadersInit;
	body?: BodyInit | null;
}): Promise<Response> {
	if (!config.dataplane.internalSecret) {
		throw new Error("DATAPLANE_INTERNAL_SECRET is required for storage access");
	}
	const storageRegion = getBucketStorageRegion(params.bucket);
	const headers = new Headers(params.headers);
	headers.set("x-dataplane-secret", config.dataplane.internalSecret);
	headers.set("x-silo-storage-region", storageRegion);
	headers.set("x-silo-bucket-id", params.bucket.id);
	headers.set("x-silo-root-prefix-b64", headerEncode(params.rootPrefix));
	headers.set("x-silo-path-with-query-b64", headerEncode(params.pathWithQuery));
	headers.set("x-silo-upstream-method", params.method);

	return fetch(internalStorageUrl(storageRegion), {
		method: "POST",
		headers,
		body: params.body,
		duplex: params.body ? "half" : undefined,
	} as RequestInit);
}

function regionInternalUrl(
	regionId: ReturnType<typeof getBucketStorageRegion>,
	path: string,
) {
	return `${config.dataplane.regionUrls[regionId]}${path}`;
}

async function authenticatedRegionRequest(
	regionId: ReturnType<typeof getBucketStorageRegion>,
	path: string,
	init: RequestInit,
) {
	if (!config.dataplane.internalSecret) {
		throw new Error(
			"DATAPLANE_INTERNAL_SECRET is required for storage control",
		);
	}
	const headers = new Headers(init.headers);
	headers.set("x-dataplane-secret", config.dataplane.internalSecret);
	return fetch(regionInternalUrl(regionId, path), {
		...init,
		headers,
		signal: init.signal || AbortSignal.timeout(INTERNAL_CONTROL_TIMEOUT_MS),
	});
}

/**
 * Acquires the dataplane's exclusive per-bucket advisory lock after it has
 * independently proved the bucket empty and accounting durable. The caller
 * must retain the token until the metadata transaction has committed.
 */
export async function beginDataplaneBucketTeardown(bucket: BucketRecord) {
	const regionId = getBucketStorageRegion(bucket);
	const response = await authenticatedRegionRequest(
		regionId,
		"/api/internal/bucket/teardown/verify",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ bucketId: bucket.id }),
		},
	);
	const result = (await response.json().catch(() => null)) as {
		ok?: unknown;
		token?: unknown;
	} | null;
	if (!response.ok || result?.ok !== true || typeof result.token !== "string") {
		throw new Error("Dataplane rejected the exclusive bucket teardown proof");
	}
	return result.token;
}

export async function releaseDataplaneBucketTeardown(
	bucket: BucketRecord,
	token: string,
) {
	const regionId = getBucketStorageRegion(bucket);
	const response = await authenticatedRegionRequest(
		regionId,
		"/api/internal/bucket/teardown/release",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ bucketId: bucket.id, token }),
		},
	);
	if (!response.ok) {
		throw new Error(
			`Dataplane bucket teardown fence release failed (${response.status})`,
		);
	}
}
