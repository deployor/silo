import type { InferSelectModel } from "drizzle-orm";
import {
	Actions,
	Button,
	ConfirmationDialog,
	Context,
	Divider,
	Header,
	HomeTab,
	Input,
	Modal,
	Option,
	OverflowMenu,
	Section,
	TextInput,
} from "slack-block-builder";
import { config } from "../../config";
import type { bucketKeys, buckets, users } from "../../db/schema";

type User = InferSelectModel<typeof users>;
type Bucket = InferSelectModel<typeof buckets>;
type BucketKey = InferSelectModel<typeof bucketKeys>;

function formatBytes(bytes: number) {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

export const homeView = (
	user: User,
	buckets: Bucket[],
	settings: {
		defaultMaxBucketsPerUser: number;
		defaultMaxKeysPerBucket: number;
	},
	page = 0,
) => {
	const limit = user.storageLimitBytes ?? 0;
	const usagePercent = limit > 0 ? (user.storageUsageBytes / limit) * 100 : 0;

	const ITEMS_PER_PAGE = 10;
	const totalPages = Math.ceil(buckets.length / ITEMS_PER_PAGE);
	const start = page * ITEMS_PER_PAGE;
	const end = start + ITEMS_PER_PAGE;
	const displayBuckets = buckets.slice(start, end);

	return HomeTab()
		.blocks(
			Header({ text: "Silo" }),
			Section({ text: "Howdy partner! :ms-cowhand:" }),
			Actions().elements(
				Button({
					text: ":lava-bucket: Create Bucket",
					actionId: "open_create_bucket_modal",
				}).primary(),
				Button({
					text: ":ms-arrows-clockwise: Refresh Stats",
					actionId: "refresh_home",
				}),
				Button({
					text: ":dinowow: Web Dashboard",
					url: `https://${config.s3Domain}`,
					actionId: "open_web_dashboard",
				}),
			),
			Divider(),
			Section({ text: "*:ms-increasing-graph: Usage Overview*" }),
			Section().fields(
				`*Storage Used*\n${formatBytes(user.storageUsageBytes)} / ${user.isImmortal ? "∞" : formatBytes(user.storageLimitBytes ?? 0)} ${user.isImmortal ? "" : `(${usagePercent.toFixed(1)}%)`}`,
				`*Active Buckets*\n${buckets.length} / ${user.isImmortal ? "∞" : settings.defaultMaxBucketsPerUser}`,
			),
			Section().fields(
				`*Total Requests*\n${user.totalRequests.toLocaleString()}`,
				`*Network Traffic*\n:ms-inbox: ${formatBytes(user.ingressBytes)}  :ms-outbox: ${formatBytes(user.egressBytes)}`,
			),
			Divider(),
			Section({ text: `*:lava-bucket: Your Buckets (${buckets.length})*` }),
			Divider(),
			...displayBuckets.flatMap((bucket) => {
				const options = [];

				if (!bucket.isCdn) {
					options.push(
						Option({
							text: ":ms-wrench: Manage Keys",
							value: `manage_keys:${bucket.id}`,
						}),
						Option({
							text: bucket.isPublic
								? ":ms-shush: Make Private"
								: ":ms-globe: Make Public",
							value: `toggle_public:${bucket.id}`,
						}),
						Option({
							text: ":angry-dino: Delete Bucket",
							value: `delete_bucket:${bucket.id}`,
						}),
					);
				} else {
					options.push(
						Option({
							text: ":ms-info: CDN Bucket (Managed)",
							value: "noop",
						}),
					);
				}

				const bucketSection = Section({
					text: `*${bucket.name}*${bucket.isCdn ? " (CDN)" : ""}`,
				});

				if (options.length > 0 && !bucket.isCdn) {
					bucketSection.accessory(
						OverflowMenu({
							actionId: "bucket_overflow_action",
						}).options(...options),
					);
				}

				return [
					bucketSection,
					Context().elements(
						`${bucket.isPublic ? ":ms-globe: Public" : ":ms-shush: Private"}  •  :ms-floppy-disk: ${formatBytes(bucket.totalBytes)}  •  ${bucket.totalRequests} reqs  •  Made on ${bucket.createdAt ? new Date(bucket.createdAt).toLocaleDateString() : "Unknown"}`,
					),
					Divider(),
				];
			}),
			displayBuckets.length === 0
				? [
						Section({
							text: "_You don't have any buckets yet. Create one!_",
						}),
						Divider(),
					]
				: [],
			totalPages > 1
				? [
						Actions().elements(
							page > 0
								? Button({
										text: "Previous",
										value: `${page - 1}`,
										actionId: "home_nav_prev",
									})
								: undefined,
							page < totalPages - 1
								? Button({
										text: "Next",
										value: `${page + 1}`,
										actionId: "home_nav_next",
									})
								: undefined,
						),
						Context().elements(`Page ${page + 1} of ${totalPages}`),
					]
				: [],
			Context().elements(
				`Last updated: ${new Date().toLocaleTimeString()} :ms-tick:  |  <https://silo.deployor.dev/docs|Documentation :ms-info:>`,
			),
		)
		.buildToObject();
};

export const createBucketModal = () => {
	return Modal({
		title: "New Bucket :lava-bucket:",
		callbackId: "create_bucket_submission",
		submit: "Confirm",
		close: "Cancel :byee:",
	})
		.blocks(
			Input({
				label: "Bucket Name",
				blockId: "bucket_name_block",
				hint: "Lowercase letters, numbers, and hyphens only. :ms-wink:",
			}).element(
				TextInput({
					actionId: "bucket_name_input",
					placeholder: "my-awesome-bucket",
				}),
			),
		)
		.buildToObject();
};

export const manageKeysModal = (
	bucket: Bucket,
	keys: BucketKey[],
	settings: { defaultMaxKeysPerBucket: number },
	newKey?: { accessKey: string; secretKey: string },
	isImmortal = false,
) => {
	const isAtLimit =
		!isImmortal && keys.length >= settings.defaultMaxKeysPerBucket;

	return Modal({
		title: `Keys: ${bucket.name}`,
		callbackId: "manage_keys_view",
		privateMetaData: bucket.id,
		close: "Done",
	})
		.blocks(
			Section({
				text: "Here are the keys :ms-wrench:",
			}).accessory(
				Button({
					text: isAtLimit ? "Key Limit Reached" : "Make New Key :blobby-lock:",
					actionId: "generate_key",
					value: bucket.id,
				}).primary(),
			),
			Context().elements(
				isImmortal
					? `Keys: ${keys.length} / ∞`
					: isAtLimit
						? `Keys: ${keys.length} / ${settings.defaultMaxKeysPerBucket} (limit reached… delete one to create another)`
						: `Keys: ${keys.length} / ${settings.defaultMaxKeysPerBucket}`,
			),
			Divider(),
			newKey
				? [
						Section({
							text: `:yay: *New Key Made *\n\n*Access Key:*\n\`${newKey.accessKey}\`\n*Secret Key:*\n\`${newKey.secretKey}\`\n\n:ms-red-exclamation-mark: *Save this secret key now. It will only be shown to you here once!*`,
						}),
						Divider(),
					]
				: [],
			...keys.flatMap((key) => [
				Section({
					text: `*Access Key:*\n\`${key.accessKey}\`\n*Secret Key:*\n\`${key.secretKey.substring(0, 4)}...${key.secretKey.substring(key.secretKey.length - 4)}\``,
				}).accessory(
					Button({
						text: "Delete",
						actionId: "delete_key",
						value: key.id,
					})
						.danger()
						.confirm(
							ConfirmationDialog({
								title: "Delete Key? :panic:",
								text: "Are you sure you want to delete this access key? This action cannot be undone. :floshed:",
								confirm: "Delete Key",
								deny: "Keep It",
							}),
						),
				),
				Divider(),
			]),
			Context().elements(
				":ms-concern: Keep your secret keys secret. Don't share them with strangers!",
			),
		)
		.buildToObject();
};

export const deleteBucketWarningModal = () => {
	return Modal({
		title: "Whoa there! :ms-scared:",
		close: "Got it",
	})
		.blocks(
			Section({ text: ":ms-stop-sign: *Hold your horses!*" }),
			Section({
				text: `For security, you gotta head over to the <https://${config.s3Domain}|web dashboard> to delete buckets. Safety first! :ms-cowhand:`,
			}),
		)
		.buildToObject();
};

export const filesModal = (
	bucketName: string,
	files: {
		name: string | undefined;
		size: number;
		lastModified: string;
		url: string;
	}[],
) => {
	const displayFiles = files.slice(0, 20);

	return Modal({
		title: `Stash: ${bucketName}`,
		close: "Done",
	})
		.blocks(
			Section({ text: `Contents of *${bucketName}* :neofox_box:` }),
			Divider(),
			files.length > 0
				? displayFiles.map((file) =>
						Section({
							text: `*${file.name}*\n${formatBytes(file.size)} • ${new Date(file.lastModified).toLocaleDateString()}`,
						}).accessory(
							Button({
								text: "Peek :ms-raised-eyebrow:",
								url: file.url,
								actionId: "open_file_url",
							}),
						),
					)
				: Section({ text: "_This bucket is empty! :dino_waah:_" }),
			files.length > 20
				? Section({
						text: `_...and ${files.length - 20} more files. Check the dashboard for the full stash! :ms-bar-chart:_`,
					})
				: undefined,
		)
		.buildToObject();
};
