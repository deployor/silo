import { and, count, eq, inArray, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import {
	bucketDeletionTombstones,
	bucketKeys,
	buckets,
	dataplaneMutationIntents,
	users,
} from "../db/schema";
import {
	type BucketCustomDomain,
	createCustomDomainRecord,
	invalidateBucketCustomDomainCache,
	normalizeCustomDomain,
	parseBucketCustomDomains,
	sanitizeBucketCustomDomains,
	serializeBucketCustomDomains,
} from "../lib/bucket-domains";
import {
	applyCloudflareHostnameState,
	createCloudflareCustomHostname,
	deleteCloudflareCustomHostname,
	getCloudflareCustomHostname,
	isCloudflareForSaasConfigured,
} from "../lib/cloudflare-for-saas";
import { invalidateDataplaneAuthCache } from "../lib/dataplane-cache";
import {
	beginDataplaneBucketTeardown,
	releaseDataplaneBucketTeardown,
} from "../lib/dataplane-storage-client";
import { redis } from "../lib/redis";
import {
	isRequestedBucketRegion,
	type RequestedBucketRegion,
	resolveRequestedRegion,
} from "../lib/regions";
import { buildCorsConfig } from "../lib/s3/cors";
import {
	deleteBucketContents,
	getInternalPath,
	isReservedBucketName,
} from "../lib/s3/paths";
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
		invalidateDataplaneAuthCache({ bucketName }),
	]);
}

async function pauseBucketForDestructiveOperation(
	bucket: typeof buckets.$inferSelect,
	reason: string,
) {
	await db
		.update(buckets)
		.set({
			isPaused: true,
			pauseReason: reason,
			updatedAt: new Date(),
		})
		.where(eq(buckets.id, bucket.id));
	await invalidateBucketAuthCache(bucket.name);
}

async function restoreBucketPauseState(bucket: typeof buckets.$inferSelect) {
	await db
		.update(buckets)
		.set({
			isPaused: bucket.isPaused,
			pauseReason: bucket.pauseReason,
			updatedAt: new Date(),
		})
		.where(eq(buckets.id, bucket.id));
	await invalidateBucketAuthCache(bucket.name);
}

async function finalizeBucketDeletion(params: {
	bucket: typeof buckets.$inferSelect;
	rootPrefix: string | null;
	deletedByUserId: string;
}) {
	await db.transaction(async (tx) => {
		// The exclusive dataplane proof guarantees accounting is flushed. Keep
		// unresolved prepared/committed intents as a fail-closed FK blocker, while
		// terminal journal rows can be retired with the bucket metadata.
		await tx
			.delete(dataplaneMutationIntents)
			.where(
				and(
					eq(dataplaneMutationIntents.bucketId, params.bucket.id),
					inArray(dataplaneMutationIntents.state, ["applied", "cancelled"]),
				),
			);
		await tx
			.insert(bucketDeletionTombstones)
			.values({
				bucketId: params.bucket.id,
				bucketName: params.bucket.name,
				ownerUserId: params.bucket.userId,
				requestedRegion: params.bucket.requestedRegion,
				resolvedRegion: params.bucket.resolvedRegion,
				rootPrefix: params.rootPrefix,
				deletedByUserId: params.deletedByUserId,
			})
			.onConflictDoNothing();
		await tx.delete(buckets).where(eq(buckets.id, params.bucket.id));
	});
}

export type CorsRule = {
	ID?: string;
	AllowedOrigins: string[];
	AllowedMethods: string[];
	AllowedHeaders?: string[];
	ExposeHeaders?: string[];
	MaxAgeSeconds?: number;
};

async function syncBucketCustomDomainState(domain: BucketCustomDomain) {
	if (!isCloudflareForSaasConfigured()) {
		throw new Error(
			"Cloudflare for SaaS is not configured. Set CF_API_TOKEN, CF_ZONE_ID, and CF_SAAS_FALLBACK_ORIGIN.",
		);
	}
	if (!domain.hostnameId) {
		throw new Error("Custom domain is missing its Cloudflare hostname ID");
	}
	const remote = await getCloudflareCustomHostname(domain.hostnameId);
	return applyCloudflareHostnameState(domain, remote);
}

function assertCustomDomainsEnabled() {
	if (!config.customDomainsEnabled) {
		throw new Error("Custom domains are currently disabled");
	}
}

