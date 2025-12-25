import { and, eq } from "drizzle-orm";
import {
	Actions,
	Button,
	Context,
	Header,
	HomeTab,
	Modal,
	Section,
} from "slack-block-builder";
import { config } from "../../config";
import { getInternalPath, isReservedBucketName } from "../../core/s3/utils";
import { db } from "../../db";
import { bucketKeys, buckets } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { UserService } from "../../services/user-service";
import { openModal, publishView } from "./client";
import {
	createBucketModal,
	deleteBucketWarningModal,
	homeView,
	manageKeysModal,
} from "./views";

export async function handleAppHomeOpened(event: { user: string }) {
	const slackId = event.user;

	// Find user by Slack ID
	const user = await UserService.getUserBySlackId(slackId);

	if (user) {
		// Calculate storage usage from all buckets
		user.storageUsageBytes = await UserService.getStorageUsage(user.id);
	}

	if (user?.isLocked) {
		await publishView(
			slackId,
			HomeTab()
				.blocks(
					Header({ text: "Account Locked 🔒" }),
					Section({
						text: `Your account has been temporarily locked. You cannot perform any actions at this time.${user.lockReason ? `\n\n*Reason:* ${user.lockReason}` : ""}`,
					}),
					Context().elements("Please contact an administrator for assistance."),
				)
				.buildToObject(),
		);
		return;
	}

	if (!user) {
		// User not found, show welcome/login message
		await publishView(
			slackId,
			HomeTab()
				.blocks(
					Header({ text: "Welcome to Silo! :wave:" }),
					Section({
						text: `*Hold up!* :ms-stop-sign:\n\nWe don't recognize this Slack account yet. To get started, you need to log in to the web dashboard at least once to link your account.\n\n *<https://${config.s3Domain}/auth/login?source=slack|Log in to Silo Dashboard>*`,
					}),
					Context().elements(
						"Once you've logged in, come back here and click 'Refresh'!",
					),
					Actions().elements(
						Button({
							text: ":ms-arrows-clockwise: Refresh",
							actionId: "refresh_home",
						}),
					),
				)
				.buildToObject(),
		);
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
				await openModal(
					payload.trigger_id,
					Modal({
						title: "Cannot Delete",
					})
						.blocks(
							Section({
								text: "This is your Slack CDN bucket. It cannot be deleted manually. It is managed automatically by your Slack uploads.",
							}),
						)
						.buildToObject(),
				);
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

			// Update the message to show "Deleted"
			if (payload.message?.blocks) {
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
