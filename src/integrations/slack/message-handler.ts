import { eq, sql } from "drizzle-orm";
import { config } from "../../config";
import { getInternalPath } from "../../core/s3/utils";
import { db } from "../../db";
import { buckets, requestLogs } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { getStorageUsage, getUserBySlackId } from "../../services/user-service";

type SlackFile = {
	name: string;
	size: number;
	mimetype?: string;
	url_private_download: string;
};

type SlackMessageEvent = {
	bot_id?: string;
	files?: SlackFile[];
	user?: string;
	channel?: string;
	channel_type?: string;
	ts?: string;
	thread_ts?: string;
};

type UploadResult = {
	name: string;
	url?: string;
	key?: string;
	error?: string;
};

const DEFAULT_STORAGE_LIMIT_BYTES = 1_073_741_824; // 1GB
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB
const SLACK_FILES_HOST_PREFIX = "https://files.slack.com/";

function sanitizeExtension(filename: string): string {
	const ext = filename
		.split(".")
		.pop()
		?.replace(/[^a-z0-9]/gi, "");
	return ext && ext.length > 0 ? ext : "bin";
}

function isAllowedSlackDownloadUrl(url: string): boolean {
	return url.startsWith(SLACK_FILES_HOST_PREFIX);
}

function plural(n: number, singular: string, pluralForm: string): string {
	return n === 1 ? singular : pluralForm;
}

async function getOrCreateCdnBucket(userId: string, bucketName: string) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);

	if (bucket.length > 0) return bucket[0];

	const created = await db
		.insert(buckets)
		.values({
			name: bucketName,
			userId,
			isPublic: true,
			isCdn: true,
			region: "auto",
		})
		.returning();

	const first = created[0];
	if (!first) throw new Error("Failed to create CDN bucket");
	return first;
}

async function uploadSlackFileToBucket(params: {
	file: SlackFile;
	user: Awaited<ReturnType<typeof getUserBySlackId>>;
	targetBucket: typeof buckets.$inferSelect;
	bucketName: string;
}): Promise<UploadResult> {
	const { file, user, targetBucket, bucketName } = params;

	if (!user) return { name: file.name, error: "Unknown user" };

	if (file.size > MAX_FILE_BYTES)
		return { name: file.name, error: "File too large (>100MB)" };

	const currentUsage = await getStorageUsage(user.id);
	const limit = user.storageLimitBytes || DEFAULT_STORAGE_LIMIT_BYTES;
	if (currentUsage + file.size > limit)
		return { name: file.name, error: "Quota exceeded" };

	const downloadUrl = file.url_private_download;
	if (!isAllowedSlackDownloadUrl(downloadUrl))
		return { name: file.name, error: "Invalid file source" };

	const fileRes = await fetch(downloadUrl, {
		headers: {
			Authorization: `Bearer ${config.slack.botToken}`,
		},
	});
	if (!fileRes.ok)
		return { name: file.name, error: "Failed to download from Slack" };

	const fileBuffer = await fileRes.arrayBuffer();

	const ext = sanitizeExtension(file.name);
	const hash = crypto.randomUUID();
	const fileName = `${hash}.${ext}`;

	const internalPath = getInternalPath(fileName, user, targetBucket);

	const s3Res = await s3Client.fetch(internalPath, {
		method: "PUT",
		body: fileBuffer,
		headers: {
			"Content-Type": file.mimetype || "application/octet-stream",
			"Content-Length": file.size.toString(),
		},
	});

	if (!s3Res.ok)
		return {
			name: file.name,
			error: `Storage upload failed (${s3Res.status})`,
		};

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
		ipAddress: "127.0.0.1", // Internal
		userAgent: "SlackBot/1.0",
		latencyMs: 0,
	});

	const publicUrl = `https://${config.s3Domain}/${bucketName}/${fileName}`;
	return { name: file.name, url: publicUrl, key: fileName };
}