async function syncCustomDomainsForBucketRecord(
	bucket: typeof buckets.$inferSelect,
) {
	const current = parseBucketCustomDomains(bucket.customDomains);
	if (!isCloudflareForSaasConfigured()) {
		return current;
	}

	let changed = false;
	const next = await Promise.all(
		current.map(async (domain) => {
			if (!domain.hostnameId) return domain;
			try {
				const synced = await syncBucketCustomDomainState(domain);
				if (JSON.stringify(synced) !== JSON.stringify(domain)) {
					changed = true;
				}
				return synced.verified
					? synced
					: {
							...synced,
							primary: false,
							verifiedAt: null,
						};
			} catch (error) {
				console.error("custom domain sync failed", error);
				return domain;
			}
		}),
	);

	if (changed) {
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
		return sanitized;
	}

	return next;
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

	const ownedBucketsWithDomains = await Promise.all(
		bucketsWithKeys.map(async (bucket) => ({
			...bucket,
			customDomains: await syncCustomDomainsForBucketRecord(bucket),
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
	);

	return [...ownedBucketsWithDomains, ...sharedKeys];
}

async function getOwnedBucketOrThrow(
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
	const deepFreezeMessage = getBucketDeepFreezeMessage(bucket[0]);
	if (deepFreezeMessage && !isAdmin) throw new Error(deepFreezeMessage);
	return bucket[0];
}

export async function createBucket(
	userId: string,
	name: string,
	requestedRegion: RequestedBucketRegion = "auto",
) {
	if (!name || !/^[a-z0-9-]+$/.test(name)) {
		throw new Error("Invalid bucket name");
	}
	if (!isRequestedBucketRegion(requestedRegion)) {
		throw new Error("Unsupported storage region");
	}
	const resolvedRegion = resolveRequestedRegion(requestedRegion);

	if (isReservedBucketName(name)) {
		throw new Error("Bucket name is reserved for system use");
	}

	const settings = await getAppSettings();
	const maxBuckets = settings.defaultMaxBucketsPerUser;
	let newBucket: (typeof buckets.$inferSelect)[];
	try {
		newBucket = await db.transaction(async (tx) => {
			// Serialize quota decisions for one owner across all Bun instances.
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`silo:bucket-owner:${userId}`}, 0))`,
			);
			const [user] = await tx
				.select({ isImmortal: users.isImmortal })
				.from(users)
				.where(eq(users.id, userId))
				.limit(1);
			if (!user) throw new Error("User not found");

			const [bucketCount] = await tx
				.select({ value: count() })
				.from(buckets)
				.where(eq(buckets.userId, userId));
			if (!user.isImmortal && (bucketCount?.value ?? 0) >= maxBuckets) {
				throw new Error(`Bucket limit reached (${maxBuckets})`);
			}

			return tx
				.insert(buckets)
				.values({
					name,
					userId,
					region: requestedRegion,
					requestedRegion,
					resolvedRegion,
					corsConfig: JSON.stringify(buildCorsConfig()),
				})
				.returning();
		});
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "23505"
		) {
			throw new Error("Bucket name already taken");
		}
		throw error;
	}

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
	await pauseBucketForDestructiveOperation(
		bucket[0],
		"Bucket empty operation in progress",
	);
	let teardownToken: string | null = null;
	try {
		await deleteBucketContents(internalPrefix, bucket[0]);
		teardownToken = await beginDataplaneBucketTeardown(bucket[0]);

		// Reset only after all asynchronous accounting deltas are in Aiven.
		await db
			.update(buckets)
			.set({ totalBytes: 0, updatedAt: new Date() })
			.where(eq(buckets.id, bucket[0].id));
	} catch (error) {
		if (teardownToken) {
			await releaseDataplaneBucketTeardown(bucket[0], teardownToken).catch(
				(releaseError) =>
					console.error(
						"Failed to release rejected empty-bucket fence",
						releaseError,
					),
			);
		}
		throw error;
	}
	if (teardownToken) {
		await releaseDataplaneBucketTeardown(bucket[0], teardownToken).catch(
			(error) =>
				console.error("Failed to release completed empty-bucket fence", error),
		);
	}
	await restoreBucketPauseState(bucket[0]);
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
	await pauseBucketForDestructiveOperation(
		bucket[0],
		"Bucket deletion in progress",
	);

	// Never remove authoritative metadata unless fenced storage deletion succeeds.
	let internalPrefix: string | null = null;
	try {
		if (bucket[0].userId) {
			const owner = await db
				.select()
				.from(users)
				.where(eq(users.id, bucket[0].userId))
				.limit(1);
			if (owner.length === 0) throw new Error("Owner not found");
			internalPrefix = getInternalPath("", owner[0], bucket[0]);
			await deleteBucketContents(internalPrefix, bucket[0]);
		}
	} catch (e) {
		console.error("Failed to empty bucket during delete:", e);
		throw new Error("Bucket storage could not be verified as empty");
	}

	const teardownToken = await beginDataplaneBucketTeardown(bucket[0]);
	try {
		await finalizeBucketDeletion({
			bucket: bucket[0],
			rootPrefix: internalPrefix,
			deletedByUserId: userId,
		});
	} catch (error) {
		await releaseDataplaneBucketTeardown(bucket[0], teardownToken).catch(
			(releaseError) =>
				console.error(
					"Failed to release rejected bucket teardown",
					releaseError,
				),
		);
		throw error;
	}
	// The metadata transaction already committed. The dataplane also expires
	// abandoned locks, so a release transport failure must not misreport it.
	await releaseDataplaneBucketTeardown(bucket[0], teardownToken).catch(
		(error) =>
			console.error("Failed to release finalized bucket teardown fence", error),
	);
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
	await invalidateBucketAuthCache(name);
}

export async function addBucketCustomDomain(params: {
	bucketName: string;
	userId: string;
	domain: string;
	makePrimary?: boolean;
	isAdmin?: boolean;
}) {
	assertCustomDomainsEnabled();
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
	const created = createCustomDomainRecord(normalizedDomain);
	const provisioned = isCloudflareForSaasConfigured()
		? { ...created, ...(await createCloudflareCustomHostname(created)) }
		: created;
	const next = [...current, provisioned].map((entry) => ({
		...entry,
		primary: params.makePrimary
			? entry.domain === normalizedDomain
			: entry.primary,
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
	assertCustomDomainsEnabled();
	const bucket = await getOwnedBucketOrThrow(
		params.bucketName,
		params.userId,
		params.isAdmin,
	);
	const current = parseBucketCustomDomains(bucket.customDomains);
	const normalizedDomain = normalizeCustomDomain(params.domain);
	const target = current.find((entry) => entry.domain === normalizedDomain);
	if (target?.hostnameId && isCloudflareForSaasConfigured()) {
		await deleteCloudflareCustomHostname(target.hostnameId).catch((error) => {
			console.error("failed to delete Cloudflare custom hostname", error);
		});
	}
	const next = current.filter((entry) => entry.domain !== normalizedDomain);
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
	return sanitized;
}

export async function setPrimaryBucketCustomDomain(params: {
	bucketName: string;
	userId: string;
	domain: string;
	isAdmin?: boolean;
}) {
	assertCustomDomainsEnabled();
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
	assertCustomDomainsEnabled();
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

	const synced = await syncBucketCustomDomainState(target);
	if (!synced.verified) {
		throw new Error(
			synced.verificationErrors?.[0] ||
				`Domain is still pending in Cloudflare (status: ${synced.status || "pending"}, SSL: ${synced.sslStatus || "pending"})`,
		);
	}

	const next = current.map((entry) =>
		entry.domain === normalizedDomain
			? {
					...synced,
					primary:
						target.primary ||
						!current.some((item) => item.primary && item.verified),
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
	if (!config.customDomainsEnabled) {
		return [];
	}
	const bucket = await getOwnedBucketOrThrow(
		params.bucketName,
		params.userId,
		params.isAdmin,
	);
	return syncCustomDomainsForBucketRecord(bucket);
}

export async function revalidateVerifiedCustomDomainsForBucket(
	bucketId: string,
) {
	if (!config.customDomainsEnabled) return;
	const rows = await db
		.select()
		.from(buckets)
		.where(eq(buckets.id, bucketId))
		.limit(1);
	const bucket = rows[0];
	if (!bucket) return;

	const current = parseBucketCustomDomains(bucket.customDomains);
	if (current.length === 0) return;
	await syncCustomDomainsForBucketRecord(bucket);
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
		.set({ corsConfig: JSON.stringify(buildCorsConfig()) })
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
