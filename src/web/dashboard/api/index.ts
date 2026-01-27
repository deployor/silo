import { eq, sql } from "drizzle-orm";
import { config } from "../../../config";
import { postUploadSummary } from "../../../integrations/slack/message-handler";
import { getAppSettings } from "../../../services/settings-service";
import { getInternalPath } from "../../../core/s3/utils";
import { db } from "../../../db";
import { buckets, requestLogs, users } from "../../../db/schema";
import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import { s3Client } from "../../../lib/s3-client";
import { getCurrentUser } from "../../../lib/session";
import { getBucketsForUser } from "../../../services/bucket-service";
import { handleBucketOperations, handleBuckets } from "./buckets";
import { handleCors } from "./cors";
import { handleFiles } from "./files";
import { handleKeys } from "./keys";

export async function handleApiRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	if (path === "/api/onboarding/complete" && req.method === "POST") {
		const user = await getCurrentUser(req);
		if (!user) return errorResponse("Unauthorized", 401);

		await db
			.update(users)
			.set({ onboarded: true })
			.where(eq(users.id, user.id));

		const headers = new Headers();
		headers.set("Location", "/");
		return new Response(null, { status: 302, headers });
	}

	if (path === "/api/cdn/upload" && req.method === "POST") {
		const user = await getCurrentUser(req);
		if (!user) return errorResponse("Unauthorized", 401);
		if (user.isLocked) return errorResponse("Account Locked", 403);
		if (!user.slackId) return errorResponse("Slack account required", 403);

		try {
			const formData = await req.formData();
			const file = formData.get("file");

			if (!file || !(file instanceof File)) {
				return errorResponse("No file uploaded", 400);
			}

			const bucketName = user.slackId.toLowerCase();
			let bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);

			if (bucket.length === 0) {
				const newBucket = await db
					.insert(buckets)
					.values({
						name: bucketName,
						userId: user.id,
						isPublic: true,
						isCdn: true,
						region: "auto",
					})
					.returning();
				bucket = newBucket;
			}
			const targetBucket = bucket[0];

			if (targetBucket.isPaused) {
				return errorResponse(`Bucket paused: ${targetBucket.pauseReason}`, 403);
			}

			const usageResult = await db
				.select({ total: sql<number>`sum(${buckets.totalBytes})` })
				.from(buckets)
				.where(eq(buckets.userId, user.id));
			const currentUsage = Number(usageResult[0]?.total) || 0;
			const limit = user.storageLimitBytes || (await getAppSettings()).defaultStorageLimitBytes;

			if (currentUsage + file.size > limit) {
				return errorResponse("Quota exceeded", 403);
			}

			const ext = file.name.split(".").pop();
			const hash = crypto.randomUUID();
			const fileName = `${hash}.${ext}`;
			const internalPath = getInternalPath(fileName, user, targetBucket);
			const fileBuffer = await file.arrayBuffer();

			const s3Res = await s3Client.fetch(internalPath, {
				method: "PUT",
				body: fileBuffer,
				headers: {
					"Content-Type": file.type || "application/octet-stream",
					"Content-Length": file.size.toString(),
				},
			});

			if (!s3Res.ok) {
				throw new Error(`S3 Upload Failed: ${s3Res.status}`);
			}

			await db
				.update(buckets)
				.set({
					totalBytes: sql`${buckets.totalBytes} + ${file.size}`,
					totalRequests: sql`${buckets.totalRequests} + 1`,
				})
				.where(eq(buckets.id, targetBucket.id));

			await db.insert(requestLogs).values({
				bucketId: targetBucket.id,
				bucketName: targetBucket.name,
				ownerId: user.id,
				requesterId: user.id,
				method: "PUT",
				path: fileName,
				statusCode: 200,
				ingressBytes: file.size,
				egressBytes: 0,
				ipAddress: req.headers.get("x-forwarded-for") || "127.0.0.1",
				userAgent: req.headers.get("user-agent") || "Web/CDN",
				latencyMs: 0,
			});

			const publicUrl = `https://${config.s3Domain}/${bucketName}/${fileName}`;
			const settings = await getAppSettings();

			if (settings.cdnForceSlackUpload && config.slack.fileUploadChannelId) {
				try {
					await postUploadSummary({
						channelId: config.slack.fileUploadChannelId,
						messageTs: undefined, // Not replying to a message
						threadTs: undefined,
						successCount: 1,
						totalCount: 1,
						results: [
							{
								name: file.name,
								url: publicUrl,
								key: fileName,
							},
						],
						bucketId: targetBucket.id,
						uploaderSlackId: user.slackId,
						uploaderEmail: user.email,
					});
				} catch (slackError) {
					console.error("Failed to send Slack notification:", slackError);
					// Don't fail the upload if Slack notification fails
				}
			}

			return jsonResponse({ url: publicUrl });
		} catch (e) {
			console.error("CDN Upload Error:", e);
			return errorResponse("Upload failed", 500);
		}
	}

	if (path.startsWith("/api/dashboard/")) {
		const user = await getCurrentUser(req);
		if (!user) return errorResponse("Unauthorized", 401);

		if (user.isLocked) {
			return errorResponse("Account Locked", 403);
		}

		if (path === "/api/dashboard/stats") {
			const bucketsWithKeys = await getBucketsForUser(user.id);

			const settings = await getAppSettings();
			const responseData = {
				user: {
					id: user.id,
					slackId: user.slackId,
					storageUsage: Number(user.storageUsageBytes) || 0,
					storageLimit:
						Number(user.storageLimitBytes) || settings.defaultStorageLimitBytes,
					egressLimit:
						user.egressLimitBytes !== null
							? Number(user.egressLimitBytes)
							: null,
					ingressBytes: Number(user.ingressBytes) || 0,
					egressBytes: Number(user.egressBytes) || 0,
					totalBytes:
						(Number(user.ingressBytes) || 0) + (Number(user.egressBytes) || 0),
					totalRequests: Number(user.totalRequests) || 0,
					isAdmin: user.isAdmin,
				},
				limits: {
					maxBucketsPerUser: settings.defaultMaxBucketsPerUser,
					maxKeysPerBucket: settings.defaultMaxKeysPerBucket,
					defaultStorageLimitBytes: settings.defaultStorageLimitBytes,
					egressMultiplier: settings.egressMultiplier,
					minEgressBytes: settings.minEgressBytes,
				},
				buckets: bucketsWithKeys.map((b) => ({
					name: b.name,
					keys: b.keys,
					createdAt: b.createdAt,
					totalBytes: Number(b.totalBytes) || 0,
					totalRequests: Number(b.totalRequests) || 0,
					isPublic: b.isPublic,
					isPaused: b.isPaused,
					pauseReason: b.pauseReason,
					corsConfig: b.corsConfig,
					isCdn: b.isCdn,
				})),
			};

			return jsonResponse(responseData);
		}

		if (path === "/api/dashboard/buckets") {
			return handleBuckets(req);
		}

		if (path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+$/)) {
			return handleBucketOperations(req);
		}

		if (path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+\/keys/)) {
			return handleKeys(req);
		}

		if (path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+\/files/)) {
			return handleFiles(req);
		}

		if (path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+\/cors$/)) {
			return handleCors(req);
		}
	}

	return errorResponse("Not Found", 404);
}
