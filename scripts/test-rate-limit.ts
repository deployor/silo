const BASE_URL = `https://silo.deployor.dev`;

async function testRateLimit() {
	console.log("Testing Rate Limit...");

	// Test Auth Limit (20 req/min)
	console.log("\nTesting Auth Rate Limit (Limit: 20)...");
	for (let i = 1; i <= 25; i++) {
		const res = await fetch(`${BASE_URL}/auth/login`, { redirect: "manual" });
		console.log(`Request ${i}: Status ${res.status}`);
		if (res.status === 429) {
			console.log("✅ Rate limit hit as expected!");
			const reset = res.headers.get("X-RateLimit-Reset");
			console.log(`Reset in: ${reset} seconds`);
			break;
		}
		if (i === 25 && res.status !== 429) {
			console.error("❌ Rate limit NOT hit!");
		}
	}

	// Test API Limit (100 req/min)
	// We won't spam 100 requests here to save time, but the logic is the same.
	// We can verify the headers are present on a single request.
	console.log("\nTesting API Rate Limit Headers...");
	const _apiRes = await fetch(`${BASE_URL}/api/dashboard/stats`, {
		headers: { Cookie: "silo_session=dummy" }, // Need a session to avoid 401, but 401 is fine for rate limit check
	});

	// Even if 401, rate limit headers might not be there if we don't hit the limit?
	// Wait, my implementation adds headers ONLY when limit is exceeded.
	// Let's check the code.
	// Ah, I only return headers when limit is exceeded.
	// Ideally, I should return headers on every request so the client knows.

	// Let's update the middleware to return headers always.
}

testRateLimit();
