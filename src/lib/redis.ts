import Redis from "ioredis";
import { config } from "../config";

/** Max Redis memory budget (default 10 GB). Override via REDIS_MAX_MEMORY env var. */
const REDIS_MAX_MEMORY = process.env.REDIS_MAX_MEMORY || "10gb";

export const redis = new Redis(config.redisUrl, {
	maxRetriesPerRequest: null,
	enableReadyCheck: false,
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
