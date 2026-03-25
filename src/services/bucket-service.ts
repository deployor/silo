import { eq } from "drizzle-orm";
import { resolveCname, resolveTxt } from "node:dns/promises";
import { config } from "../config";
import {
	deleteBucketContents,
	getInternalPath,
	isReservedBucketName,
} from "../core/s3/utils";
import { db } from "../db";
import { bucketKeys, buckets, users } from "../db/schema";
import {
	createCustomDomainRecord,
	type BucketCustomDomain,
	invalidateBucketCustomDomainCache,
	parseBucketCustomDomains,
	sanitizeBucketCustomDomains,
	serializeBucketCustomDomains,
	normalizeCustomDomain,
} from "../lib/bucket-domains";
import { redis } from "../lib/redis";
import {
	assertBucketCollaborationAllowed,
	assertCanManageCors,
	getBucketAccessForUser,
	listAcceptedCollaboratorBuckets,
	listCollaborationsForBuckets,
	parseCollaborationPermissions,
	toCollaborationPermissionSet,
} from "./collaboration-service";
import {
	getBucketDeepFreezeMessage,
	syncBucketsDeepFreezeState,
} from "./deep-freeze-service";
import { getAppSettings } from "./settings-service";

async function invalidateBucketAuthCache(bucketName: string) {
	await Promise.allSettled([
		redis.del(`auth:pub:${bucketName}`),
		redis.del(`s3:list:${bucketName}:`),
	]);
}

export type CorsRule = {
	ID?: string;
	AllowedOrigins: string[];
	AllowedMethods: string[];
	AllowedHeaders?: string[];
	ExposeHeaders?: string[];
	MaxAgeSeconds?: number;
};

async function validateBucketCustomDomainDns(domain: string, verificationToken: string) {
	const normalizedDomain = normalizeCustomDomain(domain);
	const verificationHostname = `_silo-domain-verification.${normalizedDomain}`;
	let txtMatches = false;
	try {
		const txtRecords = await resolveTxt(verificationHostname);
		txtMatches = txtRecords.some((recordParts) =>
			recordParts.join("").trim() === verificationToken,
		);
	} catch {
		txtMatches = false;
	}

	if (!txtMatches) {
		throw new Error(
			`Verification TXT record missing or incorrect at ${verificationHostname}`,
		);
	}

	try {
		const cnameRecords = await resolveCname(normalizedDomain);
		const pointsAtSilo = cnameRecords.some(
			(record) => record.replace(/\.+$/, "") === config.s3Domain,
		);
		if (!pointsAtSilo) {
			throw new Error(`Custom domain CNAME must point to ${config.s3Domain}`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes("must point to")) {
			throw error;
		}
	}
}

export async function getBucketsForUser(userId: string) {
	const rawUserBuckets = await db
		.select()
		.from(buckets)
		.where(eq(buckets.userId, userId));
	const userBuckets = await syncBucketsDeepFreezeState(rawUserBuckets);

	const bucketsWithKeys = await Promise.all(
		userBuckets.map(async (b) => {
			const keys = await db
				.select()
				.from(bucketKeys)
				.where(eq(bucketKeys.bucketId, b.id));
			return {
				...b,
				keys: keys.map((k) => ({
					id: k.id,
					accessKey: k.accessKey,
				})),
			};
		}),
	);

	const sharedBuckets = await syncBucketsDeepFreezeState(
		await listAcceptedCollaboratorBuckets(userId),
	);
	const sharedKeys = await Promise.all(
		sharedBuckets.map(async (bucket) => {
			const permissions = bucket.permissions;
			const permissionSet = toCollaborationPermissionSet(permissions);
			const keys = permissionSet.manage_keys
				? await db
						.select()
						.from(bucketKeys)
						.where(eq(bucketKeys.bucketId, bucket.id))
				: [];

			return {
				...bucket,
				keys: keys.map((k) => ({
					id: k.id,
					accessKey: k.accessKey,
					note: k.note,
					isPaused: k.isPaused,
					pauseReason: k.pauseReason,
				})),
				isCollaborative: true,
				collaborationPermissions: permissions,
				collaborationPermissionSet: permissionSet,
			};
		}),
	);

	const ownedBucketIds = bucketsWithKeys.map((bucket) => bucket.id);
	const collaboratorRows = await listCollaborationsForBuckets(ownedBucketIds);
	const collaboratorsByBucket = new Map<string, typeof collaboratorRows>();
	for (const row of collaboratorRows) {
		const list = collaboratorsByBucket.get(row.collaboration.bucketId) || [];
		list.push(row);
		collaboratorsByBucket.set(row.collaboration.bucketId, list);
	}

	return [
		...bucketsWithKeys.map((bucket) => ({
			...bucket,
			customDomains: parseBucketCustomDomains(bucket.customDomains),
			isCollaborative: false,
			collaborationPermissions: null,
			collaborationPermissionSet: null,
			collaborators: (collaboratorsByBucket.get(bucket.id) || []).map(
				(row) => ({
					id: row.collaboration.id,
					status: row.collaboration.status,
					permissions: parseCollaborationPermissions(
						row.collaboration.permissions,
					),
					invitedAt: row.collaboration.createdAt,
					respondedAt: row.collaboration.respondedAt,
					acceptedAt: row.collaboration.acceptedAt,
					user: {
						id: row.invitee.id,
						email: row.invitee.email,
						slackId: row.invitee.slackId,
					},
				}),
			),
		})),
		...sharedKeys,
	];
}

async function getOwnedBucketOrThrow(name: string, userId: string, isAdmin = false) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, name))
		.limit(1);

	if (bucket.length === 0) throw new Error("Bucket not found");
	if (bucket[0].userId !== userId && !isAdmin) throw new Error("Unauthorized");
	if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
	const deepFreezeMessage = getBucketDeepFreezeMessage(bucket[0]);
	if (deepFreezeMessage && !isAdmin) throw new Error(deepFreezeMessage);
	return bucket[0];
}

