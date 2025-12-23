import { eq, sql } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db";
import { buckets, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { getInternalPath } from "../s3-api/utils";

export async function handleMessage(event: any) {
	// Ignore bot messages and messages without files
	if (event.bot_id || !event.files || event.files.length === 0) {
		return;
	}

	const slackId = event.user;
	const channelId = event.channel;

	// 1. Find User
	const userResult = await db
		.select()
		.from(users)
		.where(eq(users.slackId, slackId))
		.limit(1);

	if (userResult.length === 0) {
		await postMessage(
			channelId,
			`I don't know who you are! Please <https://${config.s3Domain}/auth/login|login to the dashboard> first to link your account.`,
		);
		return;
	}
	const user = userResult[0];

	// 2. Check Lock
	if (user.isLocked) {
		await postMessage(
			channelId,
			`Your account is locked. Reason: ${user.lockReason || "No reason provided."}`,
		);
		return;
	}

	// 3. Get/Create CDN Bucket
	// Bucket name is the lowercase Slack ID
	const bucketName = user.slackId!.toLowerCase();

	let bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);

	if (bucket.length === 0) {
		// Create it
		const newBucket = await db
			.insert(buckets)
			.values({
				name: bucketName,
				userId: user.id,
				isPublic: true,
				region: "auto",
			})
			.returning();
		bucket = newBucket;
	}

	const targetBucket = bucket[0];

	// 4. Check Pause
	if (targetBucket.isPaused) {
		await postMessage(
			channelId,
			`Your CDN bucket is paused. Reason: ${targetBucket.pauseReason || "No reason provided."}`,
		);
		return;
	}

	// 5. Process Files
	for (const file of event.files) {
		// Check Quota
		const usageResult = await db
			.select({ total: sql<number>`sum(${buckets.totalBytes})` })
			.from(buckets)
			.where(eq(buckets.userId, user.id));
		const currentUsage = Number(usageResult[0]?.total) || 0;
		const limit = user.storageLimitBytes || 1073741824; // Default 1GB

		if (currentUsage + file.size > limit) {
			await postMessage(
				channelId,
				`❌ Failed to upload *${file.name}*: Quota exceeded.`,
			);
			continue;
		}

		// Download
		const downloadUrl = file.url_private_download;
		const fileRes = await fetch(downloadUrl, {
			headers: {
				Authorization: `Bearer ${config.slack.botToken}`,
			},
		});

		if (!fileRes.ok) {
			await postMessage(
				channelId,
				`❌ Failed to download *${file.name}* from Slack.`,
			);
			continue;
		}

		const fileBuffer = await fileRes.arrayBuffer();

		// Upload to S3
		const ext = file.name.split(".").pop();
		const hash = crypto.randomUUID();
		const fileName = `${hash}.${ext}`;

		const internalPath = getInternalPath(fileName, user, targetBucket);

		try {
			const s3Res = await s3Client.fetch(internalPath, {
				method: "PUT",
				body: fileBuffer,
				headers: {
					"Content-Type": file.mimetype || "application/octet-stream",
					"Content-Length": file.size.toString(),
				},
			});

			if (!s3Res.ok) {
				throw new Error(`S3 Upload Failed: ${s3Res.status}`);
			}

			// Update Stats
			await db
				.update(buckets)
				.set({
					totalBytes: sql`${buckets.totalBytes} + ${file.size}`,
					totalRequests: sql`${buckets.totalRequests} + 1`,
				})
				.where(eq(buckets.id, targetBucket.id));

			// Reply
			const publicUrl = `https://${config.s3Domain}/${bucketName}/${fileName}`;
			await postMessage(
				channelId,
				`Uploaded *${file.name}*! :rocket:\n${publicUrl}`,
			);
		} catch (e) {
			console.error(e);
			await postMessage(
				channelId,
				`❌ Failed to upload *${file.name}* to storage.`,
			);
		}
	}
}

async function postMessage(channel: string, text: string) {
	await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({ channel, text }),
	});
}
