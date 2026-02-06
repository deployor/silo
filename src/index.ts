import { config } from "./config";
import { handleS3Request } from "./core/s3";
import { handleSlackRequest } from "./integrations/slack";
import { errorResponse } from "./lib/api-utils";
import { context } from "./lib/context";
import { S3Errors } from "./lib/s3-errors";
import { validateOrigin } from "./lib/security";
import { render } from "./lib/view-engine";
import { authenticate } from "./middleware/auth";
import { rateLimit } from "./middleware/rate-limit";
import { securityHeaders } from "./middleware/security-headers";
import { logService } from "./services/log-service";
import { statsService } from "./services/stats-service";
import { handleAdminRequest } from "./web/admin";
import { handleDashboardRequest } from "./web/dashboard";
import { handleRedeemRequest } from "./web/redemptions";
import { handleYswsRequest } from "./web/ysws";
import { handleGalleryRequest } from "./web/gallery";
import { handleRevocationRequest } from "./web/api/revocation";

const S3_DOMAIN = config.s3Domain;

// Rate Limiters
const apiLimiter = rateLimit({ limit: 300, windowMs: 60000 }); // 300 req/min for API
const authLimiter = rateLimit({ limit: 60, windowMs: 60000 }); // 60 req/min for Auth

// S3 should be more tolerant and independent from dashboard/API.
// Defaults are intentionally high; override via env for different tiers.
const s3Limiter = rateLimit({
	limit: Number(process.env.S3_RATE_LIMIT_PER_MIN ?? "20000"),
	windowMs: 60000,
});

/**
 * Determines if a request is intended for the dashboard or the S3 gateway.
 *
 * Logic:
 * 1. If the host starts with "dashboard.", it's a dashboard request.
 * 2. If the host matches the S3 domain (or localhost):
 *    - If the request has S3 auth headers or params, it's an S3 request.
 *    - If the path matches known dashboard routes, it's a dashboard request.
 *    - Otherwise, it's treated as a public bucket access (S3 request).
 */
function isDashboardRequest(req: Request, url: URL): boolean {
	const host = req.headers.get("host") || "";

	// 1. Explicit dashboard subdomain
	if (host.startsWith("dashboard.")) {
		return true;
	}

	// 2. Host matches S3 domain (or localhost)
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
			"/ysws",
			"/api/ysws",
			"/gallery",
			"/redeem",
			"/api/revocation",
		];

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

Bun.serve({
	port: process.env.PORT || 3000,
	maxRequestBodySize: 1024 * 1024 * 1024, // 1GB
	async fetch(req) {
		const url = new URL(req.url);
		const requestId = crypto.randomUUID();
		const startTime = performance.now();

		return context.run(
			{
				requestId,
				startTime,
				ip:
					req.headers.get("x-forwarded-for") ||
					req.headers.get("cf-connecting-ip") ||
					"unknown",
				userAgent: req.headers.get("user-agent"),
				method: req.method,
				path: url.pathname,
			},
			async () => {
				let response: Response = new Response("Internal Error", {
					status: 500,
				});

				if (isDashboardRequest(req, url)) {
					// Rate Limiting
					if (url.pathname.startsWith("/api/")) {
						const limitRes = await apiLimiter(req);
						if (limitRes) return limitRes;
					}
					if (url.pathname.startsWith("/auth/")) {
						const limitRes = await authLimiter(req);
						if (limitRes) return limitRes;
					}

					// Global Security Check for API routes (except Slack events which are verified by signature)
					if (
						url.pathname.startsWith("/api/") &&
						!url.pathname.startsWith("/api/slack/") &&
						!url.pathname.startsWith("/api/revocation") &&
						req.method !== "GET" &&
						req.method !== "HEAD"
					) {
						if (!validateOrigin(req)) {
							return errorResponse("Invalid Origin", 403);
						}
					}

					if (
						url.pathname.startsWith("/admin") ||
						url.pathname.startsWith("/api/admin")
					) {
						response = await handleAdminRequest(req);
					} else if (url.pathname.startsWith("/ysws")) {
						response = await handleYswsRequest(req);
					} else if (url.pathname.startsWith("/gallery")) {
						response = await handleGalleryRequest(req);
					} else if (url.pathname.startsWith("/redeem")) {
						response = await handleRedeemRequest(req);
					} else if (url.pathname === "/api/slack/events") {
						response = await handleSlackRequest(req);
					} else if (url.pathname.startsWith("/assets/")) {
						const filePath = `src${url.pathname}`;
						const file = Bun.file(filePath);
						if (await file.exists()) {
							response = new Response(file, {
								headers: {
									"Content-Type": file.type,
									"Cache-Control": "public, max-age=31536000",
								},
							});
						} else {
							response = new Response("Not Found", { status: 404 });
						}
					} else if (url.pathname === "/slack-success") {
						const html = await render("slack-success", {
							title: "Silo - Account Linked",
							layout: "blank",
						});
						response = new Response(html, {
							headers: { "Content-Type": "text/html" },
						});
					} else if (url.pathname === "/api/revocation") {
						response = await handleRevocationRequest(req);
					} else {
						response = await handleDashboardRequest(req);
					}
				} else {
					// S3 Rate Limiting
					const limitRes = await s3Limiter(req);
					if (limitRes) return limitRes;

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

					let forbidden = false;
					for (const param of forbiddenParams) {
						if (url.searchParams.has(param)) {
							response = S3Errors.NotImplemented().toResponse();
							forbidden = true;
							break;
						}
					}

					if (!forbidden) {
						try {
							const authResult = await authenticate(req);

							if (authResult instanceof Response) {
								response = authResult;
							} else {
								const { user, bucket, mode } = authResult;
								// Populate context with auth info
								const ctx = context.getStore();
								if (ctx) {
									ctx.user = user || undefined;
									ctx.bucket = bucket;
									ctx.mode = mode;
								}

								response = await handleS3Request(req, user, bucket, mode);
							}
						} catch (e) {
							console.error("S3 Request Error:", e);
							response = S3Errors.InternalError().toResponse();
						}
					}

					if (!response) response = S3Errors.InternalError().toResponse();
				}

				// Post-request logging and stats
				// We only log if we have a user context (authenticated requests).
				// Under heavy S3 throughput testing, DB writes can become a bottleneck.
				// Allow disabling via env (best for perf/bench environments).
				const ctx = context.getStore();
				const disableS3Stats = (process.env.DISABLE_S3_STATS ?? "0") === "1";
				if (ctx?.user && !(ctx.path.startsWith("/") && disableS3Stats)) {
					const isS3Request = !isDashboardRequest(req, url);
					if (!(disableS3Stats && isS3Request)) {
						// For PUT requests, we might have already logged ingress in the handler
						// But for general stats, we do it here.
						// Note: Ingress for PUT is tricky because the body stream is consumed.
						// We rely on the handler to have updated the DB for storage usage,
						// but for traffic stats we can try to use Content-Length.
						const ingress = parseInt(
							req.headers.get("content-length") || "0",
							10,
						);
						const egress = parseInt(
							response.headers.get("content-length") || "0",
							10,
						);

						// Fire and forget
						Promise.all([
							logService.logRequest(response, ingress),
							statsService.recordUsage(ingress, egress),
						]).catch((err) => {
							console.error("Error updating stats/logs:", err);
						});
					}
				}

				return securityHeaders(req, response);
			},
		);
	},
});

console.log(`Silo S3 Gateway running on port ${process.env.PORT || 3000}`);
