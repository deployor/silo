const S3_DOMAIN = "localhost:3000"; // Simulating default
const dashboardPaths = [
	"/",
	"/auth/",
	"/api/dashboard/",
	"/dashboard/",
	"/docs",
	"/api/slack/",
	"/assets/",
	"/admin",
	"/api/admin",
	"/cdn",
	"/api/cdn/",
	"/onboarding",
	"/api/onboarding/",
	"/ysws",
	"/api/ysws",
];

function isDashboardRequest(urlStr: string, host: string): boolean {
	const url = new URL(urlStr);
	const path = url.pathname;

	// 1. Explicit dashboard subdomain
	if (host.startsWith("dashboard.")) {
		return true;
	}

	// 2. Host matches S3 domain (or localhost)
	if (
		host === S3_DOMAIN ||
		(S3_DOMAIN === "localhost:3000" && host.startsWith("localhost"))
	) {
		const hasAuthHeader = false; // Simulating no auth header
		const hasAmzParams = false; // Simulating no params

		// If it looks like an S3 request (Auth header or params), treat as S3
		if (hasAuthHeader || hasAmzParams) {
			return false;
		}

		// Exact match for root
		if (path === "/") return true;

		// Prefix match for others
		if (dashboardPaths.some((p) => p !== "/" && path.startsWith(p))) {
			return true;
		}

		// Default to S3 for unknown paths (public bucket access)
		return false;
	}

	return false;
}

console.log("Testing Routing Logic:");
console.log("----------------------");

const testCases = [
	{ url: "http://localhost:3000/", host: "localhost:3000", expected: true },
	{ url: "http://localhost:3000/ysws", host: "localhost:3000", expected: true },
	{
		url: "http://localhost:3000/ysws/",
		host: "localhost:3000",
		expected: true,
	},
	{
		url: "http://localhost:3000/admin/ysws",
		host: "localhost:3000",
		expected: true,
	},
	{
		url: "http://localhost:3000/my-bucket",
		host: "localhost:3000",
		expected: false,
	},
	{
		url: "http://ysws.localhost:3000/",
		host: "ysws.localhost:3000",
		expected: true,
	}, // Should be true if wildcard localhost
	{
		url: "http://other.localhost:3000/",
		host: "other.localhost:3000",
		expected: true,
	}, // Should be true if wildcard localhost??
	// Wait, if S3_DOMAIN is localhost:3000, then host.startsWith("localhost") covers ALL subdomains.
	// If it covers all subdomains, then isDashboardRequest checks the PATH.
	// If path is /, it returns true.
	// This implies locally, subdomains are treated as dashboard if path is /?
	// That seems wrong for buckets.
];

testCases.forEach((tc) => {
	const result = isDashboardRequest(tc.url, tc.host);
	console.log(
		`URL: ${tc.url} | Host: ${tc.host} | Expected: ${tc.expected} | Got: ${result} | ${result === tc.expected ? "PASS" : "FAIL"}`,
	);
});
