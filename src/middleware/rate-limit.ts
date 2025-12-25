import { errorResponse } from "../lib/api-utils";

interface RateLimitStore {
	count: number;
	resetTime: number;
}

const store = new Map<string, RateLimitStore>();

// Clean up expired entries every minute
setInterval(() => {
	const now = Date.now();
	for (const [key, value] of store.entries()) {
		if (now > value.resetTime) {
			store.delete(key);
		}
	}
}, 60000);

interface RateLimitOptions {
	limit: number; // Max requests
	windowMs: number; // Time window in milliseconds
}

export function rateLimit(options: RateLimitOptions) {
	return async (req: Request): Promise<Response | null> => {
		const ip = req.headers.get("x-forwarded-for") || "127.0.0.1";
		const now = Date.now();

		let record = store.get(ip);

		if (!record || now > record.resetTime) {
			record = {
				count: 0,
				resetTime: now + options.windowMs,
			};
			store.set(ip, record);
		}

		record.count++;

		const remaining = Math.max(0, options.limit - record.count);
		const reset = Math.ceil((record.resetTime - now) / 1000);

		// Add headers to the request so we can append them to the response later if needed
		// But we can't easily modify the response here if we return null.
		// We could attach them to the request object?
		// Or we just return them if we block.
		// For now, let's just block.

		if (record.count > options.limit) {
			const headers = new Headers();
			headers.set("X-RateLimit-Limit", options.limit.toString());
			headers.set("X-RateLimit-Remaining", "0");
			headers.set("X-RateLimit-Reset", reset.toString());
			headers.set("Retry-After", reset.toString());

			return errorResponse("Too Many Requests", 429, headers);
		}

		return null; // Continue
	};
}
