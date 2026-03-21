import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import { getCurrentUser } from "../../../lib/session";
import {
	createCollaborationInviteSchema,
	respondToCollaborationInviteSchema,
	updateCollaborationInviteSchema,
} from "../../../lib/validation";
import {
	createOrUpdateCollaborationInvite,
	getUserById,
	listPendingInviteCount,
	listPendingInvites,
	respondToCollaborationInvite,
	revokeCollaborationInvite,
	updateCollaborationInvitePermissions,
} from "../../../services/collaboration-service";

export async function handleCollaboration(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	const url = new URL(req.url);
	const path = url.pathname;

	const collaboratorLookupMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/collaborators\/lookup$/,
	);
	if (collaboratorLookupMatch && req.method === "GET") {
		const inviteeUserId = (url.searchParams.get("userId") || "").trim();
		if (!inviteeUserId) return errorResponse("User ID is required", 400);

		try {
			const invitee = await getUserById(inviteeUserId);
			if (!invitee) return errorResponse("User not found", 404);
			return jsonResponse({ user: invitee });
		} catch (error) {
			return errorResponse(
				error instanceof Error ? error.message : "Internal Error",
				500,
			);
		}
	}

	const collaboratorsMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/collaborators(?:\/([^/]+))?$/,
	);
	if (collaboratorsMatch) {
		const bucketName = collaboratorsMatch[1];
		const collaborationId = collaboratorsMatch[2] || null;

		if (req.method === "POST") {
			if (user.dataExported) {
				return errorResponse(
					"Account is frozen. Collaboration invites cannot be changed.",
					403,
				);
			}

			try {
				const body = await req.json();
				const result = createCollaborationInviteSchema.safeParse(body);
				if (!result.success) {
					return errorResponse(result.error.issues[0].message, 400);
				}

				const invite = await createOrUpdateCollaborationInvite({
					bucketName,
					ownerUserId: user.id,
					inviteeUserId: result.data.inviteeUserId.trim(),
					permissions: result.data.permissions,
				});

				return jsonResponse({ invite });
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Internal Error";
				return errorResponse(message, 400);
			}
		}

		if (req.method === "PATCH") {
			if (!collaborationId) return errorResponse("Invite ID is required", 400);
			if (user.dataExported) {
				return errorResponse(
					"Account is frozen. Collaboration invites cannot be changed.",
					403,
				);
			}

			try {
				const body = await req.json();
				const result = updateCollaborationInviteSchema.safeParse(body);
				if (!result.success) {
					return errorResponse(result.error.issues[0].message, 400);
				}

				const invite = await updateCollaborationInvitePermissions({
					bucketName,
					ownerUserId: user.id,
					collaborationId,
					permissions: result.data.permissions,
				});

				return jsonResponse({ invite });
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Internal Error";
				return errorResponse(message, 400);
			}
		}

		if (req.method === "DELETE") {
			if (!collaborationId) return errorResponse("Invite ID is required", 400);
			if (user.dataExported) {
				return errorResponse(
					"Account is frozen. Collaboration invites cannot be changed.",
					403,
				);
			}

			try {
				await revokeCollaborationInvite({
					bucketName,
					ownerUserId: user.id,
					collaborationId,
				});
				return jsonResponse({ ok: true });
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Internal Error";
				return errorResponse(message, 400);
			}
		}
	}

	if (path === "/api/dashboard/collaboration/invites") {
		if (req.method === "GET") {
			try {
				const [count, invites] = await Promise.all([
					listPendingInviteCount(user.id),
					listPendingInvites(user.id),
				]);
				return jsonResponse({ count, invites });
			} catch (error) {
				return errorResponse(
					error instanceof Error ? error.message : "Internal Error",
					500,
				);
			}
		}
	}

	const inviteResponseMatch = path.match(
		/^\/api\/dashboard\/collaboration\/invites\/([^/]+)$/,
	);
	if (inviteResponseMatch && req.method === "POST") {
		if (user.dataExported) {
			return errorResponse(
				"Account is frozen. Collaboration invites cannot be changed.",
				403,
			);
		}

		try {
			const body = await req.json();
			const result = respondToCollaborationInviteSchema.safeParse(body);
			if (!result.success) {
				return errorResponse(result.error.issues[0].message, 400);
			}

			await respondToCollaborationInvite({
				collaborationId: inviteResponseMatch[1],
				inviteeUserId: user.id,
				action: result.data.action,
			});

			return jsonResponse({ ok: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Internal Error";
			return errorResponse(message, 400);
		}
	}

	return errorResponse("Method not allowed", 405);
}
