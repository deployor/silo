import { config } from "../../config";
import { formatBytes } from "../../lib/format";
import { getAppSettings } from "../../services/settings-service";
import { getCurrentUser } from "../../lib/session";
import { render } from "../../lib/view-engine";
import { handleApiRequest } from "./api/index";
import { handleAuthRequest } from "./auth";
import { handleOffboardingRequest } from "./offboarding";

export async function handleDashboardRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	if (path.startsWith("/auth/")) {
		return handleAuthRequest(req);
	}

	if (path.startsWith("/dashboard/offboarding")) {
		return handleOffboardingRequest(req);
	}

	if (path.startsWith("/api/")) {
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

		const settings = await getAppSettings();
		const html = await render("onboarding", {
			title: "Silo - Welcome",
			layout: "main",
			hideNavLinks: true,
			mainClass: "flex flex-col items-center justify-center",
			defaultStorageLimitHuman: formatBytes(settings.defaultStorageLimitBytes),
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
			layout: "main",
			hideNavLinks: true,
			mainClass: "flex flex-col items-center justify-center",
		});
		return new Response(html, {
			headers: { "Content-Type": "text/html" },
		});
	}

	// 1. Check for deletion (Aged Out) - Redirect to landing page explanation
	if (user.filesDeleted) {
		const html = await render("aged-out", {
			title: "Silo - Graduation",
			layout: "blank",
			user,
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
			layout: "main",
			hideNavLinks: true,
			mainClass: "flex items-center justify-center",
			reason: user.lockReason,
		});

		return new Response(html, {
			status: 403,
			headers: { "Content-Type": "text/html" },
		});
	}

	// 2. Check for Offboarding Required (Marked as over age)
	// If they are marked, show a banner or redirect if critical?
	// Spec says: "put liek a warning on the normal page dashbaord page"
	// and "redirect them to a landing page explaining... if files deleted"
	// So if NOT deleted but marked, they can still access dashboard but with warnings.

	const fileExplorerMatch = path.match(/^\/dashboard\/buckets\/([a-z0-9-]+)$/);
	if (fileExplorerMatch) {
		const bucketName = fileExplorerMatch[1];
		const html = await render("files", {
			title: "File Explorer - Silo",
			layout: "main",
			bucketName,
			user,
			isAdmin: user.isAdmin,
			breadcrumbs: `<span class="text-text-muted">/</span> <span class="bg-hc-blue/20 text-hc-blue px-2 py-0.5 rounded text-sm font-mono border border-hc-blue/30">${bucketName}</span>`,
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