export async function createBucket(userId: string, name: string) {
	if (!name || !/^[a-z0-9-]+$/.test(name)) {
		throw new Error("Invalid bucket name");
	}

	if (isReservedBucketName(name)) {
		throw new Error("Bucket name is reserved for system use");
	}

	// Check user for immortality
	const user = await db.query.users.findFirst({
		where: eq(users.id, userId),
	});

	if (!user) throw new Error("User not found");

	const settings = await getAppSettings();
	const maxBuckets = settings.defaultMaxBucketsPerUser;

	const userBuckets = await db
		.select()
		.from(buckets)
		.where(eq(buckets.userId, userId));

	if (!user.isImmortal && userBuckets.length >= maxBuckets) {
		throw new Error(`Bucket limit reached (${maxBuckets})`);
	}

	const existing = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, name))
		.limit(1);
	if (existing.length > 0) {
		throw new Error("Bucket name already taken");
	}

	const newBucket = await db
		.insert(buckets)
		.values({
			name,
			userId,
		})
		.returning();

	await invalidateBucketAuthCache(name);

	return newBucket[0];
}

export async function emptyBucket(
	name: string,
	userId: string,
	isAdmin = false,
) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, name))
		.limit(1);

	if (bucket.length === 0) throw new Error("Bucket not found");
	if (bucket[0].userId !== userId && !isAdmin) throw new Error("Unauthorized");
	if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
	const emptyDeepFreezeMessage = getBucketDeepFreezeMessage(bucket[0]);
	if (emptyDeepFreezeMessage && !isAdmin)
		throw new Error(emptyDeepFreezeMessage);
	assertBucketCollaborationAllowed(bucket[0]);

	if (!bucket[0].userId)
		throw new Error("Cannot empty system bucket without owner");

	const owner = await db
		.select()
		.from(users)
		.where(eq(users.id, bucket[0].userId))
		.limit(1);
	if (owner.length === 0) throw new Error("Owner not found");

	const internalPrefix = getInternalPath("", owner[0], bucket[0]);
	await deleteBucketContents(internalPrefix);

	// Reset usage stats for the bucket
	await db
		.update(buckets)
		.set({ totalBytes: 0 })
		.where(eq(buckets.id, bucket[0].id));
}

export async function deleteBucket(
	name: string,
	userId: string,
	isAdmin = false,
) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, name))
		.limit(1);

	if (bucket.length === 0) throw new Error("Bucket not found");
	if (bucket[0].userId !== userId && !isAdmin) throw new Error("Unauthorized");
	if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
	const deleteDeepFreezeMessage = getBucketDeepFreezeMessage(bucket[0]);
	if (deleteDeepFreezeMessage && !isAdmin)
		throw new Error(deleteDeepFreezeMessage);
	if (bucket[0].isSystem) throw new Error("Cannot delete system bucket");

	// Best-effort: remove all objects first so upstream storage doesn't leak
	try {
		if (bucket[0].userId) {
			const owner = await db
				.select()
				.from(users)
				.where(eq(users.id, bucket[0].userId))
				.limit(1);
			if (owner.length > 0) {
				const internalPrefix = getInternalPath("", owner[0], bucket[0]);
				await deleteBucketContents(internalPrefix);
			}
		}
	} catch (e) {
		console.error("Failed to empty bucket during delete:", e);
	}

	await db.delete(buckets).where(eq(buckets.name, name));
	await invalidateBucketAuthCache(name);
}

