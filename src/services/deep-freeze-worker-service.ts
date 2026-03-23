import crypto from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { buckets, deepFreezeJobs, users } from "../db/schema";
import {
	buildDeepFreezeArchive,
	buildDeepFreezeStorageKeys,
	deleteLiveBucketObjects,
	readDeepFreezeManifest,
	restoreDeepFreezeArchive,
} from "./deep-freeze-archive-service";

type DeepFreezeJobRecord = typeof deepFreezeJobs.$inferSelect;

const WORKER_TICK_MS = 4000;
const STALE_JOB_MS = 60_000;
const MAX_PARALLEL_JOBS = 1;

export class DeepFreezeWorkerService {
	private timer: Timer | null = null;
	private readonly workerId =
		`deep-freeze-worker:${process.pid}:${crypto.randomUUID()}`;
	private active = false;

	start() {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, WORKER_TICK_MS);
		if (typeof this.timer === "object" && "unref" in this.timer) {
			this.timer.unref();
		}
	}

	stop() {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private async tick() {
		if (this.active) return;
		this.active = true;
		try {
			await this.requeueStaleJobs();
			const queued = await db
				.select()
				.from(deepFreezeJobs)
				.where(inArray(deepFreezeJobs.status, ["queued", "retrying"]))
				.orderBy(asc(deepFreezeJobs.createdAt))
				.limit(MAX_PARALLEL_JOBS);
			for (const job of queued) {
				await this.processJob(job);
			}
		} finally {
			this.active = false;
		}
	}

	private async requeueStaleJobs() {
		const _staleBefore = new Date(Date.now() - STALE_JOB_MS);
		await db
			.update(deepFreezeJobs)
			.set({
				status: "retrying",
				workerId: null,
				lockToken: null,
				updatedAt: new Date(),
				failureCode: "stale_worker",
				failureMessage: "Previous Deep Freeze worker heartbeat expired.",
			})
			.where(
				and(
					inArray(deepFreezeJobs.status, ["running"]),
					isNull(deepFreezeJobs.completedAt),
				),
			);
	}

	private async processJob(job: DeepFreezeJobRecord) {
		const lockToken = crypto.randomUUID();
		await db
			.update(deepFreezeJobs)
			.set({
				status: "running",
				workerId: this.workerId,
				lockToken,
				startedAt: job.startedAt || new Date(),
				heartbeatAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(deepFreezeJobs.id, job.id));

		await db
			.update(buckets)
			.set({
				deepFreezeLastUpdatedAt: new Date(),
				deepFreezeProgress: 0,
			})
			.where(eq(buckets.id, job.bucketId));

		try {
			const bucket = await db.query.buckets.findFirst({
				where: eq(buckets.id, job.bucketId),
			});
			if (!bucket?.userId) {
				throw new Error("Bucket or owner not found for Deep Freeze job");
			}
			const owner = await db.query.users.findFirst({
				where: eq(users.id, bucket.userId),
			});
			if (!owner) {
				throw new Error("Owner not found for Deep Freeze job");
			}

			const storageKeys = buildDeepFreezeStorageKeys({ bucket });
			const onProgress = async (progress: {
				processedObjects: number;
				totalObjects: number;
				processedBytes: number;
				totalBytes: number;
			}) => {
				const percent =
					progress.totalBytes > 0
						? (progress.processedBytes / progress.totalBytes) * 100
						: progress.totalObjects > 0
							? (progress.processedObjects / progress.totalObjects) * 100
							: 0;
				await db
					.update(buckets)
					.set({
						deepFreezeProgress: percent,
						deepFreezeArchiveBytes: progress.processedBytes,
						deepFreezeLastUpdatedAt: new Date(),
					})
					.where(eq(buckets.id, bucket.id));
				await db
					.update(deepFreezeJobs)
					.set({
						totalObjects: progress.totalObjects,
						processedObjects: progress.processedObjects,
						totalBytes: progress.totalBytes,
						processedBytes: progress.processedBytes,
						progressPercent: percent,
						heartbeatAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(deepFreezeJobs.id, job.id));
			};

			if (job.action === "freeze") {
				const archive = await buildDeepFreezeArchive({
					owner,
					bucket,
					archiveKey: storageKeys.archiveKey,
					manifestKey: storageKeys.manifestKey,
					onProgress,
				});

				await deleteLiveBucketObjects({
					manifest: archive.manifest,
					onProgress,
				});

				await db
					.update(deepFreezeJobs)
					.set({
						status: "completed",
						archiveKey: archive.archiveKey,
						manifestKey: archive.manifestKey,
						checksumSha256: archive.checksumSha256,
						archiveBytes: archive.archiveBytes,
						totalObjects: archive.totalObjects,
						processedObjects: archive.totalObjects,
						totalBytes: archive.totalBytes,
						processedBytes: archive.totalBytes,
						progressPercent: 100,
						manifestJson: JSON.stringify(archive.manifest),
						completedAt: new Date(),
						heartbeatAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(deepFreezeJobs.id, job.id));

				await db
					.update(buckets)
					.set({
						deepFreezeArchiveKey: archive.archiveKey,
						deepFreezeArchiveBytes: archive.archiveBytes,
						deepFreezeProgress: 100,
						deepFreezeLastUpdatedAt: new Date(),
					})
					.where(eq(buckets.id, bucket.id));
			} else {
				const manifest =
					job.manifestJson && job.manifestJson !== "[]"
						? (JSON.parse(job.manifestJson) as Awaited<
								ReturnType<typeof readDeepFreezeManifest>
							>)
						: await readDeepFreezeManifest(
								job.manifestKey || storageKeys.manifestKey,
							);
				const restored = await restoreDeepFreezeArchive({
					owner,
					bucket,
					archiveKey:
						job.archiveKey ||
						bucket.deepFreezeArchiveKey ||
						storageKeys.archiveKey,
					manifest,
					onProgress,
				});

				await db
					.update(deepFreezeJobs)
					.set({
						status: "completed",
						totalObjects: restored.totalObjects,
						processedObjects: restored.totalObjects,
						totalBytes: restored.totalBytes,
						processedBytes: restored.totalBytes,
						progressPercent: 100,
						completedAt: new Date(),
						heartbeatAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(deepFreezeJobs.id, job.id));

				await db
					.update(buckets)
					.set({
						deepFreezeProgress: 100,
						deepFreezeLastUpdatedAt: new Date(),
					})
					.where(eq(buckets.id, bucket.id));
			}
		} catch (error) {
			await db
				.update(buckets)
				.set({
					deepFreezeProgress: 0,
					deepFreezeReason:
						error instanceof Error ? error.message : "Deep Freeze job failed",
					deepFreezeLastUpdatedAt: new Date(),
				})
				.where(eq(buckets.id, job.bucketId));

			await db
				.update(deepFreezeJobs)
				.set({
					status: "failed",
					failureCode: "archive_failed",
					failureMessage:
						error instanceof Error ? error.message : "Deep Freeze job failed",
					retryCount: (job.retryCount || 0) + 1,
					heartbeatAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(deepFreezeJobs.id, job.id));
		}
	}
}

export const deepFreezeWorkerService = new DeepFreezeWorkerService();
