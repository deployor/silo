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

redis.on("error", (err) => {
	console.error("Redis error:", err);
});

redis.on("connect", () => {
	console.log("Redis connected");
});
