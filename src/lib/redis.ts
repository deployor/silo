import Redis from "ioredis";
import { config } from "../config";

export const redis = new Redis(config.redisUrl, {
	maxRetriesPerRequest: null,
	enableReadyCheck: false,
});

redis.on("error", (err) => {
	console.error("Redis error:", err);
});

redis.on("connect", () => {
	console.log("Redis connected");
});
