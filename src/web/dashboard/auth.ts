import { randomUUID } from "node:crypto";
import { config } from "../../config";
import { db } from "../../db";
import { sessions, users } from "../../db/schema";
import { parseCookies } from "../../lib/api-utils";
import { htmlResponse } from "../../lib/http/html";
import { render } from "../../lib/view-engine";
import { applyPendingProgramGrants } from "../../services/redemption-service";

function secureFlag(): string {
	return config.isProduction ? "; Secure" : "";
}

export async function handleAuthRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	if (path === "/auth/login") {
		const source = url.searchParams.get("source");
		const redirectUri =
			source === "slack"
				? `${config.hcAuth.redirectUri}?source=slack`
				: config.hcAuth.redirectUri;

		const state = randomUUID();
		const authUrl = `https://auth.hackclub.com/oauth/authorize?client_id=${config.hcAuth.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20profile%20email%20slack_id%20verification_status&state=${state}`;

		const headers = new Headers();
		headers.set("Location", authUrl);
		headers.set(
			"Set-Cookie",
			`silo_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax${secureFlag()}; Max-Age=300`,
		);

		return new Response(null, { status: 302, headers });
	}

	if (path === "/auth/callback") {
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const source = url.searchParams.get("source");

		if (!code) return new Response("Missing code", { status: 400 });

		const cookies = parseCookies(req.headers.get("Cookie"));
		const storedState = cookies.silo_oauth_state;

		if (!state || !storedState || state !== storedState) {
			return htmlResponse("Invalid or missing state parameter", 400);
		}

		try {
			const params = new URLSearchParams();
			params.append("client_id", config.hcAuth.clientId);
			params.append("client_secret", config.hcAuth.clientSecret);
			params.append("code", code);
			params.append("grant_type", "authorization_code");

			const redirectUri =
				source === "slack"
					? `${config.hcAuth.redirectUri}?source=slack`
					: config.hcAuth.redirectUri;
			params.append("redirect_uri", redirectUri);

			const tokenRes = await fetch("https://auth.hackclub.com/oauth/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: params,
			});

			if (!tokenRes.ok) {
				const text = await tokenRes.text();
				console.error("Token Exchange Failed:", text);
				throw new Error(`Token exchange failed: ${tokenRes.status}`);
			}

			const tokenData = await tokenRes.json();
			if (!tokenData.access_token) {
				console.error("Token Error:", tokenData);
				throw new Error("Failed to get token");
			}

			const userRes = await fetch("https://auth.hackclub.com/oauth/userinfo", {
				headers: { Authorization: `Bearer ${tokenData.access_token}` },
			});
			const userData = await userRes.json();

			const userId = userData.sub;
			const slackId = userData.slack_id;

			await db
				.insert(users)
				.values({
					id: userId,
					email: userData.email,
					slackId: slackId,
				})
				.onConflictDoUpdate({
					target: users.id,
					set: {
						email: userData.email,
						slackId: slackId,
					},
				});

			const pendingGrants = await applyPendingProgramGrants(userId);

			const sessionId = randomUUID();
			const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 days

			await db.insert(sessions).values({
				id: sessionId,
				userId: userId,
				expiresAt: expiresAt,
				accessToken: tokenData.access_token,
				refreshToken: tokenData.refresh_token,
				tokenExpiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
				scope: tokenData.scope,
				userAgent: req.headers.get("user-agent"),
				ipAddress:
					req.headers.get("x-forwarded-for") ||
					req.headers.get("cf-connecting-ip") ||
					null,
			});

			const headers = new Headers();
			headers.append(
				"Set-Cookie",
				`silo_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secureFlag()}; Expires=${expiresAt.toUTCString()}`,
			);
			headers.append(
				"Set-Cookie",
				`silo_oauth_state=; Path=/; HttpOnly; SameSite=Lax${secureFlag()}; Max-Age=0`,
			);

			if (source === "slack") {
				const { getAppSettings } = await import(
					"../../services/settings-service"
				);
				const { formatBytes } = await import("../../lib/format");
				const settings = await getAppSettings();
				const pendingGrantTotalBytes = pendingGrants.reduce(
					(total, grant) => total + grant.amountBytes,
					0,
				);
				headers.set("Content-Type", "text/html");
				const html = await render("slack-success", {
					title: "Silo - Account Linked",
					layout: "blank",
					defaultStorageLimitHuman: formatBytes(
						settings.defaultStorageLimitBytes,
					),
					pendingGrantTotalHuman:
						pendingGrantTotalBytes > 0
							? formatBytes(pendingGrantTotalBytes)
							: null,
					pendingGrants: pendingGrants.map((grant) => ({
						id: grant.id,
						amountHuman: formatBytes(grant.amountBytes),
						programName: grant.program?.name || "a program",
					})),
				});
				return new Response(html, { headers });
			}

			if (pendingGrants.length) {
				const { formatBytes } = await import("../../lib/format");
				const totalBytes = pendingGrants.reduce(
					(total, grant) => total + grant.amountBytes,
					0,
				);
				const programNames = [
					...new Set(
						pendingGrants.map((grant) => grant.program?.name).filter(Boolean),
					),
				].join(", ");
				const credited = new URLSearchParams({
					credited: formatBytes(totalBytes),
					from: programNames || "a program",
				});
				headers.set("Location", `/?${credited.toString()}`);
			} else {
				headers.set("Location", "/");
			}

			return new Response(null, { status: 302, headers });
		} catch (e) {
			console.error("Auth Error:", e);
			return new Response("Authentication Failed", { status: 500 });
		}
	}

	if (path === "/auth/logout") {
		const cookies = parseCookies(req.headers.get("Cookie"));
		const headers = new Headers();

		// If impersonating, logout stops impersonation but keeps the admin session
		if (cookies.silo_session) {
			const sess = await db
				.select({
					id: sessions.id,
					impersonatorUserId: sessions.impersonatorUserId,
					impersonatedUserId: sessions.impersonatedUserId,
				})
				.from(sessions)
				.where(eq(sessions.id, cookies.silo_session))
				.limit(1);

			if (
				sess.length > 0 &&
				sess[0].impersonatorUserId &&
				sess[0].impersonatedUserId
			) {
				await db
					.update(sessions)
					.set({
						impersonatorUserId: null,
						impersonatedUserId: null,
						impersonationExpiresAt: null,
					})
					.where(eq(sessions.id, cookies.silo_session));

				headers.append(
					"Set-Cookie",
					`silo_impersonating=; Path=/; SameSite=Lax${secureFlag()}; Max-Age=0`,
				);
				headers.set("Location", "/admin");
				return new Response(null, { status: 302, headers });
			}

			await db.delete(sessions).where(eq(sessions.id, cookies.silo_session));
		}

		headers.append(
			"Set-Cookie",
			`silo_session=; Path=/; HttpOnly; SameSite=Lax${secureFlag()}; Max-Age=0`,
		);
		headers.append(
			"Set-Cookie",
			`silo_impersonating=; Path=/; SameSite=Lax${secureFlag()}; Max-Age=0`,
		);
		headers.set("Location", "/");
		return new Response(null, { status: 302, headers });
	}

	return new Response("Not Found", { status: 404 });
}
