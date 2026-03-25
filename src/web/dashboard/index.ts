import { config } from "../../config";
import { formatBytes } from "../../lib/format";
import { getCurrentUser } from "../../lib/session";
import { render } from "../../lib/view-engine";
import {
	getBucketAccessForUser,
	listPendingInviteCount,
} from "../../services/collaboration-service";
import { getBucketDeepFreezeMessage } from "../../services/deep-freeze-service";
import { getAppSettings } from "../../services/settings-service";
import { YswsService } from "../../services/ysws-service";
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
		const viewUser = user
			? {
					...user,
					pendingCollaborationInvites: await listPendingInviteCount(user.id),
				}
			: null;
		const settings = await getAppSettings();
		const html = await render("docs", {
			title: "Documentation - Silo",
			user: viewUser,
			s3Domain: config.s3Domain,
			yswsQuotaPerHour: settings.yswsQuotaPerHourBytes,
			yswsBonusTiers: settings.yswsBonusTiers,
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
			yswsQuotaPerHourHuman: formatBytes(settings.yswsQuotaPerHourBytes),
		});
		return new Response(html, {
			headers: { "Content-Type": "text/html" },
		});
	}

	if (path === "/dashboard" || path === "/dashboard/") {
		const user = await getCurrentUser(req);
		if (!user) {
			return new Response(null, {
				status: 302,
				headers: {
					Location: `/auth/login?next=${encodeURIComponent(path)}`,
				},
			});
		}

		return Response.redirect("/");
	}

	const user = await getCurrentUser(req);
	if (!user) {
		const settings = await getAppSettings();
		const html = await render("landing", {
			title: "Silo S3 Gateway",
			layout: "main",
			hideNavLinks: true,
			mainClass: "flex flex-col items-center justify-center",
			yswsQuotaPerHour: settings.yswsQuotaPerHourBytes,
			yswsBonusTiers: settings.yswsBonusTiers,
		});
		return new Response(html, {
			headers: { "Content-Type": "text/html" },
		});
	}

	const viewUser = {
		...user,
		pendingCollaborationInvites: await listPendingInviteCount(user.id),
	};

	// 1. Check for deletion (Aged Out) - Redirect to landing page explanation
	if (user.filesDeleted) {
		const html = await render("aged-out", {
			title: "Silo - Offboarding",
			layout: "blank",
			user: viewUser,
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
			user: viewUser,
		});

		return new Response(html, {
			status: 403,
			headers: { "Content-Type": "text/html" },
		});
	}

	if (user.dataExported) {
		return Response.redirect("/dashboard/offboarding");
	}

	const fileExplorerMatch = path.match(/^\/dashboard\/buckets\/([a-z0-9-]+)$/);
	if (fileExplorerMatch) {
		const bucketName = fileExplorerMatch[1];
		const access = await getBucketAccessForUser({
			bucketName,
			userId: user.id,
			isAdmin: user.isAdmin,
		});
		const html = await render("files", {
			title: "File Explorer - Silo",
			layout: "main",
			bucketName,
			user: viewUser,
			isAdmin: user.isAdmin,
			bucketAccess: {
				isCollaborative: access.isCollaborator,
				permissions: access.permissions,
				canReadFiles: access.permissionSet.files_read,
				canWriteFiles:
					access.permissionSet.files_write &&
					!access.bucket.isPaused &&
					!getBucketDeepFreezeMessage(access.bucket),
				ownerId: access.owner.id,
			},
			breadcrumbs: `<span class="text-text-muted">/</span> <span class="bg-hc-blue/20 text-hc-blue px-2 py-0.5 rounded text-sm font-mono border border-hc-blue/30">${bucketName}</span>`,
		});

		return new Response(html, {
			headers: { "Content-Type": "text/html" },
		});
	}

	const bucketAnalyticsMatch = path.match(
		/^\/dashboard\/buckets\/([a-z0-9-]+)\/analytics$/,
	);
	if (bucketAnalyticsMatch) {
		const bucketName = bucketAnalyticsMatch[1];
		const access = await getBucketAccessForUser({
			bucketName,
			userId: user.id,
			isAdmin: user.isAdmin,
		});
		const html = await render("bucket-analytics", {
			title: "Bucket Analytics - Silo",
			layout: "main",
			bucketName,
			user: viewUser,
			bucketAccess: {
				isCollaborative: access.isCollaborator,
				ownerId: access.owner.id,
			},
			breadcrumbs: `<span class="text-text-muted">/</span> <span class="bg-hc-blue/20 text-hc-blue px-2 py-0.5 rounded text-sm font-mono border border-hc-blue/30">${bucketName}</span> <span class="text-text-muted">/ analytics</span>`,
		});

		return new Response(html, {
			headers: { "Content-Type": "text/html" },
		});
	}

	const submissions = await YswsService.getSubmissionsByUserId(user.id);
	const latestSubmission = submissions.length > 0 ? submissions[0] : null;

	const settings = await getAppSettings();
	const html = await render("dashboard", {
		title: "Dashboard - Silo",
		user: viewUser,
		s3Domain: config.s3Domain,
		latestSubmission,
		yswsQuotaPerHourHuman: formatBytes(settings.yswsQuotaPerHourBytes),
	});

	return new Response(html, {
		headers: { "Content-Type": "text/html" },
	});
}
