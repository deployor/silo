import { sql } from "drizzle-orm";
import { config } from "./config";
import { handleS3Request } from "./core/s3";
import { db } from "./db";
import { handleSlackRequest } from "./integrations/slack";
import { errorResponse } from "./lib/api-utils";
import { context } from "./lib/context";
import { getDiskCacheStats, stopPeriodicEviction } from "./lib/disk-cache";
import { redis } from "./lib/redis";
import { S3Errors } from "./lib/s3-errors";
import { validateOrigin } from "./lib/security";
import { render } from "./lib/view-engine";
import { authenticate } from "./middleware/auth";
import { compressResponse } from "./middleware/compression";
import { rateLimit } from "./middleware/rate-limit";
import { securityHeaders } from "./middleware/security-headers";
import { analyticsService } from "./services/analytics-service";
import { bucketUsageReconciliationService } from "./services/bucket-usage-reconciliation-service";
import { customDomainRevalidationService } from "./services/custom-domain-revalidation-service";
import { deepFreezeWorkerService } from "./services/deep-freeze-worker-service";
import { logService } from "./services/log-service";
import { statsService } from "./services/stats-service";
import { handleAdminRequest } from "./web/admin";
import { handleRevocationRequest } from "./web/api/revocation";
import { handleDashboardRequest } from "./web/dashboard";
import { handleGalleryRequest } from "./web/gallery";
import { handleRedeemRequest } from "./web/redemptions";
import { handleYswsRequest } from "./web/ysws";

const S3_DOMAIN = config.s3Domain;

// Rate Limiters
const apiLimiter = rateLimit({ limit: 300, windowMs: 60000 }); // 300 req/min for API
const authLimiter = rateLimit({ limit: 60, windowMs: 60000 }); // 60 req/min for Auth

// S3 should be more tolerant and independent from dashboard/API.
// Defaults are intentionally high; override via env for different tiers.
const s3Limiter = rateLimit({
	limit: Number(process.env.S3_RATE_LIMIT_PER_MIN ?? "1000000"),
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
	const accept = req.headers.get("accept") || "";
	const hasAuthHeader = req.headers.has("authorization");
	const hasAmzParams =
		url.searchParams.has("X-Amz-Algorithm") ||
		url.searchParams.has("x-amz-algorithm");
	const isBrowserNavigation =
		req.method === "GET" && accept.includes("text/html");
	const isDashboardHost =
		host === S3_DOMAIN ||
		host.startsWith("dashboard.") ||
		(S3_DOMAIN === "localhost:3000" && host.startsWith("localhost"));

	const path = url.pathname;
	const dashboardPaths = [
		"/",
		"/auth/",
		"/api/dashboard/",
		"/dashboard",
		"/dashboard/",
		"/docs",
		"/account",
		"/account/",
		"/api/slack/",
		"/assets/",
		"/admin",
		"/api/admin",
		"/onboarding",
		"/api/onboarding/",
		"/ysws",
		"/api/ysws",
		"/gallery",
		"/redeem",
		"/api/revocation",
		"/health",
		"/slack-success",
	];

	// 1. Explicit dashboard subdomain
	if (host.startsWith("dashboard.")) {
		return true;
	}

	// 2. Host matches S3 domain (or localhost)
	if (
		host === S3_DOMAIN ||
		(S3_DOMAIN === "localhost:3000" && host.startsWith("localhost"))
	) {
		// Exact match for root
		if (path === "/") return true;

		// Prefix match for others
		if (dashboardPaths.some((p) => p !== "/" && path.startsWith(p))) {
			return true;
		}

		// If it looks like an S3 request (Auth header or params), treat as S3
		if (hasAuthHeader || hasAmzParams) {
			return false;
		}

		// Default to S3 for unknown paths (public bucket access)
		return false;
	}

	// 3. Local/dev fallback: treat normal browser navigation to known dashboard
	// routes as dashboard even when host doesn't match configured S3 domain.
	if (!hasAuthHeader && !hasAmzParams && isBrowserNavigation && isDashboardHost) {
		if (path === "/") return true;
		if (dashboardPaths.some((p) => p !== "/" && path.startsWith(p))) {
			return true;
		}
	}

	return false;
}

const server = Bun.serve({
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
					// Health check — no rate limiting, no auth
					if (url.pathname === "/health") {
						try {
							const checks: Record<string, string> = {};
							let healthy = true;

							// Redis check
							try {
								await redis.ping();
								checks.redis = "connected";
							} catch {
								checks.redis = "disconnected";
								healthy = false;
							}

							// Postgres check
							try {
								await db.execute(sql`SELECT 1`);
								checks.postgres = "connected";
							} catch {
								checks.postgres = "disconnected";
								healthy = false;
							}

							// Disk cache stats
							const diskStats = getDiskCacheStats();

							const body = {
								status: healthy ? "ok" : "degraded",
								uptime: Math.floor(process.uptime()),
								...checks,
								diskCache: {
									entries: diskStats.entryCount,
									usedBytes: diskStats.totalSizeBytes,
									budgetBytes: diskStats.maxTotalSizeBytes,
								},
								version: config.git?.shortSha || "unknown",
							};

							return new Response(JSON.stringify(body, null, 2), {
								status: healthy ? 200 : 503,
								headers: { "Content-Type": "application/json" },
							});
						} catch {
							return new Response(JSON.stringify({ status: "error" }), {
								status: 503,
								headers: { "Content-Type": "application/json" },
							});
						}
					}

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

					// Compress compressible S3 GET responses
					if (req.method === "GET" && response.ok) {
						response = await compressResponse(req, response);
					}
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

				const isS3 = !isDashboardRequest(req, url);
				return securityHeaders(req, response, isS3);
			},
		);
	},
});

console.log(`Silo S3 Gateway running on port ${process.env.PORT || 3000}`);
deepFreezeWorkerService.start();
bucketUsageReconciliationService.start();
customDomainRevalidationService.start();

let shuttingDown = false;

async function gracefulShutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`\n${signal} received — starting graceful shutdown...`);

	// 1. Stop accepting new connections
	server.stop();
	console.log("Stopped accepting new connections");

	// 2. Wait a beat for in-flight requests to complete
	await new Promise((resolve) => setTimeout(resolve, 2000));

	// 3. Flush pending work
	try {
		console.log("Flushing stats to database...");
		await statsService.shutdown();
	} catch (e) {
		console.error("Stats flush error:", e);
	}

	try {
		console.log("Flushing log queue...");
		await logService.shutdown();
	} catch (e) {
		console.error("Log flush error:", e);
	}

	try {
		console.log("Flushing analytics queues...");
		await analyticsService.shutdown();
	} catch (e) {
		console.error("Analytics flush error:", e);
	}

	// 4. Stop background timers
	deepFreezeWorkerService.stop();
	bucketUsageReconciliationService.stop();
	customDomainRevalidationService.stop();
	stopPeriodicEviction();

	// 5. Close connections
	try {
		await redis.quit();
		console.log("Redis disconnected");
	} catch (e) {
		console.error("Redis disconnect error:", e);
	}

	console.log("Graceful shutdown complete");
	process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