export async function updateBucketVisibility(
	name: string,
	userId: string,
	isPublic: boolean,
	isAdmin = false,
) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, name))
		.limit(1);

	if (bucket.length === 0) throw new Error("Bucket not found");
	if (bucket[0].userId !== userId && !isAdmin) throw new Error("Unauthorized");
	if (bucket[0].isPaused && !isAdmin) throw new Error("Bucket is paused");
	const visibilityDeepFreezeMessage = getBucketDeepFreezeMessage(bucket[0]);
	if (visibilityDeepFreezeMessage && !isAdmin)
		throw new Error(visibilityDeepFreezeMessage);

	await db.update(buckets).set({ isPublic }).where(eq(buckets.name, name));
	await invalidateBucketAuthCache(name);
}

export async function updateCorsConfig(
	name: string,
	userId: string,
	corsRules: CorsRule[],
	isAdmin = false,
) {
	const access = await getBucketAccessForUser({
		bucketName: name,
		userId,
		isAdmin,
	});
	if (access.bucket.isPaused && !isAdmin) throw new Error("Bucket is paused");
	const updateCorsDeepFreezeMessage = getBucketDeepFreezeMessage(access.bucket);
	if (updateCorsDeepFreezeMessage && !isAdmin)
		throw new Error(updateCorsDeepFreezeMessage);
	assertCanManageCors(access);

	const corsConfig = {
		CORSRules: corsRules,
	};

	await db
		.update(buckets)
		.set({ corsConfig: JSON.stringify(corsConfig) })
		.where(eq(buckets.id, access.bucket.id));
}

export async function addBucketCustomDomain(params: {
	bucketName: string;
	userId: string;
	domain: string;
	makePrimary?: boolean;
	isAdmin?: boolean;
}) {
	const bucket = await getOwnedBucketOrThrow(
		params.bucketName,
		params.userId,
		params.isAdmin,
	);
	const current = parseBucketCustomDomains(bucket.customDomains);
	const normalizedDomain = normalizeCustomDomain(params.domain);
	if (current.some((entry) => entry.domain === normalizedDomain)) {
		throw new Error("Custom domain already exists for this bucket");
	}
	const next = [...current, createCustomDomainRecord(normalizedDomain)].map((entry) => ({
		...entry,
		primary: params.makePrimary ? entry.domain === normalizedDomain : entry.primary,
	}));
	const sanitized = sanitizeBucketCustomDomains(next);
	await db
		.update(buckets)
		.set({ customDomains: serializeBucketCustomDomains(sanitized) })
		.where(eq(buckets.id, bucket.id));
	await invalidateBucketCustomDomainCache(current);
	return sanitized;
}

export async function removeBucketCustomDomain(params: {
	bucketName: string;
	userId: string;
	domain: string;
	isAdmin?: boolean;
}) {
	const bucket = await getOwnedBucketOrThrow(
		params.bucketName,
		params.userId,
		params.isAdmin,
	);
	const current = parseBucketCustomDomains(bucket.customDomains);
	const normalizedDomain = normalizeCustomDomain(params.domain);
	const next = current.filter((entry) => entry.domain !== normalizedDomain);
	const sanitized = sanitizeBucketCustomDomains(next);
	await db
		.update(buckets)
		.set({ customDomains: sanitized.length ? serializeBucketCustomDomains(sanitized) : null })
		.where(eq(buckets.id, bucket.id));
	await invalidateBucketCustomDomainCache(current);
	return sanitized;
}