export async function handleMessage(event: SlackMessageEvent) {
	// Ignore bot messages and messages without files
	if (event.bot_id || !event.files || event.files.length === 0) return;

	const slackId = event.user;
	const channelId = event.channel;
	const messageTs = event.ts;
	const threadTs = event.thread_ts || event.ts;

	if (!slackId || !channelId || !messageTs || !threadTs) return;

	// Only allow channel uploads in the configured channel. DMs are always allowed.
	// Note: Slack sends IMs as "message.im" events (see manifest). Channel messages are "message.channels".
	// Some Slack event payloads omit `channel_type`, so treat missing as non-IM.
	const isIm = event.channel_type === "im";
	if (!isIm) {
		const allowedChannelId = config.slack.fileUploadChannelId;
		if (allowedChannelId && channelId !== allowedChannelId) return;
	}

	await addReaction(channelId, messageTs, "homer-load-2");

	try {
		const user = await getUserBySlackId(slackId);
		if (!user) {
			await postMessage(
				channelId,
				`Heyho! you need an account on Silo so i can manage quota (and more) for you.

Please sign in with Hack Club Auth so we can match this Slack user to your record:
<https://${config.s3Domain}/auth/login?source=slack|Sign in to Silo>`,
				threadTs,
			);
			await addReaction(channelId, messageTs, "ms-no");
			return;
		}

		if (user.filesDeleted) {
			if (user.dataExported) {
				await postMessage(
					channelId,
					"Bro your over 18 im sorry to tell you but you also cant use CDN sowwy! As you know all your fiels and S3 and all got paused before too and you downlaoded them in time!",
					threadTs,
				);
			} else {
				await postMessage(
					channelId,
					"Hey uh how do i tell you but...\n\nYour files got forever deletedf and you werent in time to actually download them- Your over 18 and to save budget and mroe hackclub doesnt actually run this for over 18 year olds... Sorry",
					threadTs,
				);
			}
			await addReaction(channelId, messageTs, "wave");
			return;
		}

		const usageGB = (
			(Number(user.storageUsageBytes) || 0) /
			(1024 * 1024 * 1024)
		).toFixed(2);
		const daysLeft = user.overAgeGracePeriodEndsAt
			? Math.ceil(
					(new Date(user.overAgeGracePeriodEndsAt).getTime() - Date.now()) /
						(1000 * 60 * 60 * 24),
				)
			: 0;
		const endDate = user.overAgeGracePeriodEndsAt
			? new Date(user.overAgeGracePeriodEndsAt).toLocaleDateString()
			: "soon";

		if (user.dataExported) {
			await postMessage(
				channelId,
				`Heyho sorry your over 18 and ur files are also soon to be deleted soooooo no new files and old ones gone soon too :C\n\nYou already downlaoded your files but if you nbeed to again <https://${config.s3Domain}/dashboard/offboarding|HERE> your old files soooo ${usageGB} GB will be deleted ion ${daysLeft} days on the ${endDate}`,
				threadTs,
			);
			await addReaction(channelId, messageTs, "no_entry");
			return;
		}

		if (user.markedAsOverAge) {
			await postMessage(
				channelId,
				`Hey... Sorry but your over 18- You seem to store ${usageGB} GB of data tho! WHICH YOU HAVE STILL NOT DOWNLOADED!!!!! Please download it <https://${config.s3Domain}/dashboard/offboarding|HERE> and m,igrate to soemthing like cloduflare r2 ASAPi will delete everyhting in ${daysLeft} days on the ${endDate} th so  HURRY! I wont upload the files u provided me with :(`,
				threadTs,
			);
			await addReaction(channelId, messageTs, "graduate");
			return;
		}

		if (user.isLocked) {
			await postMessage(
				channelId,
				`Your account is locked. Reason: ${user.lockReason || "No reason provided."}`,
				threadTs,
			);
			await addReaction(channelId, messageTs, "ms-no");
			return;
		}

		const bucketName = user.slackId?.toLowerCase() ?? "";
		if (!bucketName) {
			await postMessage(
				channelId,
				"Unable to determine bucket name for this user.",
				threadTs,
			);
			await addReaction(channelId, messageTs, "ms-no");
			return;
		}

		const targetBucket = await getOrCreateCdnBucket(user.id, bucketName);
		if (targetBucket.isPaused) {
			await postMessage(
				channelId,
				`Your CDN bucket is paused. Reason: ${targetBucket.pauseReason || "No reason provided."}`,
				threadTs,
			);
			await addReaction(channelId, messageTs, "ms-no");
			return;
		}

		const results: UploadResult[] = [];
		let successCount = 0;

		for (const file of event.files) {
			try {
				const r = await uploadSlackFileToBucket({
					file,
					user,
					targetBucket,
					bucketName,
				});
				results.push(r);
				if (r.url) successCount++;
			} catch (e) {
				console.error(e);
				results.push({ name: file.name, error: "Storage upload failed" });
			}
		}

		await postUploadSummary({
			channelId,
			messageTs,
			threadTs,
			results,
			successCount,
			totalCount: event.files.length,
			bucketId: targetBucket.id,
			uploaderSlackId: slackId,
		});
	} finally {
		await removeReaction(channelId, messageTs, "homer-load-2");
	}
}

