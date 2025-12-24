import { config } from "./config";
import { handleAdminRequest } from "./features/admin";
import { handleDashboardRequest, slackSuccessTemplate } from "./features/landing";
import { handleS3Request } from "./features/s3-api";
import { updateStats } from "./features/s3-api/utils";
import { handleSlackRequest } from "./features/slack";
import { authenticate } from "./middleware/auth";

const S3_DOMAIN = config.s3Domain;

Bun.serve({
	port: process.env.PORT || 3000,
	maxRequestBodySize: 1024 * 1024 * 1024, // 1GB
	async fetch(req) {
		const url = new URL(req.url);
		const host = req.headers.get("host") || "";

		let isDashboard = false;

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
				isDashboard = false;
			} else {
				// Otherwise, check if it matches dashboard paths
				if (
					path === "/" ||
					path.startsWith("/auth/") ||
					path.startsWith("/api/dashboard/") ||
					path.startsWith("/dashboard/") ||
					path.startsWith("/docs") ||
					path.startsWith("/api/slack/") ||
					path.startsWith("/assets/") ||
					path.startsWith("/admin") ||
					path.startsWith("/api/admin") ||
					path.startsWith("/cdn") ||
					path.startsWith("/api/cdn/")
				) {
					isDashboard = true;
				} else {
					// If it's not a known dashboard path and has no auth,
					// it might be an unauthenticated S3 request (which will fail auth)
					// OR a static asset for dashboard (if we had any).
					// For now, default to S3 to let auth middleware handle the denial.
					isDashboard = false;
				}
			}
		} else if (host.startsWith("dashboard.")) {
			// Explicit dashboard subdomain support
			isDashboard = true;
		} else {
			isDashboard = false;
		}

		if (isDashboard) {
			if (url.pathname.startsWith("/admin") || url.pathname.startsWith("/api/admin")) {
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

		const forbiddenParams = [
			"policy",
			"acl",
			// "cors", // Allowed
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
				return new Response(
					`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>NotImplemented</Code>
    <Message>A header you provided implies functionality that is not implemented</Message>
    <RequestId>0000000000000000</RequestId>
</Error>`,
					{ status: 501, headers: { "Content-Type": "application/xml" } },
				);
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

			// Fire and forget stats update to not block response
			updateStats(user, bucket, req, response, mode, duration).catch((err) => {
				console.error("Error updating stats:", err);
			});

			return response;
		} catch (e) {
			console.error("S3 Request Error:", e);
			return new Response("Internal Server Error", { status: 500 });
		}
	},
});

console.log(`Silo S3 Gateway running on port ${process.env.PORT || 3000}`);
