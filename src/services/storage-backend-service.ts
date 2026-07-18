import { and, count, eq, lte, ne, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import {
	storageBackendAdminEvents,
	storageRegionBackends,
	storageRegionState,
	storageReplicationDeliveries,
	storageReplicationEvents,
} from "../db/schema";
import { isStorageRegionId, type StorageRegionId } from "../lib/regions";

const BACKEND_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROMOTION_FRESHNESS_MS = 5 * 60 * 1000;
const MAX_OPERATION_REASON_LENGTH = 2_000;

function assertBackendId(backendId: string) {
	if (!BACKEND_ID_PATTERN.test(backendId)) {
		throw new Error(
			"Backend ID must be 1-63 lowercase alphanumeric or hyphen characters",
		);
	}
}

function assertRegionId(regionId: string): asserts regionId is StorageRegionId {
	if (!isStorageRegionId(regionId)) {
		throw new Error(`Unknown storage region: ${regionId}`);
	}
}

async function assertBackendConfiguredInDataplanes(
	regionId: StorageRegionId,
	backendId: string,
) {
	if (!config.dataplane.internalSecret) {
		throw new Error("DATAPLANE_INTERNAL_SECRET is required");
	}
	for (const [dataplaneRegion, baseUrl] of Object.entries(
		config.dataplane.regionUrls,
	)) {
		const response = await fetch(`${baseUrl}/ready`, {
			headers: {
				"x-dataplane-secret": config.dataplane.internalSecret,
			},
			signal: AbortSignal.timeout(15_000),
		});
		const readiness = (await response.json().catch(() => null)) as {
			region?: unknown;
			storageBackends?: Record<string, Record<string, unknown>>;
		} | null;
		if (!response.ok) {
			throw new Error(
				`Cannot verify backend configuration on the ${dataplaneRegion} dataplane (${response.status})`,
			);
		}
		if (readiness?.region !== dataplaneRegion) {
			throw new Error(
				`Cannot register providers while ${dataplaneRegion} is not served by its normal dataplane`,
			);
		}
		if (
			!readiness.storageBackends?.[regionId] ||
			!Object.hasOwn(readiness.storageBackends[regionId], backendId)
		) {
			throw new Error(
				`Backend ${regionId}/${backendId} is not configured on the ${dataplaneRegion} dataplane`,
			);
		}
	}
}

async function lockStorageRegion(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	regionId: StorageRegionId,
) {
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${`silo:storage-region:${regionId}`}, 0))`,
	);
}

export async function listStorageRegionBackends(regionId?: StorageRegionId) {
	const query = db
		.select({
			regionId: storageRegionBackends.regionId,
			backendId: storageRegionBackends.backendId,
			provider: storageRegionBackends.provider,
			bucketName: storageRegionBackends.bucketName,
			role: storageRegionBackends.role,
			status: storageRegionBackends.status,
			promotionAuthorized: storageRegionBackends.promotionAuthorized,
			replicationCheckpoint: storageRegionBackends.replicationCheckpoint,
			replicationCaughtUpAt: storageRegionBackends.replicationCaughtUpAt,
			lastVerifiedAt: storageRegionBackends.lastVerifiedAt,
			bootstrapState: storageRegionBackends.bootstrapState,
			bootstrapBarrierSequence: storageRegionBackends.bootstrapBarrierSequence,
			bootstrapCursor: storageRegionBackends.bootstrapCursor,
			bootstrapObjectsCopied: storageRegionBackends.bootstrapObjectsCopied,
			bootstrapBytesCopied: storageRegionBackends.bootstrapBytesCopied,
			bootstrapSourceBackendId: storageRegionBackends.bootstrapSourceBackendId,
			bootstrapSourceGeneration:
				storageRegionBackends.bootstrapSourceGeneration,
			bootstrapStartedAt: storageRegionBackends.bootstrapStartedAt,
			bootstrapHeartbeatAt: storageRegionBackends.bootstrapHeartbeatAt,
			bootstrapCompletedAt: storageRegionBackends.bootstrapCompletedAt,
			bootstrapVerifiedAt: storageRegionBackends.bootstrapVerifiedAt,
			bootstrapLastError: storageRegionBackends.bootstrapLastError,
			updatedAt: storageRegionBackends.updatedAt,
		})
		.from(storageRegionBackends);
	return regionId
		? query.where(eq(storageRegionBackends.regionId, regionId))
		: query;
}

export async function registerStorageRegionBackend(params: {
	regionId: StorageRegionId;
	backendId: string;
	provider: string;
	bucketName?: string | null;
	role?: "primary" | "replica";
	actor: string;
}) {
	assertRegionId(params.regionId);
	assertBackendId(params.backendId);
	const provider = params.provider.trim();
	const bucketName = params.bucketName?.trim() || null;
	const actor = params.actor.trim();
	if (!provider || provider.length > 128) throw new Error("Invalid provider");
	if (bucketName && bucketName.length > 255)
		throw new Error("Invalid physical bucket name");
	if (!actor) throw new Error("Backend registration requires an actor");
	await assertBackendConfiguredInDataplanes(params.regionId, params.backendId);

	return db.transaction(async (tx) => {
		await lockStorageRegion(tx, params.regionId);
		const [state] = await tx
			.select({ regionId: storageRegionState.regionId })
			.from(storageRegionState)
			.where(eq(storageRegionState.regionId, params.regionId))
			.limit(1);
		if (!state) throw new Error(`Unknown storage region: ${params.regionId}`);
		const [existing] = await tx
			.select({ backendId: storageRegionBackends.backendId })
			.from(storageRegionBackends)
			.where(
				and(
					eq(storageRegionBackends.regionId, params.regionId),
					eq(storageRegionBackends.backendId, params.backendId),
				),
			)
			.limit(1);
		if (existing) {
			throw new Error(
				`Backend identity ${params.regionId}/${params.backendId} already exists and cannot be replaced`,
			);
		}
		const [backend] = await tx
			.insert(storageRegionBackends)
			.values({
				regionId: params.regionId,
				backendId: params.backendId,
				provider,
				bucketName,
				role: params.role || "replica",
				status: "standby",
				promotionAuthorized: false,
				bootstrapState: "pending",
			})
			.returning();
		await tx.insert(storageBackendAdminEvents).values({
			regionId: params.regionId,
			backendId: params.backendId,
			action: "register",
			actor,
			detailsJson: JSON.stringify({ provider, bucketName, role: backend.role }),
		});
		return backend;
	});
}

export async function startStorageBackendBootstrap(params: {
	regionId: StorageRegionId;
	targetBackendId: string;
	actor: string;
	reason: string;
	retry?: boolean;
}) {
	assertRegionId(params.regionId);
	assertBackendId(params.targetBackendId);
	const actor = params.actor.trim();
	const reason = params.reason.trim();
	if (!actor || !reason) {
		throw new Error("Storage bootstrap requires an actor and reason");
	}
	if (reason.length > MAX_OPERATION_REASON_LENGTH) {
		throw new Error(
			`Storage bootstrap reason must be at most ${MAX_OPERATION_REASON_LENGTH} characters`,
		);
	}
	if (!config.dataplane.internalSecret) {
		throw new Error("DATAPLANE_INTERNAL_SECRET is required for bootstrap");
	}

	const [record] = await db
		.select({
			activeBackendId: storageRegionState.activeBackendId,
			status: storageRegionBackends.status,
			bootstrapState: storageRegionBackends.bootstrapState,
		})
		.from(storageRegionBackends)
		.innerJoin(
			storageRegionState,
			eq(storageRegionState.regionId, storageRegionBackends.regionId),
		)
		.where(
			and(
				eq(storageRegionBackends.regionId, params.regionId),
				eq(storageRegionBackends.backendId, params.targetBackendId),
			),
		)
		.limit(1);
	if (!record) throw new Error("Storage backend not found");
	if (record.activeBackendId === params.targetBackendId) {
		throw new Error("The active backend cannot be bootstrapped from itself");
	}
	if (record.status !== "standby") {
		throw new Error("Only a healthy standby backend can be bootstrapped");
	}
	if (params.retry) {
		if (record.bootstrapState !== "failed") {
			throw new Error("Only a failed storage bootstrap can be retried");
		}
	} else if (record.bootstrapState !== "pending") {
		throw new Error("Only a pending storage backend can start bootstrap");
	}

	const operation = params.retry ? "retry" : "start";
	const response = await fetch(
		`${config.dataplane.regionUrls[params.regionId]}/api/internal/storage/bootstrap/${operation}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-dataplane-secret": config.dataplane.internalSecret,
			},
			body: JSON.stringify({
				region: params.regionId,
				backendId: params.targetBackendId,
				actor,
				reason,
			}),
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (!response.ok) {
		const message = await response.text().catch(() => "");
		throw new Error(message || `Storage bootstrap failed (${response.status})`);
	}
	const result = await response.json().catch(() => ({ ok: true }));
	await db.insert(storageBackendAdminEvents).values({
		regionId: params.regionId,
		backendId: params.targetBackendId,
		action: params.retry ? "bootstrap_retry" : "bootstrap",
		actor,
		detailsJson: JSON.stringify({ reason }),
	});
	return result;
}

