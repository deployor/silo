import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db";
import { sessions, users } from "../../db/schema";
import { render } from "../../lib/view-engine";

export async function handleAuthRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	if (path === "/auth/login") {
		const source = url.searchParams.get("source");
		const redirectUri =
			source === "slack"
				? `${config.hcAuth.redirectUri}?source=slack`
				: config.hcAuth.redirectUri;

		const authUrl = `https://auth.hackclub.com/oauth/authorize?client_id=${config.hcAuth.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20profile%20email%20slack_id%20verification_status`;
		return Response.redirect(authUrl);
	}

	if (path === "/auth/callback") {
		const code = url.searchParams.get("code");
		const source = url.searchParams.get("source");
		if (!code) return new Response("Missing code", { status: 400 });

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

			const existingUser = await db
				.select()
				.from(users)
				.where(eq(users.id, userId))
				.limit(1);

			if (existingUser.length === 0) {
				const cookieHeader = req.headers.get("Cookie");
				const cookies = cookieHeader
					? cookieHeader.split(";").reduce(
							(acc, cookie) => {
								const [key, value] = cookie.trim().split("=");
								acc[key] = value;
								return acc;
							},
							{} as Record<string, string>,
						)
					: {};

				const expectedBypass = createHmac("sha256", config.hcAuth.clientSecret)
					.update("wip_bypass")
					.digest("hex");

				if (cookies.silo_wip_bypass !== expectedBypass) {
					const html = await render("wip", {
						title: "Work In Progress - Silo",
						layout: "main",
						hideNavLinks: true,
						mainClass: "flex items-center justify-center",
					});
					return new Response(html, {
						headers: { "Content-Type": "text/html" },
					});
				}
			}

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
			});

			const headers = new Headers();
			headers.set(
				"Set-Cookie",
				`silo_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=${expiresAt.toUTCString()}`,
			);

			if (source === "slack") {
				headers.set("Content-Type", "text/html");
				const html = await render("slack-success", {
					title: "Silo - Account Linked",
					layout: "blank",
				});
				return new Response(html, { headers });
			}

			headers.set("Location", "/");

			return new Response(null, { status: 302, headers });
		} catch (e) {
			console.error("Auth Error:", e);
			return new Response("Authentication Failed", { status: 500 });
		}
	}

	if (path === "/auth/logout") {
		const cookieHeader = req.headers.get("Cookie");
		if (cookieHeader) {
			const cookies = cookieHeader.split(";").reduce(
				(acc, cookie) => {
					const [key, value] = cookie.trim().split("=");
					acc[key] = value;
					return acc;
				},
				{} as Record<string, string>,
			);

			if (cookies.silo_session) {
				// If admin is impersonating, "logout" should just stop impersonation.
				const sess = await db
					.select({
						id: sessions.id,
						impersonatorUserId: sessions.impersonatorUserId,
					})
					.from(sessions)
					.where(eq(sessions.id, cookies.silo_session))
					.limit(1);

				if (sess.length > 0 && sess[0].impersonatorUserId) {
					await db
						.update(sessions)
						.set({
							impersonatorUserId: null,
							impersonatedUserId: null,
							impersonationExpiresAt: null,
						})
						.where(eq(sessions.id, cookies.silo_session));

					const headers = new Headers();
					headers.set("Location", "/admin");
					return new Response(null, { status: 302, headers });
				}

				// Normal logout
				await db.delete(sessions).where(eq(sessions.id, cookies.silo_session));
			}
		}

		const headers = new Headers();
		headers.set(
			"Set-Cookie",
			`silo_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
		);
		headers.set("Location", "/");
		return new Response(null, { status: 302, headers });
	}

	if (path === "/auth/wip" && req.method === "POST") {
		const cookieHeader = req.headers.get("Cookie");
		const cookies = cookieHeader
			? cookieHeader.split(";").reduce(
					(acc, cookie) => {
						const [key, value] = cookie.trim().split("=");
						acc[key] = value;
						return acc;
					},
					{} as Record<string, string>,
				)
			: {};

		const lastAttempt = parseInt(cookies.silo_wip_attempt || "0", 10);
		const now = Date.now();

		if (now - lastAttempt < 3000) {
			const html = await render("wip", {
				title: "Work In Progress - Silo",
				layout: "main",
				hideNavLinks: true,
				mainClass: "flex items-center justify-center",
				error: "Please wait a few seconds before trying again.",
			});
			return new Response(html, {
				headers: { "Content-Type": "text/html" },
			});
		}

		const formData = await req.formData();
		const code = formData.get("code");

		if (config.devAccessCode && code === config.devAccessCode) {
			const bypassValue = createHmac("sha256", config.hcAuth.clientSecret)
				.update("wip_bypass")
				.digest("hex");

			const headers = new Headers();
			headers.append(
				"Set-Cookie",
				`silo_wip_bypass=${bypassValue}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=31536000`,
			);
			headers.append(
				"Set-Cookie",
				`silo_wip_attempt=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
			);
			headers.set("Location", "/auth/login");
			return new Response(null, { status: 302, headers });
		}

		const headers = new Headers();
		headers.set(
			"Set-Cookie",
			`silo_wip_attempt=${now}; Path=/; HttpOnly; SameSite=Lax; Secure`,
		);

		const html = await render("wip", {
			title: "Work In Progress - Silo",
			layout: "main",
			hideNavLinks: true,
			mainClass: "flex items-center justify-center",
			error: "Invalid access code. Please try again.",
		});

		return new Response(html, {
			status: 401,
			headers: {
				"Content-Type": "text/html",
				...Object.fromEntries(headers.entries()),
			},
		});
	}

	return new Response("Not Found", { status: 404 });
}
