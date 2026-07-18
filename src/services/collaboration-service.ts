import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import { bucketCollaborators, buckets, users } from "../db/schema";
import { context } from "../lib/context";

export const COLLABORATION_PERMISSIONS = [
	"manage_keys",
	"manage_cors",
	"files_read",
	"files_write",
] as const;

export type CollaborationPermission =
	(typeof COLLABORATION_PERMISSIONS)[number];

export type CollaborationStatus =
	| "pending"
	| "accepted"
	| "declined"
	| "revoked";

export type CollaborationPermissionSet = Record<
	CollaborationPermission,
	boolean
>;

export type BucketAccessContext = {
	bucket: typeof buckets.$inferSelect;
	owner: typeof users.$inferSelect;
	isOwner: boolean;
	isAdmin: boolean;
	isCollaborator: boolean;
	collaborationStatus: CollaborationStatus | null;
	permissions: CollaborationPermission[];
	permissionSet: CollaborationPermissionSet;
};

export function normalizeCollaborationPermissions(
	permissions: readonly string[],
): CollaborationPermission[] {
	const normalized = new Set<CollaborationPermission>();
	for (const permission of permissions) {
		if (
			(COLLABORATION_PERMISSIONS as readonly string[]).includes(permission) &&
			typeof permission === "string"
		) {
			normalized.add(permission as CollaborationPermission);
		}
	}
	if (normalized.has("files_write")) {
		normalized.add("files_read");
	}
	return [...normalized];
}

export function serializeCollaborationPermissions(
	permissions: readonly string[],
): string {
	return JSON.stringify(normalizeCollaborationPermissions(permissions));
}

export function parseCollaborationPermissions(
	raw: string | null | undefined,
): CollaborationPermission[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return normalizeCollaborationPermissions(parsed);
	} catch {
		return [];
	}
}

export function toCollaborationPermissionSet(
	permissions: readonly string[],
): CollaborationPermissionSet {
	const normalized = new Set(normalizeCollaborationPermissions(permissions));
	return {
		manage_keys: normalized.has("manage_keys"),
		manage_cors: normalized.has("manage_cors"),
		files_read: normalized.has("files_read"),
		files_write: normalized.has("files_write"),
	};
}

export function getUserAvatarUrl(slackId?: string | null) {
	return slackId ? `https://cachet.dunkirk.sh/users/${slackId}/r` : null;
}

export async function getUserById(userId: string) {
	const normalizedUserId = userId.trim();
	if (!normalizedUserId) return null;

	const result = await db
		.select({
			id: users.id,
			email: users.email,
			slackId: users.slackId,
		})
		.from(users)
		.where(eq(users.id, normalizedUserId))
		.limit(1);

	if (result.length === 0) return null;

	return {
		...result[0],
		avatarUrl: getUserAvatarUrl(result[0].slackId),
	};
}

export async function getOwnedBucketByName(
	bucketName: string,
	ownerUserId: string,
) {
	const result = await db
		.select()
		.from(buckets)
		.where(and(eq(buckets.name, bucketName), eq(buckets.userId, ownerUserId)))
		.limit(1);

	return result[0] || null;
}

export async function getBucketByName(bucketName: string) {
	const result = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);

	return result[0] || null;
}

export async function getBucketOwnerById(ownerUserId: string) {
	const result = await db
		.select({
			user: users,
			storageUsageBytes:
				sql<number>`COALESCE(sum(${buckets.totalBytes}), 0)`.mapWith(Number),
		})
		.from(users)
		.leftJoin(buckets, eq(buckets.userId, users.id))
		.where(eq(users.id, ownerUserId))
		.groupBy(users.id)
		.limit(1);

	return result[0]
		? { ...result[0].user, storageUsageBytes: result[0].storageUsageBytes }
		: null;
}

export async function getAcceptedCollaboratorRecord(
	bucketId: string,
	userId: string,
) {
	const result = await db
		.select()
		.from(bucketCollaborators)
		.where(
			and(
				eq(bucketCollaborators.bucketId, bucketId),
				eq(bucketCollaborators.inviteeUserId, userId),
				eq(bucketCollaborators.status, "accepted"),
			),
		)
		.limit(1);

	return result[0] || null;
}

export async function listPendingInviteCount(userId: string) {
	const rows = await db
		.select({ id: bucketCollaborators.id })
		.from(bucketCollaborators)
		.where(
			and(
				eq(bucketCollaborators.inviteeUserId, userId),
				eq(bucketCollaborators.status, "pending"),
			),
		);

	return rows.length;
}

