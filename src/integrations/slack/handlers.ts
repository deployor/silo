import { and, eq, sql } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db";
import { bucketKeys, buckets, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { getInternalPath, isReservedBucketName } from "../../core/s3/utils";
import { openModal, publishView } from "./client";
import {
	createBucketModal,
	deleteBucketWarningModal,
	homeView,
	manageKeysModal,
} from "./views";
import { UserService } from "../../services/user-service";

export async function handleAppHomeOpened(event: { user: string }) {
	const slackId = event.user;

	// Find user by Slack ID
	const user = await UserService.getUserBySlackId(slackId);

	if (user) {
		// Calculate storage usage from all buckets
		user.storageUsageBytes = await UserService.getStorageUsage(user.id);
	}

	if (user && user.isLocked) {
		await publishView(slackId, {
			type: "home",
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: "Account Locked 🔒",
						emoji: true,
					},
				},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Your account has been temporarily locked. You cannot perform any actions at this time.${user.lockReason ? `\n\n*Reason:* ${user.lockReason}` : ""}`,
					},
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: "Please contact an administrator for assistance.",
						},
					],
				},
			],
		});
		return;
	}

	if (!user) {
		// User not found, show welcome/login message
		await publishView(slackId, {
			type: "home",
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: "Welcome to Silo! :wave:",
						emoji: true,
					},
				},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `*Hold up!* :ms-stop-sign:\n\nWe don't recognize this Slack account yet. To get started, you need to log in to the web dashboard at least once to link your account.\n\n *<https://${config.s3Domain}/auth/login?source=slack|Log in to Silo Dashboard>*`,
					},
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: "Once you've logged in, come back here and click 'Refresh'!",
						},
					],
				},
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: {
								type: "plain_text",
								text: ":ms-arrows-clockwise: Refresh",
								emoji: true,
							},
							action_id: "refresh_home",
						},
					],
				},
			],
		});
		return;
	}

	const userBuckets = await db
		.select()
		.from(buckets)
		.where(eq(buckets.userId, user.id));

	await publishView(slackId, homeView(user, userBuckets));
}

interface SlackInteractionPayload {
	type: string;
	user: {
		id: string;
	};
	trigger_id: string;
	view: {
		id: string;
		callback_id: string;
		private_metadata: string;
		state: {
			values: Record<string, Record<string, { value: string }>>;
		};
	};
	actions?: {
		action_id: string;
		value: string;
		selected_option: {
			value: string;
		};
	}[];
	container?: {
		channel_id: string;
		message_ts: string;
	};
	message?: {
		blocks: any[];
	};
}

