import { eq } from "drizzle-orm";
import { db } from "../db";
import { buckets, deepFreezeJobs } from "../db/schema";
import { getBucketAccessForUser } from "./collaboration-service";
import { buildDeepFreezeStorageKeys } from "./deep-freeze-archive-service";

type BucketRecord = typeof buckets.$inferSelect;

export const DEEP_FREEZE_STATES = [
	"active",
	"freezing",
	"frozen",
	"unfreezing",
] as const;

export type DeepFreezeState = (typeof DEEP_FREEZE_STATES)[number];

export type DeepFreezeSnapshot = {
	state: DeepFreezeState;
	isLocked: boolean;
	progressPercent: number;
	archiveBytes: number;
	estimatedFreezeSeconds: number;
	estimatedUnfreezeSeconds: number;
	etaSeconds: number | null;
	statusLabel: string;
	statusDescription: string;
	archiveKey: string | null;
	requestedAt: string | null;
	startedAt: string | null;
	completedAt: string | null;
	lastUpdatedAt: string | null;
	reason: string | null;
};

const COMPRESS_BYTES_PER_SECOND = 250 * 1024 * 1024;
const RESTORE_BYTES_PER_SECOND = 180 * 1024 * 1024;
const MIN_FREEZE_SECONDS = 3 * 60;
const MIN_UNFREEZE_SECONDS = 4 * 60;
const MAX_FREEZE_SECONDS = 72 * 60 * 60;
const MAX_UNFREEZE_SECONDS = 96 * 60 * 60;
const DEFAULT_COMPRESSION_RATIO = 0.38;

