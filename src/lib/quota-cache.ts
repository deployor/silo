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

	try {
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

	try {
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
			EGRESS_KEY(user.id),
			String(Math.floor(bytesToAdd)),
			String(Math.floor(egressLimit)),
			String(Math.max(0, Math.floor(currentEgressBytes))),
		)) as [number, number];

		return Number(result?.[0]) === 1;
	} catch (error) {
		console.error("[quota] egress reservation failed (fail-closed)", error);
		return false;
	}
}