export async function listPendingInvites(userId: string) {
	const rows = await db
		.select({
			collaboration: bucketCollaborators,
			bucket: buckets,
			inviter: {
				id: users.id,
				email: users.email,
				slackId: users.slackId,
			},
		})
		.from(bucketCollaborators)
		.innerJoin(buckets, eq(bucketCollaborators.bucketId, buckets.id))
		.innerJoin(users, eq(bucketCollaborators.invitedByUserId, users.id))
		.where(
			and(
				eq(bucketCollaborators.inviteeUserId, userId),
				eq(bucketCollaborators.status, "pending"),
			),
		)
		.orderBy(desc(bucketCollaborators.createdAt));

	return rows.map((row) => ({
		id: row.collaboration.id,
		bucketName: row.bucket.name,
		bucketCreatedAt: row.bucket.createdAt,
		permissions: parseCollaborationPermissions(row.collaboration.permissions),
		invitedAt: row.collaboration.createdAt,
		inviter: {
			...row.inviter,
			avatarUrl: getUserAvatarUrl(row.inviter.slackId),
		},
	}));
}

export async function listAcceptedCollaboratorBuckets(userId: string) {
	const rows = await db
		.select({
			bucket: buckets,
			collaboration: bucketCollaborators,
		})
		.from(bucketCollaborators)
		.innerJoin(buckets, eq(bucketCollaborators.bucketId, buckets.id))
		.where(
			and(
				eq(bucketCollaborators.inviteeUserId, userId),
				eq(bucketCollaborators.status, "accepted"),
			),
		);

	return rows.map((row) => ({
		...row.bucket,
		collaboration: row.collaboration,
		permissions: parseCollaborationPermissions(row.collaboration.permissions),
	}));
}

export async function listCollaborationsForBuckets(bucketIds: string[]) {
	if (bucketIds.length === 0) return [];

	return db
		.select({
			collaboration: bucketCollaborators,
			invitee: {
				id: users.id,
				email: users.email,
				slackId: users.slackId,
			},
		})
		.from(bucketCollaborators)
		.innerJoin(users, eq(bucketCollaborators.inviteeUserId, users.id))
		.where(
			and(
				inArray(bucketCollaborators.bucketId, bucketIds),
				or(
					eq(bucketCollaborators.status, "pending"),
					eq(bucketCollaborators.status, "accepted"),
				),
			),
		);
}

export async function getCollaborationRecordById(
	collaborationId: string,
	userId?: string,
) {
	const rows = await db
		.select({
			collaboration: bucketCollaborators,
			bucket: buckets,
		})
		.from(bucketCollaborators)
		.innerJoin(buckets, eq(bucketCollaborators.bucketId, buckets.id))
		.where(eq(bucketCollaborators.id, collaborationId))
		.limit(1);

	const row = rows[0];
	if (!row) return null;
	if (userId && row.collaboration.inviteeUserId !== userId) return null;
	return row;
}

export async function createOrUpdateCollaborationInvite(params: {
	bucketName: string;
	ownerUserId: string;
	inviteeUserId: string;
	permissions: readonly string[];
}) {
	const bucket = await getOwnedBucketByName(
		params.bucketName,
		params.ownerUserId,
	);
	if (!bucket) throw new Error("Bucket not found");
	assertBucketCollaborationAllowed(bucket);

	if (params.inviteeUserId === params.ownerUserId) {
		throw new Error("You cannot invite yourself");
	}

	const invitee = await getUserById(params.inviteeUserId);
	if (!invitee) {
		throw new Error("User not found");
	}

	const normalizedPermissions = normalizeCollaborationPermissions(
		params.permissions,
	);
	if (normalizedPermissions.length === 0) {
		throw new Error("At least one permission is required");
	}

	const existing = await db
		.select()
		.from(bucketCollaborators)
		.where(
			and(
				eq(bucketCollaborators.bucketId, bucket.id),
				eq(bucketCollaborators.inviteeUserId, params.inviteeUserId),
			),
		)
		.limit(1);

	const now = new Date();
	if (existing[0]) {
		const nextStatus =
			existing[0].status === "accepted" ? "accepted" : "pending";
		await db
			.update(bucketCollaborators)
			.set({
				permissions: serializeCollaborationPermissions(normalizedPermissions),
				status: nextStatus,
				updatedAt: now,
				respondedAt: nextStatus === "accepted" ? existing[0].respondedAt : null,
				acceptedAt: nextStatus === "accepted" ? existing[0].acceptedAt : null,
				invitedByUserId: params.ownerUserId,
			})
			.where(eq(bucketCollaborators.id, existing[0].id));

		return {
			id: existing[0].id,
			status: nextStatus,
			permissions: normalizedPermissions,
			invitee,
		};
	}

	const inserted = await db
		.insert(bucketCollaborators)
		.values({
			bucketId: bucket.id,
			inviteeUserId: params.inviteeUserId,
			invitedByUserId: params.ownerUserId,
			status: "pending",
			permissions: serializeCollaborationPermissions(normalizedPermissions),
			createdAt: now,
			updatedAt: now,
		})
		.returning({
			id: bucketCollaborators.id,
			status: bucketCollaborators.status,
		});

	return {
		id: inserted[0].id,
		status: inserted[0].status,
		permissions: normalizedPermissions,
		invitee,
	};
}

