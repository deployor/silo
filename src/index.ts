import { config } from "./config";
import { handleS3Request } from "./core/s3";
import { updateStats } from "./core/s3/utils";
import { handleSlackRequest } from "./integrations/slack";
import { handleAdminRequest } from "./web/admin";
import { handleDashboardRequest, slackSuccessTemplate } from "./web/dashboard";
import { S3Errors } from "./lib/s3-errors";
import { authenticate } from "./middleware/auth";

const S3_DOMAIN = config.s3Domain;

// Helper to determine if a request is for the dashboard or S3
function isDashboardRequest(req: Request, url: URL): boolean {
	const host = req.headers.get("host") || "";

	// Explicit dashboard subdomain
	if (host.startsWith("dashboard.")) {
		return true;
	}

	// If host matches S3 domain (or localhost), check path and auth
	if (
		host === S3_DOMAIN ||
		(S3_DOMAIN === "localhost:3000" && host.startsWith("localhost"))
	) {
		const path = url.pathname;
		const hasAuthHeader = req.headers.has("authorization");
		const hasAmzParams =
			url.searchParams.has("X-Amz-Algorithm") ||
			url.searchParams.has("x-amz-algorithm");

		// If it looks like an S3 request (Auth header or params), treat as S3
		if (hasAuthHeader || hasAmzParams) {
			return false;
		}

		// Known dashboard paths
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
		];

		if (dashboardPaths.some((p) => path.startsWith(p))) {
			return true;
		}
	}

	return false;
}

Bun.serve({
	port: process.env.PORT || 3000,
	maxRequestBodySize: 1024 * 1024 * 1024, // 1GB
	async fetch(req) {
		const url = new URL(req.url);

		if (isDashboardRequest(req, url)) {
			if (
				url.pathname.startsWith("/admin") ||
				url.pathname.startsWith("/api/admin")
			) {
				return handleAdminRequest(req);
			}
			if (url.pathname === "/api/slack/events") {
				return handleSlackRequest(req);
			}
			if (url.pathname.startsWith("/assets/")) {
				const filePath = `src${url.pathname}`;
				const file = Bun.file(filePath);
				if (await file.exists()) {
					return new Response(file, {
						headers: {
							"Content-Type": file.type,
							"Cache-Control": "public, max-age=31536000",
						},
					});
				}
			}
			if (url.pathname === "/slack-success") {
				return new Response(slackSuccessTemplate, {
					headers: { "Content-Type": "text/html" },
				});
			}
			return handleDashboardRequest(req);
		}

		// S3 Request Handling
		const forbiddenParams = [
			"policy",
			"acl",
			"lifecycle",
			"replication",
			"tagging",
			"encryption",
			"website",
			"logging",
			"accelerate",
			"payment",
			"object-lock",
			"versioning",
			"versions",
		];

		for (const param of forbiddenParams) {
			if (url.searchParams.has(param)) {
				return S3Errors.NotImplemented().toResponse();
			}
		}

		try {
			const authResult = await authenticate(req);

			if (authResult instanceof Response) {
				return authResult;
			}

			const { user, bucket, mode } = authResult;
			const start = performance.now();
			const response = await handleS3Request(req, user, bucket, mode);
			const duration = Math.round(performance.now() - start);

			// Fire and forget stats update
			updateStats(user, bucket, req, response, mode, duration).catch((err) => {
				console.error("Error updating stats:", err);
			});

			return response;
		} catch (e) {
			console.error("S3 Request Error:", e);
			return S3Errors.InternalError().toResponse();
		}
	},
});

console.log(`Silo S3 Gateway running on port ${process.env.PORT || 3000}`);
