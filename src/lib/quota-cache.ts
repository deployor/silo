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
};

const STORAGE_KEY = (userId: string) => `quota:storage:${userId}`;
const EGRESS_KEY = (userId: string) => `quota:egress:${userId}`;

const BUCKET_COUNTER_TTL_SECONDS = 3600;

function computeEgressLimitBytes(user: QuotaUser): number | null {
	if (user.isImmortal) return null;

	if (user.egressLimitBytes !== null && user.egressLimitBytes !== undefined) {
		if (user.egressLimitBytes === -1) return null; // unlimited
		return Number(user.egressLimitBytes);
	}

	const storageLimit = Number(user.storageLimitBytes ?? 0);
	if (storageLimit <= 0) return 10 * 1024 * 1024 * 1024;

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

	const storageLimit = Number(user.storageLimitBytes ?? 0);
	if (!Number.isFinite(storageLimit) || storageLimit <= 0) return false;

	const result = (await redis.eval(
		"return redis.call('checkAndIncrQuota', KEYS[1], ARGV[1], ARGV[2], ARGV[3])",
		1,
		STORAGE_KEY(user.id),
		String(Math.floor(bytesToAdd)),
		String(Math.floor(storageLimit)),
		String(Math.max(0, Math.floor(currentStorageUsageBytes))),
	)) as [number, number];

	if (Number(result?.[0]) === 1) {
		void redis.expire(STORAGE_KEY(user.id), BUCKET_COUNTER_TTL_SECONDS);
	}

	return Number(result?.[0]) === 1;
}

export async function releaseStorageQuota(
	userId: string,
	bytesToRelease: number,
): Promise<void> {
	if (!QUOTA_CACHE_ENABLED) return;
	if (!userId || bytesToRelease <= 0) return;

	await redis.eval(
		"return redis.call('decrClampQuota', KEYS[1], ARGV[1])",
		1,
		STORAGE_KEY(userId),
		String(Math.floor(bytesToRelease)),
	);
	void redis.expire(STORAGE_KEY(userId), BUCKET_COUNTER_TTL_SECONDS);
}

export async function consumeEgressQuota(
	user: QuotaUser,
	currentEgressBytes: number,
	bytesToAdd: number,
): Promise<boolean> {
	if (!QUOTA_CACHE_ENABLED) return true;
	if (user.isImmortal) return true;
	if (bytesToAdd <= 0) return true;

	const egressLimit = computeEgressLimitBytes(user);
	if (egressLimit === null) return true;

	const result = (await redis.eval(
		"return redis.call('checkAndIncrQuota', KEYS[1], ARGV[1], ARGV[2], ARGV[3])",
		1,
		EGRESS_KEY(user.id),
		String(Math.floor(bytesToAdd)),
		String(Math.floor(egressLimit)),
		String(Math.max(0, Math.floor(currentEgressBytes))),
	)) as [number, number];

	if (Number(result?.[0]) === 1) {
		void redis.expire(EGRESS_KEY(user.id), BUCKET_COUNTER_TTL_SECONDS);
	}

	return Number(result?.[0]) === 1;
}
