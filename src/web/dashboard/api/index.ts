import { and, eq, sql } from "drizzle-orm";
import { config } from "../../../config";
import { db } from "../../../db";
import { buckets, sessions, users } from "../../../db/schema";
import { errorResponse, jsonResponse, parseCookies } from "../../../lib/api-utils";
import { getCurrentUser } from "../../../lib/session";
import { deepFreezeActionSchema } from "../../../lib/validation";
import { deleteBucket } from "../../../services/bucket-service";
import { getBucketsForUser } from "../../../services/bucket-service";
import {
	getDeepFreezeSnapshot,
	requestBucketDeepFreezeAction,
} from "../../../services/deep-freeze-service";
import { getAppSettings } from "../../../services/settings-service";
import { handleBucketOperations, handleBuckets } from "./buckets";
import { handleCollaboration } from "./collaboration";
import { handleCors } from "./cors";
import { handleFiles } from "./files";
import { handleKeys } from "./keys";
import { handleTakedownReport } from "./takedown";

export async function handleApiRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	if (path === "/api/docs/takedown") {
		return handleTakedownReport(req);
	}

	if (path === "/api/onboarding/complete" && req.method === "POST") {
		const user = await getCurrentUser(req);
		if (!user) return errorResponse("Unauthorized", 401);

		await db
			.update(users)
			.set({ onboarded: true })
			.where(eq(users.id, user.id));

		const headers = new Headers();
		headers.set("Location", "/");
		return new Response(null, { status: 302, headers });
	}

	if (path.startsWith("/api/dashboard/")) {
		const user = await getCurrentUser(req);
		if (!user) return errorResponse("Unauthorized", 401);

		if (user.isLocked) {
			return errorResponse("Account Locked", 403);
		}

		if (path === "/api/dashboard/stats") {
			const bucketsWithKeys = await getBucketsForUser(user.id);

			const settings = await getAppSettings();
			const responseData = {
				user: {
					id: user.id,
					slackId: user.slackId,
					storageUsage: Number(user.storageUsageBytes) || 0,
					storageLimit:
						Number(user.storageLimitBytes) || settings.defaultStorageLimitBytes,
					egressLimit:
						user.egressLimitBytes !== null
							? Number(user.egressLimitBytes)
							: null,
					ingressBytes: Number(user.ingressBytes) || 0,
					egressBytes: Number(user.egressBytes) || 0,
					totalBytes:
						(Number(user.ingressBytes) || 0) + (Number(user.egressBytes) || 0),
					totalRequests: Number(user.totalRequests) || 0,
					isAdmin: user.isAdmin,
					isImmortal: user.isImmortal,
				},
				limits: {
					maxBucketsPerUser: user.isImmortal
						? -1
						: settings.defaultMaxBucketsPerUser,
					maxKeysPerBucket: user.isImmortal
						? -1
						: settings.defaultMaxKeysPerBucket,
					defaultStorageLimitBytes: settings.defaultStorageLimitBytes,
					egressMultiplier: settings.egressMultiplier,
					minEgressBytes: settings.minEgressBytes,
				},
				buckets: bucketsWithKeys.map((b) => ({
					name: b.name,
					keys: b.keys,
					createdAt: b.createdAt,
					totalBytes: Number(b.totalBytes) || 0,
					totalRequests: Number(b.totalRequests) || 0,
					isPublic: b.isPublic,
					isPaused: b.isPaused,
					pauseReason: b.pauseReason,
					deepFreeze: config.deepFreezeEnabled
						? getDeepFreezeSnapshot(b as never)
						: null,
					corsConfig: b.corsConfig,
					isCollaborative: (b as { isCollaborative?: boolean }).isCollaborative,
					collaborationPermissions: (
						b as {
							collaborationPermissions?: string[] | null;
						}
					).collaborationPermissions,
					collaborators: (b as { collaborators?: unknown[] }).collaborators,
					customDomains: (b as { customDomains?: unknown[] }).customDomains || [],
				})),
			};

			return jsonResponse(responseData);
		}

		if (path === "/api/dashboard/account/sessions") {
			if (req.method === "GET") {
				const cookieSessionId = parseCookies(req.headers.get("Cookie")).silo_session;
				const rows = await db
					.select()
					.from(sessions)
					.where(eq(sessions.userId, user.id));
				const sorted = rows.sort(
					(a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
				);
				return jsonResponse({
					sessions: sorted.map((session) => ({
						id: session.id,
						createdAt: session.createdAt?.toISOString() || new Date().toISOString(),
						expiresAt: session.expiresAt.toISOString(),
						isCurrent: session.id === cookieSessionId,
						userAgent: session.userAgent || "Unknown device",
						ipAddress: session.ipAddress || null,
						lastActiveLabel: session.createdAt
							? new Date(session.createdAt).toLocaleString()
							: "Unknown",
					})),
				});
			}

			if (req.method === "DELETE") {
				const body = await req.json().catch(() => null);
				const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
				if (!sessionId) return errorResponse("Session ID is required", 400);
				await db
					.delete(sessions)
					.where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)));
				const currentSessionId = parseCookies(req.headers.get("Cookie")).silo_session;
				return jsonResponse({ signedOutCurrent: currentSessionId === sessionId });
			}
		}

		if (path === "/api/dashboard/account/sign-out-everywhere") {
			if (req.method !== "POST") return errorResponse("Method not allowed", 405);
			await db.delete(sessions).where(eq(sessions.userId, user.id));
			return jsonResponse({ ok: true });
		}

		if (path === "/api/dashboard/account/delete") {
			if (req.method !== "POST") return errorResponse("Method not allowed", 405);
			const ownedBuckets = await db
				.select({ name: buckets.name })
				.from(buckets)
				.where(eq(buckets.userId, user.id));
			for (const bucket of ownedBuckets) {
				await deleteBucket(bucket.name, user.id, user.isAdmin);
			}
			await db.delete(sessions).where(eq(sessions.userId, user.id));
			await db.delete(users).where(eq(users.id, user.id));
			const response = jsonResponse({ ok: true }, 200);
			response.headers.append(
				"Set-Cookie",
				`silo_session=; Path=/; HttpOnly; SameSite=Lax${config.isProduction ? "; Secure" : ""}; Max-Age=0`,
			);
			response.headers.append(
				"Set-Cookie",
				`silo_impersonating=; Path=/; SameSite=Lax${config.isProduction ? "; Secure" : ""}; Max-Age=0`,
			);
			return response;
		}

		if (path === "/api/dashboard/buckets") {
			return handleBuckets(req);
		}

		if (path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+\/domains$/)) {
			return handleBucketOperations(req);
		}

		if (path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+$/)) {
			return handleBucketOperations(req);
		}

		if (path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+\/keys/)) {
			return handleKeys(req);
		}

		if (
			path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+\/collaborators/) ||
			path.startsWith("/api/dashboard/collaboration/")
		) {
			return handleCollaboration(req);
		}

		if (path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+\/files/)) {
			return handleFiles(req);
		}

		if (path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+\/deep-freeze$/)) {
			if (!config.deepFreezeEnabled) {
				return errorResponse("Deep Freeze is currently disabled", 404);
			}
			if (req.method !== "POST") {
				return errorResponse("Method not allowed", 405);
			}
			const bucketName = path.split("/")[4];
			if (!bucketName) {
				return errorResponse("Invalid bucket name", 400);
			}
			if (user.dataExported) {
				return errorResponse(
					"Account is frozen. Deep Freeze actions are not available.",
					403,
				);
			}
			try {
				const body = await req.json();
				const parsed = deepFreezeActionSchema.safeParse(body);
				if (!parsed.success) {
					return errorResponse(
						parsed.error.issues[0]?.message || "Invalid request",
						400,
					);
				}
				const snapshot = await requestBucketDeepFreezeAction({
					bucketName,
					userId: user.id,
					action: parsed.data.action,
					isAdmin: user.isAdmin,
				});
				return jsonResponse({
					message:
						parsed.data.action === "freeze"
							? "Deep Freeze started"
							: "Bucket restore started",
					deepFreeze: snapshot,
				});
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Internal Error";
				return errorResponse(message, 500);
			}
		}

		if (path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+\/cors$/)) {
			return handleCors(req);
		}
	}

	return errorResponse("Not Found", 404);
}
