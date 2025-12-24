import { eq, sql } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db";
import { buckets, requestLogs, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { getInternalPath } from "../s3-api/utils";

export async function handleMessage(event: any) {
	// Ignore bot messages and messages without files
	if (event.bot_id || !event.files || event.files.length === 0) {
		return;
	}

	const slackId = event.user;
	const channelId = event.channel;
	const threadTs = event.thread_ts || event.ts;

	// 0. Add Loading Reaction
	await addReaction(channelId, event.ts, "homer-load-2");

	// 1. Find User
	const userResult = await db
		.select()
		.from(users)
		.where(eq(users.slackId, slackId))
		.limit(1);

	if (userResult.length === 0) {
		await postMessage(
			channelId,
			`I don't know who you are! Please <https://${config.s3Domain}/auth/login?source=slack|login to the dashboard> first to link your account.`,
			threadTs,
		);
		await removeReaction(channelId, event.ts, "homer-load-2");
		await addReaction(channelId, event.ts, "ms-no");
		return;
	}
	const user = userResult[0];

	// 2. Check Lock
	if (user.isLocked) {
		await postMessage(
			channelId,
			`Your account is locked. Reason: ${user.lockReason || "No reason provided."}`,
			threadTs,
		);
		await removeReaction(channelId, event.ts, "homer-load-2");
		await addReaction(channelId, event.ts, "ms-no");
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
				isCdn: true,
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
			threadTs,
		);
		await removeReaction(channelId, event.ts, "homer-load-2");
		await addReaction(channelId, event.ts, "ms-no");
		return;
	}

	const results: {
		name: string;
		url?: string;
		key?: string;
		error?: string;
	}[] = [];
	let successCount = 0;

	// 5. Process Files
	for (const file of event.files) {
		// Check 100MB Limit
		if (file.size > 100 * 1024 * 1024) {
			results.push({ name: file.name, error: "File too large (>100MB)" });
			continue;
		}

		// Check Quota
		const usageResult = await db
			.select({ total: sql<number>`sum(${buckets.totalBytes})` })
			.from(buckets)
			.where(eq(buckets.userId, user.id));
		const currentUsage = Number(usageResult[0]?.total) || 0;
		const limit = user.storageLimitBytes || 1073741824; // Default 1GB

		if (currentUsage + file.size > limit) {
			results.push({ name: file.name, error: "Quota exceeded" });
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
			results.push({ name: file.name, error: "Failed to download from Slack" });
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

			// Log Request
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
				ipAddress: "127.0.0.1", // Internal
				userAgent: "SlackBot/1.0",
				latencyMs: 0,
			});

			// Reply
			const publicUrl = `https://${config.s3Domain}/${bucketName}/${fileName}`;
			results.push({ name: file.name, url: publicUrl, key: fileName });
			successCount++;
		} catch (e) {
			console.error(e);
			results.push({ name: file.name, error: "Storage upload failed" });
		}
	}

	// 6. Send Summary using Block Kit
	// We need to chunk blocks because Slack has a limit of 50 blocks per message
	// Each file takes 2 blocks (Section + Context) or 1 block (Section with error)
	// Let's say 2 blocks per file. So max 20 files per message.

	const blocks: any[] = [];

	// Header
	let headerText = "";
	await removeReaction(channelId, event.ts, "homer-load-2");
	if (successCount === 0) {
		headerText = "❌ *Failed to upload files*";
		await addReaction(channelId, event.ts, "ms-no");
	} else if (successCount === event.files.length) {
		headerText = `:dinowow: *Uploaded ${successCount} file${successCount > 1 ? "s" : ""}!*`;
		await addReaction(channelId, event.ts, "ms-green-tick");
	} else {
		headerText = `⚠️ *Uploaded ${successCount}/${event.files.length} files*`;
		await addReaction(channelId, event.ts, "ms-worried");
	}

	blocks.push({
		type: "section",
		text: {
			type: "mrkdwn",
			text: headerText,
		},
	});

	blocks.push({
		type: "divider",
	});

	// File Blocks
	for (const r of results) {
		if (r.url) {
			blocks.push({
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*${r.name}*\n<${r.url}|${r.url}>`,
				},
				accessory: {
					type: "button",
					text: {
						type: "plain_text",
						text: "Delete",
						emoji: true,
					},
					style: "danger",
					value: `delete_cdn_file:${targetBucket.id}:${r.key}`,
					action_id: "delete_cdn_file",
					confirm: {
						title: {
							type: "plain_text",
							text: "Delete File",
						},
						text: {
							type: "mrkdwn",
							text: `Are you sure you want to delete *${r.name}*? This cannot be undone.`,
						},
						confirm: {
							type: "plain_text",
							text: "Yes, delete it",
						},
						deny: {
							type: "plain_text",
							text: "Cancel",
						},
					},
				},
			});
		} else {
			blocks.push({
				type: "section",
				text: {
					type: "mrkdwn",
					text: `~${r.name}~\n_Error: ${r.error}_`,
				},
			});
		}
	}

	// Chunk and Send
	const CHUNK_SIZE = 40; // Safe limit
	// First chunk includes header (2 blocks)
	// Subsequent chunks are just files

	// Actually, let's just send multiple messages if needed.
	// But we want the header in the first one.

	let currentBlocks = [];
	// Add header blocks
	currentBlocks.push(blocks[0]);
	currentBlocks.push(blocks[1]);

	for (let i = 2; i < blocks.length; i++) {
		currentBlocks.push(blocks[i]);

		if (currentBlocks.length >= CHUNK_SIZE) {
			await postBlocks(channelId, currentBlocks, threadTs);
			currentBlocks = [];
		}
	}

	if (currentBlocks.length > 0) {
		await postBlocks(channelId, currentBlocks, threadTs);
	}
}

async function postMessage(channel: string, text: string, threadTs?: string) {
	await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({ channel, text, thread_ts: threadTs }),
	});
}

async function postBlocks(channel: string, blocks: any[], threadTs?: string) {
	await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({
			channel,
			blocks,
			thread_ts: threadTs,
			text: "File Upload Summary", // Fallback text
		}),
	});
}

async function addReaction(channel: string, timestamp: string, name: string) {
	await fetch("https://slack.com/api/reactions.add", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({ channel, timestamp, name }),
	});
}

async function removeReaction(channel: string, timestamp: string, name: string) {
	await fetch("https://slack.com/api/reactions.remove", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({ channel, timestamp, name }),
	});
}