export async function handleInteraction(payload: SlackInteractionPayload) {
	const user = await UserService.getUserBySlackId(payload.user.id);

	if (!user) return; // Should not happen if they are interacting

	if (user.isLocked) {
		await handleAppHomeOpened({ user: payload.user.id });
		return;
	}

	const action = payload.actions?.[0];
	let actionId = action?.action_id;
	let actionValue = action?.value;

	// Handle Overflow Menu
	if (actionId === "bucket_overflow_action" && action?.selected_option?.value) {
		const parts = action.selected_option.value.split(":");
		actionId = parts[0];
		actionValue = parts[1];
	}

	// 1. Open Create Bucket Modal
	if (actionId === "open_create_bucket_modal") {
		await openModal(payload.trigger_id, createBucketModal());
	}

	// 2. Handle Create Bucket Submission
	if (
		payload.type === "view_submission" &&
		payload.view.callback_id === "create_bucket_submission"
	) {
		const bucketName =
			payload.view.state.values.bucket_name_block.bucket_name_input.value;

		if (!bucketName || !/^[a-z0-9-]+$/.test(bucketName)) {
			// We should return an error to the modal, but for simplicity we'll just let it fail silently or log
			// Ideally we return a response_action: "errors"
			return {
				response_action: "errors",
				errors: {
					bucket_name_block:
						"Invalid name. Use lowercase letters, numbers, and hyphens.",
				},
			};
		}

		if (isReservedBucketName(bucketName)) {
			return {
				response_action: "errors",
				errors: {
					bucket_name_block: "This name is reserved for system use.",
				},
			};
		}

		// Check limit
		const userBuckets = await db
			.select()
			.from(buckets)
			.where(eq(buckets.userId, user.id));
		if (userBuckets.length >= 50) {
			return {
				response_action: "errors",
				errors: {
					bucket_name_block: "Bucket limit reached (50).",
				},
			};
		}

		// Check global uniqueness
		const existing = await db
			.select()
			.from(buckets)
			.where(eq(buckets.name, bucketName))
			.limit(1);
		if (existing.length > 0) {
			return {
				response_action: "errors",
				errors: {
					bucket_name_block: "Bucket name already taken.",
				},
			};
		}

		// Create bucket
		const newBucket = await db
			.insert(buckets)
			.values({
				name: bucketName,
				userId: user.id,
				isPublic: false,
			})
			.returning();

		// Create initial keys
		const accessKey =
			"CK" +
			Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) =>
				b.toString(16).padStart(2, "0"),
			)
				.join("")
				.toUpperCase();
		const secretKey = Array.from(
			crypto.getRandomValues(new Uint8Array(20)),
			(b) => b.toString(16).padStart(2, "0"),
		).join("");

		await db.insert(bucketKeys).values({
			bucketId: newBucket[0].id,
			accessKey,
			secretKey,
		});

		// Refresh Home
		// We can't await this because we need to return the ack immediately for the modal to close
		// But we can fire and forget
		handleAppHomeOpened({ user: payload.user.id });

		// Show the keys immediately
		const keys = await db
			.select()
			.from(bucketKeys)
			.where(eq(bucketKeys.bucketId, newBucket[0].id));
		const newKeyObj = { accessKey, secretKey };

		return {
			response_action: "push",
			view: manageKeysModal(newBucket[0], keys, newKeyObj),
		};
	}

	// 3. Open Manage Keys Modal
	if (actionId === "manage_keys" && actionValue) {
		const bucketId = actionValue;
		const bucket = await db
			.select()
			.from(buckets)
			.where(and(eq(buckets.id, bucketId), eq(buckets.userId, user.id)))
			.limit(1);

		if (bucket.length > 0) {
			const keys = await db
				.select()
				.from(bucketKeys)
				.where(eq(bucketKeys.bucketId, bucketId));
			await openModal(payload.trigger_id, manageKeysModal(bucket[0], keys));
		}
	}

	// 4. Generate New Key (inside modal)
	if (actionId === "generate_key" && actionValue) {
		const bucketId = actionValue;
		// Verify ownership
		const bucket = await db
			.select()
			.from(buckets)
			.where(and(eq(buckets.id, bucketId), eq(buckets.userId, user.id)))
			.limit(1);

		if (bucket.length > 0) {
			const accessKey =
				"CK" +
				Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) =>
					b.toString(16).padStart(2, "0"),
				)
					.join("")
					.toUpperCase();
			const secretKey = Array.from(
				crypto.getRandomValues(new Uint8Array(20)),
				(b) => b.toString(16).padStart(2, "0"),
			).join("");

			await db.insert(bucketKeys).values({
				bucketId: bucketId,
				accessKey,
				secretKey,
			});

			// Update the modal
			const keys = await db
				.select()
				.from(bucketKeys)
				.where(eq(bucketKeys.bucketId, bucketId));
			const newKeyObj = { accessKey, secretKey };

			// We need to update the view using response_action or views.update
			// Since this is a button click, we should use views.update
			// But we don't have the view_id easily here unless we pass it or use the payload
			// Actually, for button clicks in modals, we can return a "update" action? No, that's for block actions.
			// We should call views.update

			const _response = await fetch(`https://slack.com/api/views.update`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.slack.botToken}`,
				},
				body: JSON.stringify({
					view_id: payload.view.id,
					view: manageKeysModal(bucket[0], keys, newKeyObj),
				}),
			});
		}
	}

	// 5. Delete Key (inside modal)
	if (actionId === "delete_key" && actionValue) {
		const keyId = actionValue;
		const bucketId = payload.view.private_metadata; // We stored bucketId here

		// Verify ownership via bucket
		const bucket = await db
			.select()
			.from(buckets)
			.where(and(eq(buckets.id, bucketId), eq(buckets.userId, user.id)))
			.limit(1);

		if (bucket.length > 0) {
			await db.delete(bucketKeys).where(eq(bucketKeys.id, keyId));

			// Update modal
			const keys = await db
				.select()
				.from(bucketKeys)
				.where(eq(bucketKeys.bucketId, bucketId));

			await fetch(`https://slack.com/api/views.update`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.slack.botToken}`,
				},
				body: JSON.stringify({
					view_id: payload.view.id,
					view: manageKeysModal(bucket[0], keys),
				}),
			});
		}
	}

	// 6. Delete Bucket Attempt (Home Tab)
	if (actionId === "delete_bucket") {
		// Check if CDN bucket
		const bucketId = actionValue; // We need to pass bucket ID in the button value
		if (bucketId) {
			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.id, bucketId))
				.limit(1);

			if (bucket.length > 0 && bucket[0].isCdn) {
				// Show error modal or message
				await openModal(payload.trigger_id, {
					type: "modal",
					title: {
						type: "plain_text",
						text: "Cannot Delete",
						emoji: true,
					},
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "This is your Slack CDN bucket. It cannot be deleted manually. It is managed automatically by your Slack uploads.",
							},
						},
					],
				});
				return;
			}
		}

		await openModal(payload.trigger_id, deleteBucketWarningModal());
	}

	// 7. Toggle Bucket Public/Private
	if (actionId === "toggle_public" && actionValue) {
		const bucketId = actionValue;
		const bucket = await db
			.select()
			.from(buckets)
			.where(and(eq(buckets.id, bucketId), eq(buckets.userId, user.id)))
			.limit(1);

		if (bucket.length > 0) {
			await db
				.update(buckets)
				.set({ isPublic: !bucket[0].isPublic })
				.where(eq(buckets.id, bucketId));

			// Refresh Home
			await handleAppHomeOpened({ user: payload.user.id });
		}
	}

	// 8. Refresh Home
	if (actionId === "refresh_home") {
		await handleAppHomeOpened({ user: payload.user.id });
	}

	// 9. Pagination
	if (
		(actionId === "home_nav_prev" || actionId === "home_nav_next") &&
		actionValue
	) {
		const page = parseInt(actionValue, 10);
		const userBuckets = await db
			.select()
			.from(buckets)
			.where(eq(buckets.userId, user.id));

		await publishView(payload.user.id, homeView(user, userBuckets, page));
	}

	// 10. Delete CDN File
	if (actionId === "delete_cdn_file" && actionValue) {
		const parts = actionValue.split(":");
		const bucketId = parts[1];
		const key = parts[2];

		// Verify ownership
		const bucket = await db
			.select()
			.from(buckets)
			.where(and(eq(buckets.id, bucketId), eq(buckets.userId, user.id)))
			.limit(1);

		if (bucket.length > 0) {
			// Delete from S3
			const internalPath = getInternalPath(key, user, bucket[0]);
			await s3Client.fetch(internalPath, { method: "DELETE" });

			// Update DB Stats (approximate, we don't know exact size here easily without querying first)
			// For now, we just decrement file count if we tracked it, but we only track bytes.
			// We could query S3 head to get size before delete, but that's slow.
			// Let's just delete.

			// Update the message to show "Deleted"
			// We need to find the block that contained this button and update it.
			// This is tricky because we don't have the block ID easily.
			// But we have the message blocks in the payload if it's a block action.

			if (payload.message && payload.message.blocks) {
				const newBlocks = payload.message.blocks.map((block: any) => {
					if (
						block.accessory &&
						block.accessory.action_id === "delete_cdn_file" &&
						block.accessory.value === actionValue
					) {
						// This is the block. Replace it.
						return {
							type: "section",
							text: {
								type: "mrkdwn",
								text: `~${block.text.text.split("\n")[0]}~\n_Deleted_`,
							},
						};
					}
					return block;
				});

				await fetch(
					payload.container?.message_ts
						? "https://slack.com/api/chat.update"
						: "",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${config.slack.botToken}`,
						},
						body: JSON.stringify({
							channel: payload.container?.channel_id,
							ts: payload.container?.message_ts,
							blocks: newBlocks,
							text: "File Upload Summary (Updated)",
						}),
					},
				);
			}
		}
	}
}