export async function updateStorageRegionBackendStatus(params: {
	regionId: StorageRegionId;
	backendId: string;
	status: "standby" | "unavailable" | "disabled";
	actor: string;
}) {
	assertRegionId(params.regionId);
	assertBackendId(params.backendId);
	const actor = params.actor.trim();
	if (!actor) throw new Error("Backend update requires an actor");

	return db.transaction(async (tx) => {
		await lockStorageRegion(tx, params.regionId);
		const [state] = await tx
			.select({ activeBackendId: storageRegionState.activeBackendId })
			.from(storageRegionState)
			.where(eq(storageRegionState.regionId, params.regionId))
			.limit(1);
		if (!state) throw new Error(`Unknown storage region: ${params.regionId}`);
		if (state.activeBackendId === params.backendId) {
			throw new Error("The active backend can only change through promotion");
		}
		const [backend] = await tx
			.update(storageRegionBackends)
			.set({
				status: params.status,
				promotionAuthorized: false,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(storageRegionBackends.regionId, params.regionId),
					eq(storageRegionBackends.backendId, params.backendId),
					ne(storageRegionBackends.status, "active"),
				),
			)
			.returning();
		if (!backend) throw new Error("Storage backend not found");
		await tx.insert(storageBackendAdminEvents).values({
			regionId: params.regionId,
			backendId: params.backendId,
			action: "status",
			actor,
			detailsJson: JSON.stringify({ status: params.status }),
		});
		return backend;
	});
}