export async function updateCollaborationInvitePermissions(params: {
	bucketName: string;
	ownerUserId: string;
	collaborationId: string;
	permissions: readonly string[];
}) {
	const bucket = await getOwnedBucketByName(
		params.bucketName,
		params.ownerUserId,
	);
	if (!bucket) throw new Error("Bucket not found");
	assertBucketCollaborationAllowed(bucket);

	const rows = await db
		.select()
		.from(bucketCollaborators)
		.where(
			and(
				eq(bucketCollaborators.id, params.collaborationId),
				eq(bucketCollaborators.bucketId, bucket.id),
			),
		)
		.limit(1);

	if (!rows[0]) throw new Error("Invite not found");

	const normalizedPermissions = normalizeCollaborationPermissions(
		params.permissions,
	);
	if (normalizedPermissions.length === 0) {
		throw new Error("At least one permission is required");
	}

	await db
		.update(bucketCollaborators)
		.set({
			permissions: serializeCollaborationPermissions(normalizedPermissions),
			updatedAt: new Date(),
		})
		.where(eq(bucketCollaborators.id, rows[0].id));

	return {
		id: rows[0].id,
		status: rows[0].status,
		permissions: normalizedPermissions,
	};
}

export async function revokeCollaborationInvite(params: {
	bucketName: string;
	ownerUserId: string;
	collaborationId: string;
}) {
	const bucket = await getOwnedBucketByName(
		params.bucketName,
		params.ownerUserId,
	);
	if (!bucket) throw new Error("Bucket not found");
	assertBucketCollaborationAllowed(bucket);

	const rows = await db
		.select()
		.from(bucketCollaborators)
		.where(
			and(
				eq(bucketCollaborators.id, params.collaborationId),
				eq(bucketCollaborators.bucketId, bucket.id),
			),
		)
		.limit(1);

	if (!rows[0]) throw new Error("Invite not found");

	await db
		.delete(bucketCollaborators)
		.where(eq(bucketCollaborators.id, rows[0].id));
}

export async function respondToCollaborationInvite(params: {
	collaborationId: string;
	inviteeUserId: string;
	action: "accept" | "decline";
}) {
	const row = await getCollaborationRecordById(
		params.collaborationId,
		params.inviteeUserId,
	);
	if (!row) throw new Error("Invite not found");
	if (row.collaboration.status !== "pending") {
		throw new Error("Invite is no longer pending");
	}

	const now = new Date();
	await db
		.update(bucketCollaborators)
		.set({
			status: params.action === "accept" ? "accepted" : "declined",
			updatedAt: now,
			respondedAt: now,
			acceptedAt: params.action === "accept" ? now : null,
		})
		.where(eq(bucketCollaborators.id, row.collaboration.id));
}

export async function getBucketAccessForUser(params: {
	bucketName: string;
	userId: string;
	isAdmin?: boolean;
}): Promise<BucketAccessContext> {
	const bucket = await getBucketByName(params.bucketName);
	if (!bucket) {
		throw new Error("Bucket not found");
	}
	const requestContext = context.getStore();
	if (requestContext) requestContext.bucket = bucket;

	if (!bucket.userId) {
		throw new Error("Owner not found");
	}

	const owner = await getBucketOwnerById(bucket.userId);
	if (!owner) {
		throw new Error("Owner not found");
	}

	const isAdmin = Boolean(params.isAdmin);
	const isOwner = bucket.userId === params.userId;
	if (isAdmin || isOwner) {
		return {
			bucket,
			owner,
			isOwner,
			isAdmin,
			isCollaborator: false,
			collaborationStatus: null,
			permissions: [...COLLABORATION_PERMISSIONS],
			permissionSet: toCollaborationPermissionSet(COLLABORATION_PERMISSIONS),
		};
	}

	const collaboration = await getAcceptedCollaboratorRecord(
		bucket.id,
		params.userId,
	);
	if (!collaboration) {
		throw new Error("Unauthorized");
	}

	const permissions = parseCollaborationPermissions(collaboration.permissions);
	return {
		bucket,
		owner,
		isOwner: false,
		isAdmin: false,
		isCollaborator: true,
		collaborationStatus: collaboration.status as CollaborationStatus,
		permissions,
		permissionSet: toCollaborationPermissionSet(permissions),
	};
}

export function assertBucketCollaborationAllowed(
	bucket: typeof buckets.$inferSelect,
) {
	if (bucket.isSystem) {
		throw new Error("Collaboration is not supported for system buckets");
	}
}

export function assertCanReadFiles(access: BucketAccessContext) {
	if (access.isOwner || access.isAdmin) return;
	if (!access.permissionSet.files_read) {
		throw new Error("Unauthorized");
	}
}

export function assertCanWriteFiles(access: BucketAccessContext) {
	if (access.isOwner || access.isAdmin) return;
	if (!access.permissionSet.files_write) {
		throw new Error("Unauthorized");
	}
}

export function assertCanManageKeys(access: BucketAccessContext) {
	if (access.isOwner || access.isAdmin) return;
	if (!access.permissionSet.manage_keys) {
		throw new Error("Unauthorized");
	}
}

export function assertCanManageCors(access: BucketAccessContext) {
	if (access.isOwner || access.isAdmin) return;
	if (!access.permissionSet.manage_cors) {
		throw new Error("Unauthorized");
	}
}
