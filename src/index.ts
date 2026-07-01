import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { config } from "./config";
import { db } from "./db";
import { handleSlackRequest } from "./integrations/slack";
import { errorResponse } from "./lib/api-utils";
import { context } from "./lib/context";
import { getDiskCacheStats } from "./lib/disk-cache";
import { redis } from "./lib/redis";
import { validateOrigin } from "./lib/security";
import { render } from "./lib/view-engine";
import { rateLimit } from "./middleware/rate-limit";
import { securityHeaders } from "./middleware/security-headers";
import { bucketUsageReconciliationService } from "./services/bucket-usage-reconciliation-service";
import { customDomainRevalidationService } from "./services/custom-domain-revalidation-service";
import { deepFreezeWorkerService } from "./services/deep-freeze-worker-service";
import { logService } from "./services/log-service";
import { statsService } from "./services/stats-service";
import { handleAdminRequest } from "./web/admin";
import { handleRevocationRequest } from "./web/api/revocation";
import { handleYswsApiRequest } from "./web/api/ysws";
import { handleDashboardRequest } from "./web/dashboard";
import { handleRedeemRequest } from "./web/redemptions";

const S3_DOMAIN = config.s3Domain;
const DASHBOARD_HOST = config.dashboardDomain;

const dashboardPaths = [
	"/auth/",
	"/api/dashboard/",
	"/dashboard",
	"/dashboard/",
	"/docs",
	"/account",
	"/api/docs/takedown",
	"/account/",
	"/api/slack/",
	"/api/ysws/",
	"/assets/",
	"/admin",
	"/api/admin",
	"/onboarding",
	"/api/onboarding/",
	"/redeem",
	"/api/revocation",
	"/health",
	"/slack-success",
];

const apexPublicDashboardPaths = new Set([
	"/",
	"/health",
	"/api/slack/events",
	"/api/revocation",
]);

// Rate Limiters
const apiLimiter = rateLimit({ limit: 300, windowMs: 60000 }); // 300 req/min for API
const authLimiter = rateLimit({ limit: 60, windowMs: 60000 }); // 60 req/min for Auth

function dashboardUrl(url: URL): string {
	const target = new URL(url.pathname + url.search, config.dashboardUrl);
	return target.toString();
}

function isApexDashboardPath(path: string): boolean {
	if (path.startsWith("/assets/")) return false;
	return (
		!apexPublicDashboardPaths.has(path) &&
		dashboardPaths.some((p) => path.startsWith(p))
	);
}

function s3DataplaneOnlyResponse() {
	return new Response(
		'<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>MisdirectedRequest</Code><Message>S3 requests must be routed to the Rust data plane.</Message></Error>',
		{
			status: 421,
			headers: {
				"content-type": "application/xml",
				"x-content-type-options": "nosniff",
			},
		},
	);
}

async function healthResponse() {
	try {
		const checks: Record<string, string> = {};
		let healthy = true;

		try {
			await redis.ping();
			checks.redis = "connected";
		} catch {
			checks.redis = "disconnected";
			healthy = false;
		}

		try {
			await db.execute(sql`SELECT 1`);
			checks.postgres = "connected";
		} catch {
			checks.postgres = "disconnected";
			healthy = false;
		}

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
		host === DASHBOARD_HOST ||
		(S3_DOMAIN === "localhost:3000" && host.startsWith("localhost"));

	const path = url.pathname;

	if (path.startsWith("/api/internal/dataplane/")) {
		return true;
	}

	// 1. Explicit dashboard subdomain
	if (host === DASHBOARD_HOST && DASHBOARD_HOST !== S3_DOMAIN) {
		return true;
	}

	// 2. Apex only serves the public landing page from the dashboard app. All
	// authenticated dashboard routes live on dashboard.<domain> so uploaded public
	// objects never share the dashboard cookie origin.
	if (host === S3_DOMAIN) {
		if (DASHBOARD_HOST === S3_DOMAIN) {
			if (path === "/") return true;
			if (dashboardPaths.some((p) => path.startsWith(p))) return true;
			if (hasAuthHeader || hasAmzParams) return false;
			return false;
		}
		if (hasAuthHeader || hasAmzParams) return false;
		return apexPublicDashboardPaths.has(path) || path.startsWith("/assets/");
	}

	// 3. Local/dev fallback: treat normal browser navigation to known dashboard
	// routes as dashboard even when host doesn't match configured S3 domain.
	if (
		!hasAuthHeader &&
		!hasAmzParams &&
		isBrowserNavigation &&
		isDashboardHost
	) {
		if (path === "/") return true;
		if (dashboardPaths.some((p) => p !== "/" && path.startsWith(p))) {
			return true;
		}
	}

	return false;
}

await migrate(db, { migrationsFolder: "./drizzle" });

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
				const host = req.headers.get("host") || "";

				if (url.pathname === "/health") {
					return healthResponse();
				}

				if (
					host === S3_DOMAIN &&
					DASHBOARD_HOST !== S3_DOMAIN &&
					isApexDashboardPath(url.pathname)
				) {
					return Response.redirect(dashboardUrl(url), 302);
				}

				const isDashboard = isDashboardRequest(req, url);

				if (isDashboard) {
					if (host === S3_DOMAIN && url.pathname === "/") {
						const html = await render("landing", {
							title: "Silo S3 Gateway",
							layout: "main",
							hideNavLinks: true,
							mainClass: "flex flex-col items-center justify-center",
						});
						response = new Response(html, {
							headers: { "Content-Type": "text/html" },
						});
						return securityHeaders(req, response, false);
					}

					// Rate Limiting (skip dataplane authorize — internal service traffic)
					if (
						url.pathname.startsWith("/api/") &&
						!url.pathname.startsWith("/api/internal/dataplane/")
					) {
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
						!url.pathname.startsWith("/api/internal/dataplane/") &&
						!url.pathname.startsWith("/api/slack/") &&
						!url.pathname.startsWith("/api/ysws/") &&
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
					} else if (url.pathname.startsWith("/redeem")) {
						response = await handleRedeemRequest(req);
					} else if (url.pathname === "/api/slack/events") {
						response = await handleSlackRequest(req);
					} else if (url.pathname.startsWith("/api/ysws/")) {
						response = await handleYswsApiRequest(req);
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
					response = s3DataplaneOnlyResponse();
				}

				// Post-request logging and stats
				// We only log if we have a user context (authenticated requests).
				// Under heavy S3 throughput testing, DB writes can become a bottleneck.
				// Allow disabling via env (best for perf/bench environments).
				const ctx = context.getStore();
				const disableS3Stats = (process.env.DISABLE_S3_STATS ?? "0") === "1";
				if (
					ctx?.user &&
					!ctx.isOffboardingExport &&
					!(ctx.path.startsWith("/") && disableS3Stats)
				) {
					const isS3Request = !isDashboard;
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

				const isS3 = !isDashboard;
				return securityHeaders(req, response, isS3);
			},
		);
	},
});

console.log(`Silo S3 Gateway running on port ${process.env.PORT || 3000}`);
if (config.deepFreezeEnabled) {
	deepFreezeWorkerService.start();
}
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

	// 4. Stop background timers
	if (config.deepFreezeEnabled) {
		deepFreezeWorkerService.stop();
	}
	bucketUsageReconciliationService.stop();
	customDomainRevalidationService.stop();

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
