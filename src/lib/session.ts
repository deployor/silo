import { and, eq, gt, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { buckets, sessions, users } from "../db/schema";
import { getAppSettings } from "../services/settings-service";
import { parseCookies } from "./api-utils";
import { context } from "./context";

export async function getCurrentUser(req: Request) {
	const cookies = parseCookies(req.headers.get("Cookie"));

	if (cookies.silo_session) {
		const sessionResult = await db
			.select({
				user: users,
				session: sessions,
			})
			.from(sessions)
			.innerJoin(users, eq(sessions.userId, users.id))
			.where(
				and(
					eq(sessions.id, cookies.silo_session),
					gt(sessions.expiresAt, new Date()),
				),
			)
			.limit(1);

		if (sessionResult.length > 0) {
			const { user: directUser, session: s } = sessionResult[0];

			// Admin impersonation support (best-practice):
			// - sessions.userId is the real session owner (admin)
			// - sessions.impersonatedUserId is the effective user for dashboard actions
			// - Only allow if the real user is admin AND impersonation is not expired.
			let u = directUser;
			const impersonatedUserId = s.impersonatedUserId;
			const hasActiveImpersonation =
				!!s.impersonatorUserId &&
				!!impersonatedUserId &&
				directUser.isAdmin === true &&
				!!s.impersonationExpiresAt &&
				s.impersonationExpiresAt > new Date();

			if (hasActiveImpersonation) {
				const impersonated = await db
					.select()
					.from(users)
					.where(eq(users.id, impersonatedUserId))
					.limit(1);

				if (impersonated.length > 0) {
					u = impersonated[0];
					// Guardrail: impersonated user should never get admin powers.
					u.isAdmin = false;
					// IMPORTANT: When impersonating, we see what the user sees.
					// If the user is immortal, we see them as immortal.
				}
			}

			// Token Refresh Logic
			if (
				s.refreshToken &&
				s.tokenExpiresAt &&
				s.tokenExpiresAt <= new Date(Date.now() + 60000)
			) {
				try {
					const params = new URLSearchParams();
					params.append("client_id", config.hcAuth.clientId);
					params.append("client_secret", config.hcAuth.clientSecret);
					params.append("grant_type", "refresh_token");
					params.append("refresh_token", s.refreshToken);

					const tokenRes = await fetch(
						"https://auth.hackclub.com/oauth/token",
						{
							method: "POST",
							headers: {
								"Content-Type": "application/x-www-form-urlencoded",
							},
							body: params,
						},
					);

					if (tokenRes.ok) {
						const tokenData = await tokenRes.json();
						const newExpiresAt = new Date(
							Date.now() + tokenData.expires_in * 1000,
						);

						await db
							.update(sessions)
							.set({
								accessToken: tokenData.access_token,
								refreshToken: tokenData.refresh_token || s.refreshToken,
								tokenExpiresAt: newExpiresAt,
							})
							.where(eq(sessions.id, s.id));

						// Update local session object
						s.accessToken = tokenData.access_token;
						if (tokenData.refresh_token) {
							s.refreshToken = tokenData.refresh_token;
						}
						s.tokenExpiresAt = newExpiresAt;
					} else {
						console.error("Failed to refresh token:", await tokenRes.text());
					}
				} catch (e) {
					console.error("Error refreshing token:", e);
				}
			}

			// Calculate storage usage from all buckets
			const usageResult = await db
				.select({ total: sql<number>`sum(${buckets.totalBytes})` })
				.from(buckets)
				.where(eq(buckets.userId, u.id));

			u.storageUsageBytes = Number(usageResult[0]?.total) || 0;

			// Ensure other numeric fields are numbers
			u.ingressBytes = Number(u.ingressBytes) || 0;
			u.egressBytes = Number(u.egressBytes) || 0;
			u.totalRequests = Number(u.totalRequests) || 0;

			const settings = await getAppSettings();
			u.storageLimitBytes =
				u.storageLimitBytes === null
					? settings.defaultStorageLimitBytes
					: Number(u.storageLimitBytes) || settings.defaultStorageLimitBytes;

			if (u.egressLimitBytes !== null) {
				u.egressLimitBytes = Number(u.egressLimitBytes);
			}

			const ctx = context.getStore();
			if (ctx) {
				ctx.user = u;
				ctx.mode = "authenticated";
			}

			return {
				...u,
				sessionId: s.id,
				accessToken: s.accessToken,
				refreshToken: s.refreshToken,
				tokenExpiresAt: s.tokenExpiresAt,
			};
		}
	}

	return null;
}
