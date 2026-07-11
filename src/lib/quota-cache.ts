import { getAppSettings } from "../services/settings-service";
import { redis } from "./redis";

// TEMP BENCH SWITCH:
// Set to false to bypass Redis quota counters while load-testing performance.
// Keep true in normal operation.
const QUOTA_CACHE_ENABLED = true;

type QuotaUser = {
	id: string;
	isImmortal: boolean;
	storageLimitBytes: number | null;
	egressLimitBytes: number | null;
	egressPeriod?: string | null;
};

const STORAGE_KEY = (userId: string) => `quota:storage:${userId}`;
const currentEgressPeriod = () => new Date().toISOString().slice(0, 7);
const EGRESS_KEY = (userId: string, period: string) =>
	`quota:egress:${userId}:${period}`;
const MPU_KEY = (userId: string, bucketId: string, uploadId: string) =>
	`quota:mpu:${userId}:${bucketId}:${uploadId}`;
const MPU_TTL_SECONDS = 7 * 24 * 60 * 60;
const MPU_EXISTING_CREDIT_FIELD = "__existingCredit";

function parseQuotaNumber(value: string | null | undefined) {
	const parsed = Number(value || 0);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function effectiveStorageLimitBytes(user: QuotaUser): Promise<number> {
	const storageLimit = Number(user.storageLimitBytes ?? 0);
	if (Number.isFinite(storageLimit) && storageLimit > 0) return storageLimit;
	return (await getAppSettings()).defaultStorageLimitBytes;
}

async function computeEgressLimitBytes(
	user: QuotaUser,
): Promise<number | null> {
	if (user.isImmortal) return null;

	if (user.egressLimitBytes !== null && user.egressLimitBytes !== undefined) {
		if (user.egressLimitBytes === -1) return null; // unlimited
		return Number(user.egressLimitBytes);
	}

	const storageLimit = await effectiveStorageLimitBytes(user);

	const calculated = storageLimit * 3;
	const minLimit = 10 * 1024 * 1024 * 1024;
	return Math.max(calculated, minLimit);
}

export async function consumeStorageQuota(
	user: QuotaUser,
	currentStorageUsageBytes: number,
	bytesToAdd: number,
): Promise<boolean> {
	if (!QUOTA_CACHE_ENABLED) return true;
	if (user.isImmortal) return true;
	if (bytesToAdd <= 0) return true;

	try {
		const storageLimit = await effectiveStorageLimitBytes(user);
		if (!Number.isFinite(storageLimit) || storageLimit <= 0) return false;
		const result = (await (
			redis as unknown as {
				checkAndIncrQuota: (
					key: string,
					delta: string,
					limit: string,
					seed: string,
				) => Promise<[number, number]>;
			}
		).checkAndIncrQuota(
			STORAGE_KEY(user.id),
			String(Math.floor(bytesToAdd)),
			String(Math.floor(storageLimit)),
			String(Math.max(0, Math.floor(currentStorageUsageBytes))),
		)) as [number, number];

		return Number(result?.[0]) === 1;
	} catch (error) {
		console.error("[quota] storage reservation failed (fail-closed)", error);
		return false;
	}
}

export async function releaseStorageQuota(
	userId: string,
	bytesToRelease: number,
): Promise<void> {
	if (!QUOTA_CACHE_ENABLED) return;
	if (!userId || bytesToRelease <= 0) return;

	try {
		await (
			redis as unknown as {
				decrClampQuota: (key: string, delta: string) => Promise<number>;
			}
		).decrClampQuota(STORAGE_KEY(userId), String(Math.floor(bytesToRelease)));
	} catch (error) {
		console.error("[quota] storage release failed", error);
	}
}

export async function reserveMultipartPartQuota(params: {
	user: QuotaUser;
	currentStorageUsageBytes: number;
	bucketId: string;
	uploadId: string;
	partNumber: string;
	partSize: number;
}): Promise<boolean> {
	if (!QUOTA_CACHE_ENABLED) return true;
	if (params.user.isImmortal) return true;
	if (params.partSize < 0 || !Number.isFinite(params.partSize)) return false;

	const key = MPU_KEY(params.user.id, params.bucketId, params.uploadId);
	try {
		const storageLimit = await effectiveStorageLimitBytes(params.user);
		if (!Number.isFinite(storageLimit) || storageLimit <= 0) return false;
		const result = (await (
			redis as unknown as {
				reserveMultipartPartQuota: (
					quotaKey: string,
					mpuKey: string,
					partNumber: string,
					partSize: string,
					limit: string,
					seed: string,
					ttl: string,
				) => Promise<[number, number, number]>;
			}
		).reserveMultipartPartQuota(
			STORAGE_KEY(params.user.id),
			key,
			params.partNumber,
			String(Math.floor(params.partSize)),
			String(Math.floor(storageLimit)),
			String(Math.max(0, Math.floor(params.currentStorageUsageBytes))),
			String(MPU_TTL_SECONDS),
		)) as [number, number, number];

		return Number(result?.[0]) === 1;
	} catch (error) {
		console.error(
			"[quota] multipart part reservation failed (fail-closed)",
			error,
		);
		return false;
	}
}

export async function registerMultipartUploadQuota(params: {
	userId: string;
	bucketId: string;
	uploadId: string;
	existingSize: number;
}): Promise<void> {
	if (!QUOTA_CACHE_ENABLED) return;
	try {
		const key = MPU_KEY(params.userId, params.bucketId, params.uploadId);
		await redis.hset(
			key,
			MPU_EXISTING_CREDIT_FIELD,
			String(Math.max(0, Math.floor(params.existingSize))),
		);
		await redis.expire(key, MPU_TTL_SECONDS);
	} catch (error) {
		console.error("[quota] multipart registration failed", error);
	}
}

export async function releaseMultipartQuota(params: {
	userId: string;
	bucketId: string;
	uploadId: string;
}): Promise<void> {
	if (!QUOTA_CACHE_ENABLED) return;
	try {
		const key = MPU_KEY(params.userId, params.bucketId, params.uploadId);
		const values = await redis.hgetall(key);
		const existingCredit = parseQuotaNumber(values[MPU_EXISTING_CREDIT_FIELD]);
		let total = parseQuotaNumber(values.__total);
		if (total === 0) {
			for (const [field, value] of Object.entries(values)) {
				if (field !== MPU_EXISTING_CREDIT_FIELD && field !== "__total") {
					total += parseQuotaNumber(value);
				}
			}
		}
		const reserved = Math.max(0, total - existingCredit);
		if (reserved > 0) await releaseStorageQuota(params.userId, reserved);
		await redis.del(key);
	} catch (error) {
		console.error("[quota] multipart release failed", error);
	}
}

export async function clearMultipartQuota(params: {
	userId: string;
	bucketId: string;
	uploadId: string;
}): Promise<void> {
	if (!QUOTA_CACHE_ENABLED) return;
	try {
		await redis.del(MPU_KEY(params.userId, params.bucketId, params.uploadId));
	} catch (error) {
		console.error("[quota] multipart clear failed", error);
	}
}

export async function consumeEgressQuota(
	user: QuotaUser,
	currentEgressBytes: number,
	bytesToAdd: number,
): Promise<boolean> {
	if (!QUOTA_CACHE_ENABLED) return true;
	if (user.isImmortal) return true;
	if (bytesToAdd <= 0) return true;

	const egressLimit = await computeEgressLimitBytes(user);
	if (egressLimit === null) return true;
	const period = currentEgressPeriod();
	const seed =
		user.egressPeriod === period
			? Math.max(0, Math.floor(currentEgressBytes))
			: 0;

	try {
		const key = EGRESS_KEY(user.id, period);
		const result = (await (
			redis as unknown as {
				checkAndIncrQuota: (
					key: string,
					delta: string,
					limit: string,
					seed: string,
				) => Promise<[number, number]>;
			}
		).checkAndIncrQuota(
			key,
			String(Math.floor(bytesToAdd)),
			String(Math.floor(egressLimit)),
			String(seed),
		)) as [number, number];

		redis.expire(key, 90 * 24 * 60 * 60).catch(() => {});

		return Number(result?.[0]) === 1;
	} catch (error) {
		console.error("[quota] egress reservation failed (fail-closed)", error);
		return false;
	}
}
