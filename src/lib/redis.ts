import Redis from "ioredis";
import { config } from "../config";

export const redis = new Redis(config.redisUrl, {
	maxRetriesPerRequest: null,
	enableReadyCheck: false,
});

// High-throughput Lua commands (uses EVALSHA under the hood after first load)
redis.defineCommand("checkAndIncrQuota", {
	numberOfKeys: 1,
	lua: `
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
`,
});

redis.defineCommand("decrClampQuota", {
	numberOfKeys: 1,
	lua: `
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
`,
});

redis.defineCommand("reserveMultipartPartQuota", {
	numberOfKeys: 2,
	lua: `
local quotaKey = KEYS[1]
local mpuKey = KEYS[2]
local partNumber = ARGV[1]
local partSize = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local seed = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local existingCredit = tonumber(redis.call('HGET', mpuKey, '__existingCredit') or '0')
local previousPartSize = tonumber(redis.call('HGET', mpuKey, partNumber) or '0')
local previousTotal = tonumber(redis.call('HGET', mpuKey, '__total') or '0')
local nextTotal = previousTotal - previousPartSize + partSize
if nextTotal < 0 then nextTotal = 0 end

local previousReserved = previousTotal - existingCredit
if previousReserved < 0 then previousReserved = 0 end
local nextReserved = nextTotal - existingCredit
if nextReserved < 0 then nextReserved = 0 end
local delta = nextReserved - previousReserved

if delta > 0 then
  local current = tonumber(redis.call('GET', quotaKey))
  if current == nil then
    current = seed
    redis.call('SET', quotaKey, current)
  end
  if (current + delta) > limit then
    return {0, current, previousTotal}
  end
  redis.call('INCRBY', quotaKey, delta)
elseif delta < 0 then
  local current = tonumber(redis.call('GET', quotaKey))
  if current ~= nil then
    local nextValue = current + delta
    if nextValue < 0 then nextValue = 0 end
    redis.call('SET', quotaKey, nextValue)
  end
end

redis.call('HSET', mpuKey, partNumber, partSize, '__total', nextTotal)
redis.call('EXPIRE', mpuKey, ttl)
return {1, nextReserved, nextTotal}
`,
});

redis.on("error", (err) => {
	console.error("Redis error:", err);
});

redis.on("connect", () => {
	console.log("Redis connected");
});