export async function authorizeStorageBackendPromotion(params: {
	regionId: StorageRegionId;
	targetBackendId: string;
	actor: string;
}) {
	assertRegionId(params.regionId);
	assertBackendId(params.targetBackendId);
	const actor = params.actor.trim();
	if (!actor) throw new Error("Promotion authorization requires an actor");

	return db.transaction(async (tx) => {
		await lockStorageRegion(tx, params.regionId);
		const [state] = await tx
			.select()
			.from(storageRegionState)
			.where(eq(storageRegionState.regionId, params.regionId))
			.limit(1);
		if (!state) throw new Error(`Unknown storage region: ${params.regionId}`);
		if (state.activeBackendId === params.targetBackendId) {
			throw new Error("The active backend cannot be a promotion target");
		}
		const [target] = await tx
			.select()
			.from(storageRegionBackends)
			.where(
				and(
					eq(storageRegionBackends.regionId, params.regionId),
					eq(storageRegionBackends.backendId, params.targetBackendId),
				),
			)
			.limit(1);
		if (!target) throw new Error("Storage backend not found");
		if (target.status !== "standby") {
			throw new Error("Only a healthy standby backend can be authorized");
		}
		if (
			target.bootstrapState !== "complete" ||
			target.bootstrapBarrierSequence === null ||
			!target.bootstrapCompletedAt ||
			!target.bootstrapVerifiedAt
		) {
			throw new Error(
				"Standby historical bootstrap has not completed and been verified",
			);
		}
		if (target.replicationCheckpoint < target.bootstrapBarrierSequence) {
			throw new Error("Standby is behind its historical bootstrap barrier");
		}
		if (target.replicationCheckpoint < state.requiredReplicationCheckpoint) {
			throw new Error("Standby replication is behind the required checkpoint");
		}
		const freshnessFloor = Date.now() - PROMOTION_FRESHNESS_MS;
		if (
			!target.replicationCaughtUpAt ||
			!target.lastVerifiedAt ||
			target.bootstrapVerifiedAt.getTime() < freshnessFloor ||
			target.replicationCaughtUpAt.getTime() < freshnessFloor ||
			target.lastVerifiedAt.getTime() < freshnessFloor
		) {
			throw new Error("Standby replication or verification evidence is stale");
		}

		const [prepared] = await tx
			.select({ value: count() })
			.from(storageReplicationEvents)
			.where(
				and(
					eq(storageReplicationEvents.regionId, params.regionId),
					eq(storageReplicationEvents.state, "prepared"),
				),
			);
		if ((prepared?.value ?? 0) > 0) {
			throw new Error(
				"Prepared storage mutations still require reconciliation",
			);
		}
		const [outstanding] = await tx
			.select({ value: count() })
			.from(storageReplicationDeliveries)
			.where(
				and(
					eq(storageReplicationDeliveries.regionId, params.regionId),
					eq(
						storageReplicationDeliveries.targetBackendId,
						params.targetBackendId,
					),
					ne(storageReplicationDeliveries.status, "complete"),
					lte(
						storageReplicationDeliveries.sequence,
						state.requiredReplicationCheckpoint,
					),
				),
			);
		if ((outstanding?.value ?? 0) > 0) {
			throw new Error("Standby still has outstanding replication deliveries");
		}

		await tx
			.update(storageRegionBackends)
			.set({ promotionAuthorized: false, updatedAt: new Date() })
			.where(eq(storageRegionBackends.regionId, params.regionId));
		const [authorized] = await tx
			.update(storageRegionBackends)
			.set({ promotionAuthorized: true, updatedAt: new Date() })
			.where(
				and(
					eq(storageRegionBackends.regionId, params.regionId),
					eq(storageRegionBackends.backendId, params.targetBackendId),
					eq(storageRegionBackends.status, "standby"),
				),
			)
			.returning();
		if (!authorized) throw new Error("Standby changed during authorization");
		await tx.insert(storageBackendAdminEvents).values({
			regionId: params.regionId,
			backendId: params.targetBackendId,
			action: "authorize",
			actor,
			detailsJson: JSON.stringify({
				requiredReplicationCheckpoint:
					state.requiredReplicationCheckpoint.toString(),
			}),
		});
		return authorized;
	});
}

