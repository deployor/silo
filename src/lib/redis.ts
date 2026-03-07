import Redis from "ioredis";
import { config } from "../config";

/** Max Redis memory budget (default 10 GB). Override via REDIS_MAX_MEMORY env var. */
const REDIS_MAX_MEMORY = process.env.REDIS_MAX_MEMORY || "10gb";

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

	// Configure Redis memory limit and eviction policy.
	// allkeys-lru: when memory is full, evict least-recently-used keys first.
	// This prevents Redis from growing unbounded with cached S3 objects.
	redis
		.config("SET", "maxmemory", REDIS_MAX_MEMORY)
		.then(() => redis.config("SET", "maxmemory-policy", "allkeys-lru"))
		.then(() => {
			console.log(
				`Redis maxmemory set to ${REDIS_MAX_MEMORY} with allkeys-lru eviction`,
			);
		})
		.catch((err) => {
			// Some managed Redis services (e.g., Redis Cloud) don't allow CONFIG SET.
			// That's fine — the operator should set it server-side instead.
			console.warn(
				"Could not set Redis maxmemory (managed service?). Ensure maxmemory is configured server-side:",
				err.message,
			);
		});
});
