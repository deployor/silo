import { redis } from "./redis";

type QuotaUser = {
	id: string;
	isImmortal: boolean;
	storageLimitBytes: number | null;
	egressLimitBytes: number | null;
};

const STORAGE_KEY = (userId: string) => `quota:storage:${userId}`;
const EGRESS_KEY = (userId: string) => `quota:egress:${userId}`;

const CHECK_AND_INCREMENT_LUA = `
local key = KEYS[1]
local delta = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local seed = tonumber(ARGV[3])

local current = tonumber(redis.call('GET', key))
if current == nil then
  current = seed
  redis.call('SET', key, current)
end

if (current + delta) > limit then
  return {0, current}
end

local nextValue = redis.call('INCRBY', key, delta)
return {1, nextValue}
`;

const DECREMENT_CLAMP_LUA = `
local key = KEYS[1]
local delta = tonumber(ARGV[1])
local current = tonumber(redis.call('GET', key))
if current == nil then
  return 0
end
local nextValue = current - delta
if nextValue < 0 then nextValue = 0 end
redis.call('SET', key, nextValue)
return nextValue
`;

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
	if (user.isImmortal) return true;
	if (bytesToAdd <= 0) return true;

	const storageLimit = Number(user.storageLimitBytes ?? 0);
	if (!Number.isFinite(storageLimit) || storageLimit <= 0) return false;

	const result = (await redis.eval(
		CHECK_AND_INCREMENT_LUA,
		1,
		STORAGE_KEY(user.id),
		String(Math.floor(bytesToAdd)),
		String(Math.floor(storageLimit)),
		String(Math.max(0, Math.floor(currentStorageUsageBytes))),
	)) as [number, number];

	return Number(result?.[0]) === 1;
}

export async function releaseStorageQuota(
	userId: string,
	bytesToRelease: number,
): Promise<void> {
	if (!userId || bytesToRelease <= 0) return;

	await redis.eval(
		DECREMENT_CLAMP_LUA,
		1,
		STORAGE_KEY(userId),
		String(Math.floor(bytesToRelease)),
	);
}

export async function consumeEgressQuota(
	user: QuotaUser,
	currentEgressBytes: number,
	bytesToAdd: number,
): Promise<boolean> {
	if (user.isImmortal) return true;
	if (bytesToAdd <= 0) return true;

	const egressLimit = computeEgressLimitBytes(user);
	if (egressLimit === null) return true;

	const result = (await redis.eval(
		CHECK_AND_INCREMENT_LUA,
		1,
		EGRESS_KEY(user.id),
		String(Math.floor(bytesToAdd)),
		String(Math.floor(egressLimit)),
		String(Math.max(0, Math.floor(currentEgressBytes))),
	)) as [number, number];

	return Number(result?.[0]) === 1;
}