export async function revokeStorageBackendPromotion(params: {
	regionId: StorageRegionId;
	targetBackendId: string;
	actor: string;
}) {
	assertRegionId(params.regionId);
	assertBackendId(params.targetBackendId);
	const actor = params.actor.trim();
	if (!actor) throw new Error("Promotion revocation requires an actor");
	return db.transaction(async (tx) => {
		await lockStorageRegion(tx, params.regionId);
		const [backend] = await tx
			.update(storageRegionBackends)
			.set({ promotionAuthorized: false, updatedAt: new Date() })
			.where(
				and(
					eq(storageRegionBackends.regionId, params.regionId),
					eq(storageRegionBackends.backendId, params.targetBackendId),
				),
			)
			.returning();
		if (!backend) throw new Error("Storage backend not found");
		await tx.insert(storageBackendAdminEvents).values({
			regionId: params.regionId,
			backendId: params.targetBackendId,
			action: "revoke",
			actor,
			detailsJson: "{}",
		});
		return backend;
	});
}

export async function listStorageRegionStatuses() {
	return db
		.select({
			regionId: storageRegionState.regionId,
			activeBackendId: storageRegionState.activeBackendId,
			backendGeneration: storageRegionState.backendGeneration,
			requiredReplicationCheckpoint:
				storageRegionState.requiredReplicationCheckpoint,
			provider: storageRegionBackends.provider,
			bucketName: storageRegionBackends.bucketName,
			status: storageRegionBackends.status,
			replicationCheckpoint: storageRegionBackends.replicationCheckpoint,
			lastVerifiedAt: storageRegionBackends.lastVerifiedAt,
			bootstrapState: storageRegionBackends.bootstrapState,
			bootstrapBarrierSequence: storageRegionBackends.bootstrapBarrierSequence,
			bootstrapObjectsCopied: storageRegionBackends.bootstrapObjectsCopied,
			bootstrapBytesCopied: storageRegionBackends.bootstrapBytesCopied,
			bootstrapHeartbeatAt: storageRegionBackends.bootstrapHeartbeatAt,
			bootstrapCompletedAt: storageRegionBackends.bootstrapCompletedAt,
			bootstrapVerifiedAt: storageRegionBackends.bootstrapVerifiedAt,
			bootstrapLastError: storageRegionBackends.bootstrapLastError,
		})
		.from(storageRegionState)
		.innerJoin(
			storageRegionBackends,
			and(
				eq(storageRegionBackends.regionId, storageRegionState.regionId),
				eq(storageRegionBackends.backendId, storageRegionState.activeBackendId),
			),
		);
}

export async function promoteStorageBackend(params: {
	regionId: StorageRegionId;
	targetBackendId: string;
	actor: string;
	reason: string;
}) {
	assertRegionId(params.regionId);
	assertBackendId(params.targetBackendId);
	if (!params.actor.trim() || !params.reason.trim()) {
		throw new Error("Storage backend promotion requires an actor and reason");
	}
	if (params.reason.trim().length > MAX_OPERATION_REASON_LENGTH) {
		throw new Error(
			`Storage promotion reason must be at most ${MAX_OPERATION_REASON_LENGTH} characters`,
		);
	}
	if (!config.dataplane.internalSecret) {
		throw new Error("DATAPLANE_INTERNAL_SECRET is required for promotion");
	}
	const [state] = await db
		.select({ backendGeneration: storageRegionState.backendGeneration })
		.from(storageRegionState)
		.where(eq(storageRegionState.regionId, params.regionId))
		.limit(1);
	if (!state) throw new Error(`Unknown storage region: ${params.regionId}`);

	const response = await fetch(
		`${config.dataplane.regionUrls[params.regionId]}/api/internal/storage/promote`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-dataplane-secret": config.dataplane.internalSecret,
			},
			body: JSON.stringify({
				region: params.regionId,
				targetBackendId: params.targetBackendId,
				expectedBackendGeneration: state.backendGeneration.toString(),
				actor: params.actor.trim(),
				reason: params.reason.trim(),
			}),
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (!response.ok) {
		const message = await response.text().catch(() => "");
		throw new Error(message || `Storage promotion failed (${response.status})`);
	}
	return response.json();
}
