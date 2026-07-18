import { config } from "../config";
import { getBucketStorageRegion } from "./regions";

const INVALIDATION_TIMEOUT_MS = 2_000;

async function postInvalidation(url: string, body: unknown) {
	if (!config.dataplane.internalSecret) return;
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-dataplane-secret": config.dataplane.internalSecret,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(INVALIDATION_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Dataplane cache invalidation failed (${response.status})`);
	}
}

export async function invalidateDataplaneAuthCache(params: {
	bucketName?: string;
	accessKey?: string;
}) {
	const urls = new Set(Object.values(config.dataplane.regionUrls));
	const results = await Promise.allSettled(
		[...urls].map((baseUrl) =>
			postInvalidation(`${baseUrl}/api/internal/auth-cache/invalidate`, {
				bucketName: params.bucketName,
				accessKeyIds: params.accessKey ? [params.accessKey] : [],
			}),
		),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			console.warn("Dataplane auth cache invalidation failed", result.reason);
		}
	}
}

export async function invalidateDataplaneListCache(bucket: {
	id: string;
	resolvedRegion?: unknown;
}) {
	const regionId = getBucketStorageRegion(bucket);
	try {
		await postInvalidation(
			`${config.dataplane.regionUrls[regionId]}/api/internal/dashboard/list-cache/invalidate`,
			{ bucketId: bucket.id, resolvedRegion: regionId },
		);
	} catch (error) {
		console.warn("Dataplane list cache invalidation failed", error);
	}
}
