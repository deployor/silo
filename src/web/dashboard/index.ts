import { config } from "../../config";
import { getCurrentUser } from "../../lib/session";
import { render } from "../../lib/view-engine";
import { handleApiRequest } from "./api";
import { handleAuthRequest } from "./auth";

export async function handleDashboardRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	console.log(`[Dashboard] Handling request: ${path}`);

	// Delegate to Auth Handler
	if (path.startsWith("/auth/")) {
		return handleAuthRequest(req);
	}

	// Delegate to API Handler
	if (path.startsWith("/api/")) {
		console.log(`[Dashboard] Delegating to API Handler: ${path}`);
		return handleApiRequest(req);
	}

	if (path === "/docs" || path === "/docs/") {
		const user = await getCurrentUser(req);
		const html = await render("docs", {
			title: "Documentation - Silo",
			user,
			s3Domain: config.s3Domain,
		});

		return new Response(html, {
			headers: { "Content-Type": "text/html" },
		});
	}

	if (path === "/onboarding" || path === "/onboarding/") {
		const user = await getCurrentUser(req);
		if (!user) {
			return Response.redirect("/auth/login");
		}
		if (user.onboarded) {
			return Response.redirect("/");
		}
		const html = await render("onboarding", {
			title: "Silo - Welcome",
			layout: "blank",
		});
		return new Response(html, {
			headers: { "Content-Type": "text/html" },
		});
	}

	if (path === "/cdn" || path === "/cdn/") {
		const user = await getCurrentUser(req);
		if (!user) {
			return Response.redirect("/auth/login");
		}
		if (user.isLocked) {
			return new Response("Account Locked", { status: 403 });
		}
		if (!user.onboarded) {
			return Response.redirect("/onboarding");
		}
		if (!user.slackId) {
			return new Response(
				"You must link your Slack account to use the CDN feature.",
				{ status: 403 },
			);
		}

		const html = await render("cdn", {
			title: "Silo CDN",
			layout: "main",
			user,
			pageTitle: "CDN",
		});

		return new Response(html, {
			headers: { "Content-Type": "text/html" },
		});
	}

	const user = await getCurrentUser(req);
	if (!user) {
		const html = await render("landing", {
			title: "Silo S3 Gateway",
			layout: "blank",
		});
		return new Response(html, {
			headers: { "Content-Type": "text/html" },
		});
	}

	if (!user.onboarded) {
		return Response.redirect("/onboarding");
	}

	if (user.isLocked) {
		const html = await render("locked", {
			title: "Account Locked - Silo",
			layout: "blank",
			reason: user.lockReason,
		});

		return new Response(html, {
			status: 403,
			headers: { "Content-Type": "text/html" },
		});
	}

	// Serve File Explorer Page
	const fileExplorerMatch = path.match(/^\/dashboard\/buckets\/([a-z0-9-]+)$/);
	if (fileExplorerMatch) {
		const bucketName = fileExplorerMatch[1];
		const html = await render("files", {
			title: "File Explorer - Silo",
			layout: "blank",
			bucketName,
			user,
			isAdmin: user.isAdmin,
		});

		return new Response(html, {
			headers: { "Content-Type": "text/html" },
		});
	}

	const html = await render("dashboard", {
		title: "Dashboard - Silo",
		user,
		s3Domain: config.s3Domain,
	});

	return new Response(html, {
		headers: { "Content-Type": "text/html" },
	});
}