function normalizeState(value: string | null | undefined): DeepFreezeState {
	if (value === "freezing" || value === "frozen" || value === "unfreezing") {
		return value;
	}
	return "active";
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

export function estimateDeepFreezeDurations(totalBytes: number) {
	const safeBytes = Math.max(0, totalBytes || 0);
	const freezeSeconds = Math.max(
		MIN_FREEZE_SECONDS,
		Math.min(
			MAX_FREEZE_SECONDS,
			Math.ceil(safeBytes / COMPRESS_BYTES_PER_SECOND) + 120,
		),
	);
	const unfreezeSeconds = Math.max(
		MIN_UNFREEZE_SECONDS,
		Math.min(
			MAX_UNFREEZE_SECONDS,
			Math.ceil(safeBytes / RESTORE_BYTES_PER_SECOND) + 180,
		),
	);
	const archiveBytes = Math.max(
		1024,
		Math.round(safeBytes * DEFAULT_COMPRESSION_RATIO),
	);

	return {
		freezeSeconds,
		unfreezeSeconds,
		archiveBytes,
	};
}

export function getDeepFreezeSnapshot(
	bucket: BucketRecord,
): DeepFreezeSnapshot {
	const state = normalizeState(bucket.deepFreezeState);
	const estimatedFreezeSeconds = Math.max(
		0,
		Number(bucket.deepFreezeEstimatedFreezeSeconds) || 0,
	);
	const estimatedUnfreezeSeconds = Math.max(
		0,
		Number(bucket.deepFreezeEstimatedUnfreezeSeconds) || 0,
	);
	const startedAt = bucket.deepFreezeStartedAt
		? new Date(bucket.deepFreezeStartedAt)
		: null;
	const nowMs = Date.now();
	const startedMs = startedAt ? startedAt.getTime() : nowMs;
	const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
	const archiveBytes = Math.max(0, Number(bucket.deepFreezeArchiveBytes) || 0);

	if (state === "freezing") {
		const total = Math.max(estimatedFreezeSeconds, 1);
		const progressPercent = clampPercent((elapsedSeconds / total) * 100);
		const etaSeconds = Math.max(0, total - elapsedSeconds);
		return {
			state,
			isLocked: true,
			progressPercent,
			archiveBytes,
			estimatedFreezeSeconds,
			estimatedUnfreezeSeconds,
			etaSeconds,
			statusLabel: "Freezing now",
			statusDescription:
				"This bucket is being packed into a Zstandard archive and moved to cold S3 storage.",
			archiveKey: bucket.deepFreezeArchiveKey || null,
			requestedAt: bucket.deepFreezeRequestedAt?.toISOString() || null,
			startedAt: bucket.deepFreezeStartedAt?.toISOString() || null,
			completedAt: bucket.deepFreezeCompletedAt?.toISOString() || null,
			lastUpdatedAt: bucket.deepFreezeLastUpdatedAt?.toISOString() || null,
			reason: bucket.deepFreezeReason || null,
		};
	}

	if (state === "unfreezing") {
		const total = Math.max(estimatedUnfreezeSeconds, 1);
		const progressPercent = clampPercent((elapsedSeconds / total) * 100);
		const etaSeconds = Math.max(0, total - elapsedSeconds);
		return {
			state,
			isLocked: true,
			progressPercent,
			archiveBytes,
			estimatedFreezeSeconds,
			estimatedUnfreezeSeconds,
			etaSeconds,
			statusLabel: "Unfreezing now",
			statusDescription:
				"This bucket is being restored from Deep Freeze and expanded back into normal storage.",
			archiveKey: bucket.deepFreezeArchiveKey || null,
			requestedAt: bucket.deepFreezeRequestedAt?.toISOString() || null,
			startedAt: bucket.deepFreezeStartedAt?.toISOString() || null,
			completedAt: bucket.deepFreezeCompletedAt?.toISOString() || null,
			lastUpdatedAt: bucket.deepFreezeLastUpdatedAt?.toISOString() || null,
			reason: bucket.deepFreezeReason || null,
		};
	}

	if (state === "frozen") {
		return {
			state,
			isLocked: true,
			progressPercent: 100,
			archiveBytes,
			estimatedFreezeSeconds,
			estimatedUnfreezeSeconds,
			etaSeconds: null,
			statusLabel: "Deep Frozen",
			statusDescription:
				"This bucket is sealed in cold storage. Reads, writes, and file access stay blocked until you unfreeze it.",
			archiveKey: bucket.deepFreezeArchiveKey || null,
			requestedAt: bucket.deepFreezeRequestedAt?.toISOString() || null,
			startedAt: bucket.deepFreezeStartedAt?.toISOString() || null,
			completedAt: bucket.deepFreezeCompletedAt?.toISOString() || null,
			lastUpdatedAt: bucket.deepFreezeLastUpdatedAt?.toISOString() || null,
			reason: bucket.deepFreezeReason || null,
		};
	}

	return {
		state: "active",
		isLocked: false,
		progressPercent: 0,
		archiveBytes,
		estimatedFreezeSeconds,
		estimatedUnfreezeSeconds,
		etaSeconds: null,
		statusLabel: "Available",
		statusDescription:
			"This bucket is online in standard storage and can be frozen when you are ready.",
		archiveKey: bucket.deepFreezeArchiveKey || null,
		requestedAt: bucket.deepFreezeRequestedAt?.toISOString() || null,
		startedAt: bucket.deepFreezeStartedAt?.toISOString() || null,
		completedAt: bucket.deepFreezeCompletedAt?.toISOString() || null,
		lastUpdatedAt: bucket.deepFreezeLastUpdatedAt?.toISOString() || null,
		reason: bucket.deepFreezeReason || null,
	};
}

export async function syncBucketDeepFreezeState(
	bucket: BucketRecord,
): Promise<BucketRecord> {
	const state = normalizeState(bucket.deepFreezeState);
	if (state !== "freezing" && state !== "unfreezing") {
		return bucket;
	}

	const snapshot = getDeepFreezeSnapshot(bucket);
	if (snapshot.etaSeconds !== 0) {
		return {
			...bucket,
			deepFreezeProgress: snapshot.progressPercent,
			deepFreezeLastUpdatedAt: new Date(),
		};
	}

	const now = new Date();
	const nextState = state === "freezing" ? "frozen" : "active";
	const nextValues =
		nextState === "frozen"
			? {
					deepFreezeState: nextState,
					deepFreezeReason:
						"Bucket safely packed into Deep Freeze archive storage.",
					deepFreezeCompletedAt: now,
					deepFreezeProgress: 100,
					deepFreezeLastUpdatedAt: now,
				}
			: {
					deepFreezeState: nextState,
					deepFreezeReason: null,
					deepFreezeCompletedAt: now,
					deepFreezeProgress: 0,
					deepFreezeLastUpdatedAt: now,
				};

	await db.update(buckets).set(nextValues).where(eq(buckets.id, bucket.id));

	return {
		...bucket,
		...nextValues,
		deepFreezeState: nextState,
		deepFreezeReason: nextValues.deepFreezeReason,
		deepFreezeCompletedAt: now,
		deepFreezeProgress: nextState === "frozen" ? 100 : 0,
		deepFreezeLastUpdatedAt: now,
	};
}

export async function syncBucketsDeepFreezeState<T extends BucketRecord>(
	bucketList: T[],
): Promise<T[]> {
	return Promise.all(
		bucketList.map(
			async (bucket) => (await syncBucketDeepFreezeState(bucket)) as T,
		),
	);
}

export function getBucketDeepFreezeMessage(
	bucket: BucketRecord,
): string | null {
	const snapshot = getDeepFreezeSnapshot(bucket);
	if (!snapshot.isLocked) return null;
	if (snapshot.state === "freezing") {
		return "Bucket is entering Deep Freeze. All access is blocked until packaging completes.";
	}
	if (snapshot.state === "unfreezing") {
		return "Bucket is leaving Deep Freeze. All access is blocked until restoration completes.";
	}
	return "Bucket is in Deep Freeze. Unfreeze it before accessing files, reads, or writes.";
}

export async function requestBucketDeepFreezeAction(params: {
	bucketName: string;
	userId: string;
	action: "freeze" | "unfreeze";
	isAdmin?: boolean;
}) {
	const access = await getBucketAccessForUser({
		bucketName: params.bucketName,
		userId: params.userId,
		isAdmin: params.isAdmin,
	});

	if (!access.isOwner && !access.isAdmin) {
		throw new Error("Only the bucket owner can manage Deep Freeze");
	}
	if (access.bucket.isCdn) {
		throw new Error("Deep Freeze is not supported for CDN buckets");
	}
	if (access.bucket.isSystem) {
		throw new Error("Deep Freeze is not supported for system buckets");
	}

	const bucket = await syncBucketDeepFreezeState(access.bucket);
	const snapshot = getDeepFreezeSnapshot(bucket);
	const estimates = estimateDeepFreezeDurations(Number(bucket.totalBytes) || 0);
	const now = new Date();
	const storageKeys = buildDeepFreezeStorageKeys({ bucket });

	if (params.action === "freeze") {
		if (snapshot.state === "freezing") {
			throw new Error("Bucket is already entering Deep Freeze");
		}
		if (snapshot.state === "frozen") {
			throw new Error("Bucket is already in Deep Freeze");
		}
		if (snapshot.state === "unfreezing") {
			throw new Error("Bucket is currently being restored from Deep Freeze");
		}
		if ((Number(bucket.totalBytes) || 0) <= 0) {
			throw new Error(
				"Deep Freeze is only useful for buckets that contain data",
			);
		}

		await db
			.update(buckets)
			.set({
				deepFreezeState: "freezing",
				deepFreezeReason:
					"Packing bucket into a Zstandard archive and transferring it into the Deep Freeze storage prefix.",
				deepFreezeRequestedAt: now,
				deepFreezeStartedAt: now,
				deepFreezeCompletedAt: null,
				deepFreezeArchiveKey: storageKeys.archiveKey,
				deepFreezeArchiveBytes: estimates.archiveBytes,
				deepFreezeProgress: 0,
				deepFreezeEstimatedFreezeSeconds: estimates.freezeSeconds,
				deepFreezeEstimatedUnfreezeSeconds: estimates.unfreezeSeconds,
				deepFreezeLastUpdatedAt: now,
			})
			.where(eq(buckets.id, bucket.id));

		await db.insert(deepFreezeJobs).values({
			bucketId: bucket.id,
			requestedByUserId: params.userId,
			action: "freeze",
			status: "queued",
			archiveKey: storageKeys.archiveKey,
			manifestKey: storageKeys.manifestKey,
			totalBytes: Number(bucket.totalBytes) || 0,
			archiveBytes: estimates.archiveBytes,
			progressPercent: 0,
			createdAt: now,
			updatedAt: now,
		});
	} else {
		if (snapshot.state === "active") {
			throw new Error("Bucket is not in Deep Freeze");
		}
		if (snapshot.state === "freezing") {
			throw new Error("Bucket is still entering Deep Freeze");
		}
		if (snapshot.state === "unfreezing") {
			throw new Error("Bucket is already being restored");
		}

		await db
			.update(buckets)
			.set({
				deepFreezeState: "unfreezing",
				deepFreezeReason:
					"Restoring bucket from the Deep Freeze storage prefix back into primary storage.",
				deepFreezeRequestedAt: now,
				deepFreezeStartedAt: now,
				deepFreezeCompletedAt: null,
				deepFreezeProgress: 0,
				deepFreezeEstimatedFreezeSeconds: estimates.freezeSeconds,
				deepFreezeEstimatedUnfreezeSeconds: estimates.unfreezeSeconds,
				deepFreezeLastUpdatedAt: now,
			})
			.where(eq(buckets.id, bucket.id));

		await db.insert(deepFreezeJobs).values({
			bucketId: bucket.id,
			requestedByUserId: params.userId,
			action: "unfreeze",
			status: "queued",
			archiveKey: bucket.deepFreezeArchiveKey || storageKeys.archiveKey,
			manifestKey: storageKeys.manifestKey,
			totalBytes: Number(bucket.totalBytes) || 0,
			archiveBytes:
				Number(bucket.deepFreezeArchiveBytes) || estimates.archiveBytes,
			progressPercent: 0,
			createdAt: now,
			updatedAt: now,
		});
	}

	const refreshed = await db.query.buckets.findFirst({
		where: eq(buckets.id, bucket.id),
	});
	if (!refreshed) {
		throw new Error("Bucket not found after Deep Freeze update");
	}

	return getDeepFreezeSnapshot(refreshed);
}