export async function setPrimaryBucketCustomDomain(params: {
	bucketName: string;
	userId: string;
	domain: string;
	isAdmin?: boolean;
}) {
	const bucket = await getOwnedBucketOrThrow(
		params.bucketName,
		params.userId,
		params.isAdmin,
	);
	const current = parseBucketCustomDomains(bucket.customDomains);
	const normalizedDomain = normalizeCustomDomain(params.domain);
	const exists = current.find((entry) => entry.domain === normalizedDomain);
	if (!exists) {
		throw new Error("Custom domain not found");
	}
	if (!exists.verified) {
		throw new Error("Only verified custom domains can be primary");
	}
	const next = current.map((entry) => ({
		...entry,
		primary: entry.domain === normalizedDomain,
	}));
	const sanitized = sanitizeBucketCustomDomains(next);
	await db
		.update(buckets)
		.set({ customDomains: serializeBucketCustomDomains(sanitized) })
		.where(eq(buckets.id, bucket.id));
	await invalidateBucketCustomDomainCache(current);
	return sanitized;
}

export async function verifyBucketCustomDomain(params: {
	bucketName: string;
	userId: string;
	domain: string;
	isAdmin?: boolean;
}) {
	const bucket = await getOwnedBucketOrThrow(
		params.bucketName,
		params.userId,
		params.isAdmin,
	);
	const current = parseBucketCustomDomains(bucket.customDomains);
	const normalizedDomain = normalizeCustomDomain(params.domain);
	const target = current.find((entry) => entry.domain === normalizedDomain);
	if (!target) {
		throw new Error("Custom domain not found");
	}

	await validateBucketCustomDomainDns(normalizedDomain, target.verificationToken);

	const next = current.map((entry) =>
		entry.domain === normalizedDomain
			? {
					...entry,
					verified: true,
					verifiedAt: new Date().toISOString(),
					primary: entry.primary || !current.some((item) => item.primary && item.verified),
				}
			: entry,
	);
	const sanitized = sanitizeBucketCustomDomains(next);
	await db
		.update(buckets)
		.set({ customDomains: serializeBucketCustomDomains(sanitized) })
		.where(eq(buckets.id, bucket.id));
	await invalidateBucketCustomDomainCache(current);
	return sanitized;
}

export async function listBucketCustomDomains(params: {
	bucketName: string;
	userId: string;
	isAdmin?: boolean;
}): Promise<BucketCustomDomain[]> {
	const bucket = await getOwnedBucketOrThrow(
		params.bucketName,
		params.userId,
		params.isAdmin,
	);
	return parseBucketCustomDomains(bucket.customDomains);
}

export async function revalidateVerifiedCustomDomainsForBucket(bucketId: string) {
	const rows = await db
		.select()
		.from(buckets)
		.where(eq(buckets.id, bucketId))
		.limit(1);
	const bucket = rows[0];
	if (!bucket) return;

	const current = parseBucketCustomDomains(bucket.customDomains);
	if (current.length === 0) return;

	let changed = false;
	const next = await Promise.all(
		current.map(async (domain) => {
			if (!domain.verified) return domain;
			try {
				await validateBucketCustomDomainDns(domain.domain, domain.verificationToken);
				return domain;
			} catch {
				changed = true;
				return {
					...domain,
					verified: false,
					primary: false,
					verifiedAt: null,
				};
			}
		}),
	);

	if (!changed) return;

	const sanitized = sanitizeBucketCustomDomains(next);
	await db
		.update(buckets)
		.set({
			customDomains: sanitized.length
				? serializeBucketCustomDomains(sanitized)
				: null,
		})
		.where(eq(buckets.id, bucket.id));
	await invalidateBucketCustomDomainCache(current);
	console.log(
		`[custom-domain-revalidation] revoked invalid verified domain(s) for ${bucket.name}`,
	);
}

export async function deleteCorsConfig(
	name: string,
	userId: string,
	isAdmin = false,
) {
	const access = await getBucketAccessForUser({
		bucketName: name,
		userId,
		isAdmin,
	});
	if (access.bucket.isPaused && !isAdmin) throw new Error("Bucket is paused");
	const deleteCorsDeepFreezeMessage = getBucketDeepFreezeMessage(access.bucket);
	if (deleteCorsDeepFreezeMessage && !isAdmin)
		throw new Error(deleteCorsDeepFreezeMessage);
	assertCanManageCors(access);

	await db
		.update(buckets)
		.set({ corsConfig: null })
		.where(eq(buckets.id, access.bucket.id));
}

export const BucketService = {
	getBucketsForUser,
	createBucket,
	emptyBucket,
	deleteBucket,
	updateBucketVisibility,
	updateCorsConfig,
	deleteCorsConfig,
	listBucketCustomDomains,
	addBucketCustomDomain,
	removeBucketCustomDomain,
	setPrimaryBucketCustomDomain,
	verifyBucketCustomDomain,
	revalidateVerifiedCustomDomainsForBucket,
};
