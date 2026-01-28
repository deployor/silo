import { eq, sql } from "drizzle-orm";
import {
	Actions,
	Button,
	ConfirmationDialog,
	Context,
	Divider,
	Header,
	Section,
} from "slack-block-builder";
import { config } from "../../config";
import { getInternalPath } from "../../core/s3/utils";
import { db } from "../../db";
import { buckets, requestLogs } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { getStorageUsage, getUserBySlackId } from "../../services/user-service";
import { getUserInfo } from "./client";

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
			await postBlocks(
				channelId,
				[
					Header({ text: "Whoops! Account Required" }),
					Section({
						text: "Heyho! You need an account on Silo so I can manage quota (and more) for you. Please sign in with Hack Club Auth so we can match this Slack user to your record.",
					}),
					Actions().elements(
						Button({
							text: "Sign in to Silo",
							url: `https://${config.s3Domain}/auth/login?source=slack`,
						}).primary(),
					),
				],
				threadTs,
				undefined,
				undefined,
				"Account Required",
			);
			await addReaction(channelId, messageTs, "ms-no");
			return;
		}

		if (user.filesDeleted) {
			if (user.dataExported) {
				await postBlocks(
					channelId,
					[
						Header({ text: "CDN Access Revoked" }),
						Section({
							text: "Bro, you're over 18. :ms-raised-eyebrow: I'm sorry to tell you, but you also can't use the CDN anymore, sowwy! As you know, all your files and S3 and everything got paused before too, and you downloaded them in time!",
						}),
					],
					threadTs,
					undefined,
					undefined,
					"CDN Access Revoked",
				);
				await addReaction(channelId, messageTs, "ms-raised-eyebrow");
			} else {
				await postBlocks(
					channelId,
					[
						Header({ text: "Files Deleted" }),
						Section({
							text: "Hey uh, how do I tell you this but... :panic:\n\nYour files got forever deleted and you weren't in time to actually download them. You're over 18, and to save budget and more, Hack Club doesn't actually run this for over 18-year-olds... Sorry.",
						}),
					],
					threadTs,
					undefined,
					undefined,
					"Files Deleted",
				);
				await addReaction(channelId, messageTs, "panic");
			}
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
			await postBlocks(
				channelId,
				[
					Header({ text: "Files Scheduled for Deletion" }),
					Section({
						text: "Heyho, sorry you're over 18 and your files are also soon to be deleted :sad-pf:, soooooo no new files and old ones gone soon too :C",
					}),
					Section({
						text: "You already downloaded your files, but if you need to again, you can find them below.",
					}),
					Context().elements(
						`Usage: ${usageGB} GB`,
						`Deletion in: ${daysLeft} days (${endDate})`,
					),
					Actions().elements(
						Button({
							text: "View Old Files",
							url: `https://${config.s3Domain}/dashboard/offboarding`,
						}),
					),
				],
				threadTs,
				undefined,
				undefined,
				"Files Scheduled for Deletion",
			);
			await addReaction(channelId, messageTs, "sad-pf");
			return;
		}

		if (user.markedAsOverAge) {
			await postBlocks(
				channelId,
				[
					Header({ text: "Action Required: Download Files!" }),
					Section({
						text: `Hey... Sorry but you're over 18- You seem to store *${usageGB} GB* of data though! WHICH YOU HAVE STILL NOT DOWNLOADED!!!!! :siren1::siren1::siren1::siren1::siren1:`,
					}),
					Section({
						text: "Please download them and migrate to something like Cloudflare R2 ASAP! :catalarm: I will delete everything soon, so HURRY!",
					}),
					Context().elements(
						`Usage: ${usageGB} GB`,
						`Deletion in: ${daysLeft} days (${endDate})`,
					),
					Actions().elements(
						Button({
							text: "Download Files",
							url: `https://${config.s3Domain}/dashboard/offboarding`,
						}).danger(),
					),
				],
				threadTs,
				undefined,
				undefined,
				"Urgent: Download Files",
			);
			await addReaction(channelId, messageTs, "siren1");
			return;
		}

		if (user.isLocked) {
			await postBlocks(
				channelId,
				[
					Header({ text: "Account Locked" }),
					Section({
						text: `Your account is locked.\n*Reason:* ${user.lockReason || "No reason provided."}`,
					}),
				],
				threadTs,
				undefined,
				undefined,
				"Account Locked",
			);
			await addReaction(channelId, messageTs, "ms-no");
			return;
		}

		const bucketName = user.slackId?.toLowerCase() ?? "";
		if (!bucketName) {
			await postBlocks(
				channelId,
				[
					Header({ text: "Error" }),
					Section({ text: "Unable to determine bucket name for this user." }),
				],
				threadTs,
				undefined,
				undefined,
				"Error",
			);
			await addReaction(channelId, messageTs, "ms-no");
			return;
		}

		const targetBucket = await getOrCreateCdnBucket(user.id, bucketName);
		if (targetBucket.isPaused) {
			await postBlocks(
				channelId,
				[
					Header({ text: "Bucket Paused" }),
					Section({
						text: `Your CDN bucket is paused.\n*Reason:* ${targetBucket.pauseReason || "No reason provided."}`,
					}),
				],
				threadTs,
				undefined,
				undefined,
				"Bucket Paused",
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

export async function postUploadSummary(params: {
	channelId: string;
	messageTs?: string;
	threadTs?: string;
	successCount: number;
	totalCount: number;
	results: UploadResult[];
	bucketId: string;
	uploaderSlackId: string;
	uploaderEmail?: string;
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
		uploaderEmail,
	} = params;

	// If we are posting as a summary (not a reply), we want to impersonate the user
	let username = undefined;
	let iconUrl = undefined;

	if (!messageTs && uploaderSlackId) {
		const slackUser = await getUserInfo(uploaderSlackId);
		if (slackUser) {
			username =
				slackUser.profile.display_name ||
				slackUser.profile.real_name ||
				slackUser.name;
			iconUrl = slackUser.profile.image_192 || slackUser.profile.image_512;
		} else if (uploaderEmail) {
			username = uploaderEmail.split("@")[0];
		}
		
		if (!iconUrl) {
			iconUrl = `https://cachet.dunkirk.sh/users/${uploaderSlackId}/r`;
		}
	}

	const blocks: any[] = [];

	let headerText = "";
	if (successCount === 0) {
		headerText = "❌ *Failed to upload files*";
		if (messageTs) await addReaction(channelId, messageTs, "ms-no");
	} else if (successCount === totalCount) {
		if (!messageTs && successCount === 1 && results[0]) {
			headerText = `*Uploaded ${results[0].name}*`;
		} else {
			headerText = `:dinowow: *Uploaded ${successCount} ${plural(successCount, "file", "files")}!*`;
		}
		if (messageTs) await addReaction(channelId, messageTs, "ms-green-tick");
	} else {
		headerText = `⚠️ *Uploaded ${successCount}/${totalCount} files*`;
		if (messageTs) await addReaction(channelId, messageTs, "ms-worried");
	}

	blocks.push(Section({ text: headerText }));
	blocks.push(Divider());

	for (const r of results) {
		if (r.url && r.key) {
			const section = Section({
				text: `*${r.name}*\n<${r.url}|${r.url}>`,
			});

			// Only add delete button if it's a message reply (original behavior) or if explicitly requested
			// The requirement was "without a delete button" for CDN postings.
			// Since CDN postings have messageTs=undefined, we can use that check.
			if (messageTs) {
				section.accessory(
					Button({
						text: "Delete",
						actionId: "delete_cdn_file",
						value: `delete_cdn_file:${bucketId}:${r.key}:${uploaderSlackId}`,
					})
						.danger()
						.confirm(
							ConfirmationDialog({
								title: "Delete File",
								text: `Are you sure you want to delete *${r.name}*? This cannot be undone.`,
								confirm: "Yes, delete it",
								deny: "Cancel",
							}),
						),
				);
			}

			blocks.push(section);
		} else {
			blocks.push(
				Section({
					text: `~${r.name}~\n_Error: ${r.error || "Unknown error"}_`,
				}),
			);
		}
	}

	const CHUNK_SIZE = 40;
	let currentBlocks: any[] = [blocks[0], blocks[1]].filter(Boolean);

	// Variables `username` and `iconUrl` are already set at the start of the function

	const fallbackText =
		successCount === 1 && results[0]
			? `Uploaded ${results[0].name}`
			: `Uploaded ${successCount} files`;

	for (let i = 2; i < blocks.length; i++) {
		currentBlocks.push(blocks[i]);
		if (currentBlocks.length >= CHUNK_SIZE) {
			await postBlocks(
				channelId,
				currentBlocks,
				threadTs,
				username,
				iconUrl,
				fallbackText,
			);
			currentBlocks = [];
		}
	}

	if (currentBlocks.length > 0)
		await postBlocks(
			channelId,
			currentBlocks,
			threadTs,
			username,
			iconUrl,
			fallbackText,
		);
}

export async function postMessage(
	channel: string,
	text: string,
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
	blocks: unknown[],
	threadTs?: string,
	username?: string,
	icon_url?: string,
	text: string = "File Upload Summary",
) {
	// The blocks passed in here are from slack-block-builder which have a buildToObject() method.
	// But sometimes they might already be plain objects if we manipulated them.
	// Actually, based on how we called it, we are passing arrays of builder objects.
	// We should convert them to JSON using buildToJSON() then parse it, OR just map them to object using buildToObject which exists on them (but typescript was complaining).
	// Let's use the Print() helper from slack-block-builder if we could, but we don't have it imported.
	// Instead, let's just assume they are builders and call JSON.parse(b.buildToJSON()) on them if they have the method, or leave them as is.

	const formattedBlocks = blocks.map((b: any) => {
		if (typeof b.buildToJSON === "function") {
			return JSON.parse(b.buildToJSON());
		}
		return b;
	});

	await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.slack.botToken}`,
		},
		body: JSON.stringify({
			channel,
			blocks: formattedBlocks,
			thread_ts: threadTs,
			text,
			unfurl_links: true,
			unfurl_media: true,
			username,
			icon_url,
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