type SlackBlock = Record<string, unknown>;

async function postUploadSummary(params: {
	channelId: string;
	messageTs: string;
	threadTs: string;
	successCount: number;
	totalCount: number;
	results: UploadResult[];
	bucketId: string;
	uploaderSlackId: string;
}) {
	const {
		channelId,
		messageTs,
		threadTs,
		successCount,
		totalCount,
		results,
		bucketId,
		uploaderSlackId,
	} = params;

	const blocks: SlackBlock[] = [];

	let headerText = "";
	if (successCount === 0) {
		headerText = "❌ *Failed to upload files*";
		await addReaction(channelId, messageTs, "ms-no");
	} else if (successCount === totalCount) {
		headerText = `:dinowow: *Uploaded ${successCount} ${plural(successCount, "file", "files")}!*`;
		await addReaction(channelId, messageTs, "ms-green-tick");
	} else {
		headerText = `⚠️ *Uploaded ${successCount}/${totalCount} files*`;
		await addReaction(channelId, messageTs, "ms-worried");
	}

	blocks.push({
		type: "section",
		text: {
			type: "mrkdwn",
			text: headerText,
		},
	});

	blocks.push({ type: "divider" });

	for (const r of results) {
		if (r.url && r.key) {
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
					value: `delete_cdn_file:${bucketId}:${r.key}:${uploaderSlackId}`,
					action_id: "delete_cdn_file",
					confirm: {
						title: { type: "plain_text", text: "Delete File" },
						text: {
							type: "mrkdwn",
							text: `Are you sure you want to delete *${r.name}*? This cannot be undone.`,
						},
						confirm: { type: "plain_text", text: "Yes, delete it" },
						deny: { type: "plain_text", text: "Cancel" },
					},
				},
			});
		} else {
			blocks.push({
				type: "section",
				text: {
					type: "mrkdwn",
					text: `~${r.name}~\n_Error: ${r.error || "Unknown error"}_`,
				},
			});
		}
	}

	const CHUNK_SIZE = 40;
	let currentBlocks: SlackBlock[] = [blocks[0], blocks[1]].filter(
		(b): b is SlackBlock => Boolean(b),
	);

	for (let i = 2; i < blocks.length; i++) {
		currentBlocks.push(blocks[i]);
		if (currentBlocks.length >= CHUNK_SIZE) {
			await postBlocks(channelId, currentBlocks, threadTs);
			currentBlocks = [];
		}
	}

	if (currentBlocks.length > 0)
		await postBlocks(channelId, currentBlocks, threadTs);
}

async function postMessage(channel: string, text: string, threadTs?: string) {
	await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({
			channel,
			text,
			thread_ts: threadTs,
			// Helps prevent Slack from unfurling links into rich previews (especially important in channels)
			unfurl_links: false,
			unfurl_media: false,
		}),
	});
}

async function postBlocks(
	channel: string,
	blocks: SlackBlock[],
	threadTs?: string,
) {
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
			unfurl_links: false,
			unfurl_media: false,
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

async function removeReaction(
	channel: string,
	timestamp: string,
	name: string,
) {
	await fetch("https://slack.com/api/reactions.remove", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({ channel, timestamp, name }),
	});
}
