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
import { createKey } from "../../services/key-service";
import { getAppSettings } from "../../services/settings-service";
import { getStorageUsage, getUserBySlackId } from "../../services/user-service";
import { openModal, publishView } from "./client";
import {
	createBucketModal,
	deleteBucketWarningModal,
	homeView,
	manageKeysModal,
} from "./views";

export async function handleAppHomeOpened(event: { user: string }) {
	const slackId = event.user;

	const user = await getUserBySlackId(slackId);

	if (user) {
		user.storageUsageBytes = await getStorageUsage(user.id);
	}

	if (user?.isLocked) {
		await publishView(
			slackId,
			HomeTab()
				.blocks(
					Header({ text: "Account Locked" }),
					Section({
						text: `Your account has been temporarily locked. You cannot perform any actions at this time.${user.lockReason ? `\n\n*Reason:* ${user.lockReason}` : ""}`,
					}),
					Context().elements("Please contact an administrator for assistance."),
				)
				.buildToObject(),
		);
		return;
	}

	if (user.filesDeleted) {
		await publishView(
			slackId,
			HomeTab()
				.blocks(
					Header({ text: "Happy HS Graduation!" }),
					Section({
						text: "You have officially aged out of the Silo service. Your files have been deleted.",
					}),
					Section({
						text: "We hope Silo was helpful during your time at Hack Club!",
					}),
				)
				.buildToObject(),
		);
		return;
	}

	if (!user) {
		await publishView(
			slackId,
			HomeTab()
				.blocks(
					Header({ text: "Welcome to Silo! :wave:" }),
					Section({
						text: `Heyho — you need an account on Silo so we can manage quota (and more) for you.\n\nPlease sign in with Hack Club Auth so we can match this Slack user to your record:\n\n*<https://${config.s3Domain}/auth/login?source=slack|Sign in to Silo>*`,
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

	const settings = await getAppSettings();

	const userBuckets = await db
		.select()
		.from(buckets)
		.where(eq(buckets.userId, user.id));

	await publishView(
		slackId,
		homeView(user, userBuckets, {
			defaultMaxBucketsPerUser: settings.defaultMaxBucketsPerUser,
			defaultMaxKeysPerBucket: settings.defaultMaxKeysPerBucket,
		}),
	);
}

type SlackBlock = Record<string, unknown>;

type SlackInteractionPayload = {
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
		blocks: SlackBlock[];
	};
};

export async function handleInteraction(payload: SlackInteractionPayload) {
	const user = await getUserBySlackId(payload.user.id);

	if (!user) return; // Should not happen if they are interacting

	if (user.isLocked) {
		await handleAppHomeOpened({ user: payload.user.id });
		return;
	}

	const action = payload.actions?.[0];
	let actionId = action?.action_id;
	let actionValue = action?.value;

	if (actionId === "bucket_overflow_action" && action?.selected_option?.value) {
		const parts = action.selected_option.value.split(":");
		actionId = parts[0];
		actionValue = parts[1];
	}

	if (actionId === "open_create_bucket_modal") {
		await openModal(payload.trigger_id, createBucketModal());
	}

	if (
		payload.type === "view_submission" &&
		payload.view.callback_id === "create_bucket_submission"
	) {
		const bucketName =
			payload.view.state.values.bucket_name_block.bucket_name_input.value;

		if (
			!bucketName ||
			!/^[a-z0-9-]+$/.test(bucketName) ||
			bucketName.length < 3
		) {
			return {
				response_action: "errors",
				errors: {
					bucket_name_block:
						"Invalid name. Use lowercase letters, numbers, and hyphens (min 3 characters).",
				},
			};
		}

		if (
			isReservedBucketName(bucketName) ||
			["dashboard", "admin", "api", "auth", "docs"].includes(bucketName)
		) {
			return {
				response_action: "errors",
				errors: {
					bucket_name_block: "This name is reserved.",
				},
			};
		}

		const settings = await getAppSettings();

		const userBuckets = await db
			.select()
			.from(buckets)
			.where(eq(buckets.userId, user.id));
		if (
			!user.isImmortal &&
			userBuckets.length >= settings.defaultMaxBucketsPerUser
		) {
			return {
				response_action: "errors",
				errors: {
					bucket_name_block: `Bucket limit reached (${settings.defaultMaxBucketsPerUser}).`,
				},
			};
		}

		if (user.markedAsOverAge) {
			return {
				response_action: "errors",
				errors: {
					bucket_name_block:
						"Your account is in migration grace period. You cannot create new buckets.",
				},
			};
		}

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

		const newBucket = await db
			.insert(buckets)
			.values({
				name: bucketName,
				userId: user.id,
				isPublic: false,
			})
			.returning();

		const { accessKey, secretKey } = await createKey(newBucket[0].id, "slack");

		handleAppHomeOpened({ user: payload.user.id });

		const keys = await db
			.select()
			.from(bucketKeys)
			.where(eq(bucketKeys.bucketId, newBucket[0].id));
		const newKeyObj = { accessKey, secretKey };

		return {
			response_action: "push",
			view: manageKeysModal(
				newBucket[0],
				keys,
				{
					defaultMaxKeysPerBucket: (await getAppSettings())
						.defaultMaxKeysPerBucket,
				},
				newKeyObj,
				user.isImmortal,
			),
		};
	}

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
			await openModal(
				payload.trigger_id,
				manageKeysModal(
					bucket[0],
					keys,
					{
						defaultMaxKeysPerBucket: (await getAppSettings())
							.defaultMaxKeysPerBucket,
					},
					undefined,
					user.isImmortal,
				),
			);
		}
	}

	if (actionId === "generate_key" && actionValue) {
		const bucketId = actionValue;
		const bucket = await db
			.select()
			.from(buckets)
			.where(and(eq(buckets.id, bucketId), eq(buckets.userId, user.id)))
			.limit(1);

		if (bucket.length > 0) {
			// Enforce 20 keys per bucket here too (Slack path bypasses dashboard API).
			const keysBefore = await db
				.select()
				.from(bucketKeys)
				.where(eq(bucketKeys.bucketId, bucketId));

			const settings = await getAppSettings();
			const MAX_KEYS_PER_BUCKET = settings.defaultMaxKeysPerBucket;
			if (!user.isImmortal && keysBefore.length >= MAX_KEYS_PER_BUCKET) {
				await openModal(
					payload.trigger_id,
					Modal({ title: "Key Limit Reached" })
						.blocks(
							Section({
								text: `This bucket already has ${MAX_KEYS_PER_BUCKET} keys. Delete an existing key to create a new one.`,
							}),
						)
						.buildToObject(),
				);
				return;
			}

			if (user.markedAsOverAge) {
				await openModal(
					payload.trigger_id,
					Modal({ title: "Offboarding" })
						.blocks(
							Section({
								text: "Your account is in migration grace period. You cannot create new keys.",
							}),
						)
						.buildToObject(),
				);
				return;
			}

			const { accessKey, secretKey } = await createKey(bucketId, "slack");

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
					view: manageKeysModal(
						bucket[0],
						keys,
						{
							defaultMaxKeysPerBucket: (await getAppSettings())
								.defaultMaxKeysPerBucket,
						},
						newKeyObj,
						user.isImmortal,
					),
				}),
			});
		}
	}

	if (actionId === "delete_key" && actionValue) {
		if (user.dataExported) {
			await openModal(
				payload.trigger_id,
				Modal({ title: "Account Frozen" })
					.blocks(
						Section({
							text: "Your account is frozen due to data export. You cannot modify keys.",
						}),
					)
					.buildToObject(),
			);
			return;
		}

		const keyId = actionValue;
		const bucketId = payload.view.private_metadata;

		const bucket = await db
			.select()
			.from(buckets)
			.where(and(eq(buckets.id, bucketId), eq(buckets.userId, user.id)))
			.limit(1);

		if (bucket.length > 0) {
			await db.delete(bucketKeys).where(eq(bucketKeys.id, keyId));

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
					view: manageKeysModal(
						bucket[0],
						keys,
						{
							defaultMaxKeysPerBucket: (await getAppSettings())
								.defaultMaxKeysPerBucket,
						},
						undefined,
						user.isImmortal,
					),
				}),
			});
		}
	}

	if (actionId === "delete_bucket") {
		if (user.dataExported) {
			await openModal(
				payload.trigger_id,
				Modal({ title: "Account Frozen" })
					.blocks(
						Section({
							text: "Your account is frozen due to data export. You cannot delete buckets.",
						}),
					)
					.buildToObject(),
			);
			return;
		}

		const bucketId = actionValue;
		if (bucketId) {
			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.id, bucketId))
				.limit(1);

			if (bucket.length > 0 && bucket[0].isCdn) {
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

			await handleAppHomeOpened({ user: payload.user.id });
		}
	}

	if (actionId === "refresh_home") {
		await handleAppHomeOpened({ user: payload.user.id });
	}

	if (
		(actionId === "home_nav_prev" || actionId === "home_nav_next") &&
		actionValue
	) {
		const page = parseInt(actionValue, 10);
		const settings = await getAppSettings();

		const userBuckets = await db
			.select()
			.from(buckets)
			.where(eq(buckets.userId, user.id));

		await publishView(
			payload.user.id,
			homeView(
				user,
				userBuckets,
				{
					defaultMaxBucketsPerUser: settings.defaultMaxBucketsPerUser,
					defaultMaxKeysPerBucket: settings.defaultMaxKeysPerBucket,
				},
				page,
			),
		);
	}

	if (actionId === "delete_cdn_file" && actionValue) {
		if (user.dataExported) {
			await openModal(
				payload.trigger_id,
				Modal({ title: "Account Frozen" })
					.blocks(
						Section({
							text: "Your account is frozen due to data export. You cannot delete files.",
						}),
					)
					.buildToObject(),
			);
			return;
		}

		const parts = actionValue.split(":");
		const bucketId = parts[1];
		const key = parts[2];
		const uploaderSlackId = parts[3];

		// If this delete button belongs to a different uploader, deny.
		if (uploaderSlackId && uploaderSlackId !== payload.user.id) {
			await openModal(
				payload.trigger_id,
				Modal({ title: "Nope" })
					.blocks(
						Section({
							text: "You can't delete someone else's file.",
						}),
					)
					.buildToObject(),
			);
			return;
		}

		const bucket = await db
			.select()
			.from(buckets)
			.where(and(eq(buckets.id, bucketId), eq(buckets.userId, user.id)))
			.limit(1);

		if (bucket.length > 0) {
			const internalPath = getInternalPath(key, user, bucket[0]);
			await s3Client.fetch(internalPath, { method: "DELETE" });

			if (payload.message?.blocks) {
				const newBlocks = payload.message.blocks.map((block) => {
					const maybeAccessory = (block as { accessory?: unknown }).accessory;
					const maybeText = (block as { text?: unknown }).text;

					if (
						!maybeAccessory ||
						typeof maybeAccessory !== "object" ||
						!("action_id" in maybeAccessory) ||
						!("value" in maybeAccessory)
					) {
						return block;
					}

					const accessory = maybeAccessory as {
						action_id?: unknown;
						value?: unknown;
					};

					if (
						accessory.action_id !== "delete_cdn_file" ||
						accessory.value !== actionValue
					) {
						return block;
					}

					const displayName =
						typeof maybeText === "object" && maybeText && "text" in maybeText
							? typeof (maybeText as { text?: unknown }).text === "string"
								? (maybeText as { text: string }).text.split("\n")[0]
								: "(file)"
							: "(file)";

					return {
						type: "section",
						text: {
							type: "mrkdwn",
							text: `~${displayName}~\n_Deleted_`,
						},
					} satisfies SlackBlock;
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
							unfurl_links: false,
							unfurl_media: false,
						}),
					},
				);
			}
		}
	}
}
