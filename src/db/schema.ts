import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
	doublePrecision,
	index,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
	id: text("id").primaryKey(),
	email: text("email").notNull().unique(),
	slackId: text("slack_id"),
	storageLimitBytes: bigint("storage_limit_bytes", { mode: "number" }),
	storageUsageBytes: bigint("storage_usage_bytes", { mode: "number" })
		.notNull()
		.default(0),
	egressLimitBytes: bigint("egress_limit_bytes", { mode: "number" }),
	ingressBytes: bigint("ingress_bytes", { mode: "number" })
		.notNull()
		.default(0),
	egressBytes: bigint("egress_bytes", { mode: "number" }).notNull().default(0),
	totalRequests: bigint("total_requests", { mode: "number" })
		.notNull()
		.default(0),
	createdAt: timestamp("created_at").defaultNow(),
	updatedAt: timestamp("updated_at").defaultNow(),
	isAdmin: boolean("is_admin").default(false).notNull(),
	isReviewer: boolean("is_reviewer").default(false).notNull(),
	isImmortal: boolean("is_immortal").default(false).notNull(),
	isLocked: boolean("is_locked").default(false).notNull(),
	lockReason: text("lock_reason"),
	onboarded: boolean("onboarded").default(false).notNull(),

	markedAsOverAge: boolean("marked_as_over_age").default(false).notNull(),
	overAgeGracePeriodEndsAt: timestamp("over_age_grace_period_ends_at"),
	dataExported: boolean("data_exported").default(false).notNull(), // Locks account immediately upon download
	filesDeleted: boolean("files_deleted").default(false).notNull(), // Set after permanent deletion
});

export const sessions = pgTable("sessions", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.references(() => users.id, { onDelete: "cascade" })
		.notNull(),
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	tokenExpiresAt: timestamp("token_expires_at"),
	scope: text("scope"),
	userAgent: text("user_agent"),
	ipAddress: text("ip_address"),
	impersonatorUserId: text("impersonator_user_id").references(() => users.id, {
		onDelete: "set null",
	}),
	impersonatedUserId: text("impersonated_user_id").references(() => users.id, {
		onDelete: "set null",
	}),
	impersonationExpiresAt: timestamp("impersonation_expires_at"),
});

export const buckets = pgTable(
	"buckets",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		name: text("name").notNull(),
		userId: text("user_id").references(() => users.id),
		region: text("region").default("auto"),
		isPublic: boolean("is_public").default(false).notNull(),
		isSystem: boolean("is_system").default(false).notNull(),
		isPaused: boolean("is_paused").default(false).notNull(),
		pauseReason: text("pause_reason"),
		deepFreezeState: text("deep_freeze_state").default("active").notNull(),
		deepFreezeReason: text("deep_freeze_reason"),
		deepFreezeRequestedAt: timestamp("deep_freeze_requested_at"),
		deepFreezeStartedAt: timestamp("deep_freeze_started_at"),
		deepFreezeCompletedAt: timestamp("deep_freeze_completed_at"),
		deepFreezeArchiveKey: text("deep_freeze_archive_key"),
		deepFreezeArchiveBytes: bigint("deep_freeze_archive_bytes", {
			mode: "number",
		})
			.notNull()
			.default(0),
		deepFreezeProgress: doublePrecision("deep_freeze_progress")
			.notNull()
			.default(0),
		deepFreezeEstimatedFreezeSeconds: bigint(
			"deep_freeze_estimated_freeze_seconds",
			{ mode: "number" },
		)
			.notNull()
			.default(0),
		deepFreezeEstimatedUnfreezeSeconds: bigint(
			"deep_freeze_estimated_unfreeze_seconds",
			{ mode: "number" },
		)
			.notNull()
			.default(0),
		deepFreezeLastUpdatedAt: timestamp("deep_freeze_last_updated_at"),
		corsConfig: text("cors_config"), // JSON string of CORS rules
		customDomains: text("custom_domains"), // JSON string of verified custom domain config
		totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
		totalRequests: bigint("total_requests", { mode: "number" })
			.notNull()
			.default(0),
		createdAt: timestamp("created_at").defaultNow(),
		updatedAt: timestamp("updated_at").defaultNow(),
	},
	(table) => {
		return {
			nameIdx: index("name_idx").on(table.name),
			userIdIdx: index("user_id_idx").on(table.userId),
		};
	},
);

export const bucketKeys = pgTable(
	"bucket_keys",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		bucketId: uuid("bucket_id")
			.references(() => buckets.id, { onDelete: "cascade" })
			.notNull(),
		accessKey: text("access_key").notNull().unique(),
		secretKey: text("secret_key").notNull(),
		source: text("source").default("dashboard").notNull(),
		note: text("note"),
		isPaused: boolean("is_paused").default(false).notNull(),
		pauseReason: text("pause_reason"),
		createdAt: timestamp("created_at").defaultNow(),
	},
	(table) => {
		return {
			bucketIdIdx: index("bucket_id_idx").on(table.bucketId),
			accessKeyIdx: index("access_key_idx").on(table.accessKey),
		};
	},
);

export const offboardingExportSessions = pgTable(
	"offboarding_export_sessions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: text("user_id")
			.references(() => users.id, { onDelete: "cascade" })
			.notNull(),
		accessKey: text("access_key").notNull().unique(),
		secretKeyHash: text("secret_key_hash").notNull(),
		allowedPrefix: text("allowed_prefix").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		lastAccessedAt: timestamp("last_accessed_at"),
		usedAt: timestamp("used_at"),
		revokedAt: timestamp("revoked_at"),
		downloadCompletedAt: timestamp("download_completed_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => {
		return {
			userIdIdx: index("offboarding_export_sessions_user_id_idx").on(
				table.userId,
			),
			accessKeyIdx: index("offboarding_export_sessions_access_key_idx").on(
				table.accessKey,
			),
			expiresAtIdx: index("offboarding_export_sessions_expires_at_idx").on(
				table.expiresAt,
			),
		};
	},
);

export const bucketCollaborators = pgTable(
	"bucket_collaborators",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		bucketId: uuid("bucket_id")
			.references(() => buckets.id, { onDelete: "cascade" })
			.notNull(),
		inviteeUserId: text("invitee_user_id")
			.references(() => users.id, { onDelete: "cascade" })
			.notNull(),
		invitedByUserId: text("invited_by_user_id")
			.references(() => users.id, { onDelete: "cascade" })
			.notNull(),
		status: text("status").default("pending").notNull(),
		permissions: text("permissions").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
		respondedAt: timestamp("responded_at"),
		acceptedAt: timestamp("accepted_at"),
	},
	(table) => {
		return {
			bucketUserIdx: index("bucket_collaborator_bucket_user_idx").on(
				table.bucketId,
				table.inviteeUserId,
			),
			inviteeIdx: index("bucket_collaborator_invitee_idx").on(
				table.inviteeUserId,
				table.status,
			),
			inviterIdx: index("bucket_collaborator_inviter_idx").on(
				table.invitedByUserId,
			),
			statusIdx: index("bucket_collaborator_status_idx").on(table.status),
		};
	},
);

export const requestLogs = pgTable(
	"request_logs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		bucketId: uuid("bucket_id").references(() => buckets.id, {
			onDelete: "set null",
		}),
		bucketName: text("bucket_name"),
		ownerId: text("owner_id").references(() => users.id, {
			onDelete: "set null",
		}),
		requesterId: text("requester_id").references(() => users.id, {
			onDelete: "set null",
		}),
		method: text("method").notNull(), // GET, PUT, DELETE, HEAD
		path: text("path").notNull(), // The object key or path
		statusCode: bigint("status_code", { mode: "number" }).notNull(),
		ingressBytes: bigint("ingress_bytes", { mode: "number" }).default(0),
		egressBytes: bigint("egress_bytes", { mode: "number" }).default(0),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		latencyMs: bigint("latency_ms", { mode: "number" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => {
		return {
			ownerIdx: index("log_owner_idx").on(table.ownerId),
			bucketIdx: index("log_bucket_idx").on(table.bucketId),
			createdAtIdx: index("log_created_at_idx").on(table.createdAt),
		};
	},
);

export const objectStats = pgTable(
	"object_stats",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		bucketId: uuid("bucket_id")
			.references(() => buckets.id, { onDelete: "cascade" })
			.notNull(),
		objectKey: text("object_key").notNull(),
		hitCount: bigint("hit_count", { mode: "number" }).notNull().default(0),
		errorCount: bigint("error_count", { mode: "number" }).notNull().default(0),
		egressBytes: bigint("egress_bytes", { mode: "number" }).notNull().default(0),
		lastAccessedAt: timestamp("last_accessed_at"),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => {
		return {
			bucketObjectIdx: index("object_stats_bucket_object_idx").on(
				table.bucketId,
				table.objectKey,
			),
			hitCountIdx: index("object_stats_bucket_hits_idx").on(
				table.bucketId,
				table.hitCount,
			),
		};
	},
);

// Global settings (single-row table)
export const appSettings = pgTable("app_settings", {
	id: text("id").primaryKey().default("global"),
	defaultStorageLimitBytes: bigint("default_storage_limit_bytes", {
		mode: "number",
	})
		.notNull()
		.default(1073741824),
	// Egress default is formula-based: max(minEgressBytes, storageBytes * egressMultiplier)
	egressMultiplier: bigint("egress_multiplier", { mode: "number" })
		.notNull()
		.default(3),
	minEgressBytes: bigint("min_egress_bytes", { mode: "number" })
		.notNull()
		.default(10737418240),
	defaultMaxBucketsPerUser: bigint("default_max_buckets_per_user", {
		mode: "number",
	})
		.notNull()
		.default(50),
	defaultMaxKeysPerBucket: bigint("default_max_keys_per_bucket", {
		mode: "number",
	})
		.notNull()
		.default(20),
	yswsQuotaPerHourBytes: bigint("ysws_quota_per_hour_bytes", {
		mode: "number",
	})
		.notNull()
		.default(1073741824), // 1GB
	yswsBonusTiers: text("ysws_bonus_tiers"), // JSON string: [{ hours: 20, percent: 5 }, ...]
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const yswsSubmissions = pgTable(
	"ysws_submissions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: text("user_id")
			.references(() => users.id)
			.notNull(),
		projectName: text("project_name").notNull(),
		shortDescription: text("short_description").notNull(),
		repoUrl: text("repo_url").notNull(),
		demoUrl: text("demo_url").notNull(),
		hackatimeProject: text("hackatime_project"), // Can be comma separated if multiple
		hoursSpent: doublePrecision("hours_spent").notNull(),
		usedAi: boolean("used_ai").default(false).notNull(),
		aiToolUsage: text("ai_tool_usage"),
		aiUsageDescription: text("ai_usage_description"),
		aiPercent: bigint("ai_percent", { mode: "number" }).default(0),
		screenshotUrl: text("screenshot_url"),
		readmeConfirmed: boolean("readme_confirmed").default(false).notNull(),
		status: text("status").default("pending").notNull(), // pending, approved, rejected
		adminNotesPublic: text("admin_notes_public"),
		adminNotesPrivate: text("admin_notes_private"),
		createdAt: timestamp("created_at").defaultNow(),
		reviewedAt: timestamp("reviewed_at"),
		reviewedBy: text("reviewed_by").references(() => users.id),
		tierBonusPercent: doublePrecision("tier_bonus_percent")
			.default(0)
			.notNull(),
		adminBonusPercent: doublePrecision("admin_bonus_percent")
			.default(0)
			.notNull(),
	},
	(table) => {
		return {
			userIdIdx: index("ysws_user_id_idx").on(table.userId),
			statusIdx: index("ysws_status_idx").on(table.status),
		};
	},
);

export const redemptionPrograms = pgTable("redemption_programs", {
	id: uuid("id").defaultRandom().primaryKey(),
	name: text("name").notNull(),
	prefix: text("prefix").notNull().unique(), // e.g. "HACK"
	description: text("description"),
	quotaCreditBytes: bigint("quota_credit_bytes", { mode: "number" })
		.notNull()
		.default(0),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const redemptionCodes = pgTable(
	"redemption_codes",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		programId: uuid("program_id")
			.references(() => redemptionPrograms.id, { onDelete: "cascade" })
			.notNull(),
		code: text("code").notNull().unique(),
		isRedeemed: boolean("is_redeemed").default(false).notNull(),
		redeemedBy: text("redeemed_by").references(() => users.id),
		redeemedAt: timestamp("redeemed_at"),
		createdBy: text("created_by").references(() => users.id),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => {
		return {
			programIdx: index("redemption_code_program_idx").on(table.programId),
			codeIdx: index("redemption_code_code_idx").on(table.code),
			redeemedByIdx: index("redemption_code_redeemed_by_idx").on(
				table.redeemedBy,
			),
			createdByIdx: index("redemption_code_created_by_idx").on(table.createdBy),
		};
	},
);

export const redemptionLogs = pgTable(
	"redemption_logs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: text("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		ipAddress: text("ip_address"),
		codeAttempted: text("code_attempted"),
		success: boolean("success").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => {
		return {
			userIdIdx: index("redemption_log_user_id_idx").on(table.userId),
			ipIdx: index("redemption_log_ip_idx").on(table.ipAddress),
			createdAtIdx: index("redemption_log_created_at_idx").on(table.createdAt),
		};
	},
);

export const usersRelations = relations(users, ({ many }) => ({
	buckets: many(buckets),
	collaborationInvites: many(bucketCollaborators),
}));

export const bucketsRelations = relations(buckets, ({ one, many }) => ({
	user: one(users, {
		fields: [buckets.userId],
		references: [users.id],
	}),
	keys: many(bucketKeys),
	collaborators: many(bucketCollaborators),
}));

export const bucketKeysRelations = relations(bucketKeys, ({ one }) => ({
	bucket: one(buckets, {
		fields: [bucketKeys.bucketId],
		references: [buckets.id],
	}),
}));

export const bucketCollaboratorsRelations = relations(
	bucketCollaborators,
	({ one }) => ({
		bucket: one(buckets, {
			fields: [bucketCollaborators.bucketId],
			references: [buckets.id],
		}),
		invitee: one(users, {
			fields: [bucketCollaborators.inviteeUserId],
			references: [users.id],
		}),
		inviter: one(users, {
			fields: [bucketCollaborators.invitedByUserId],
			references: [users.id],
		}),
	}),
);
export const deepFreezeJobs = pgTable(
	"deep_freeze_jobs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		bucketId: uuid("bucket_id")
			.references(() => buckets.id, { onDelete: "cascade" })
			.notNull(),
		requestedByUserId: text("requested_by_user_id")
			.references(() => users.id, { onDelete: "set null" })
			.notNull(),
		action: text("action").notNull(),
		status: text("status").default("queued").notNull(),
		archiveKey: text("archive_key"),
		manifestKey: text("manifest_key"),
		lockToken: text("lock_token"),
		workerId: text("worker_id"),
		totalObjects: bigint("total_objects", { mode: "number" })
			.notNull()
			.default(0),
		processedObjects: bigint("processed_objects", { mode: "number" })
			.notNull()
			.default(0),
		totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
		processedBytes: bigint("processed_bytes", { mode: "number" })
			.notNull()
			.default(0),
		archiveBytes: bigint("archive_bytes", { mode: "number" })
			.notNull()
			.default(0),
		progressPercent: doublePrecision("progress_percent").notNull().default(0),
		checksumSha256: text("checksum_sha256"),
		manifestJson: text("manifest_json").notNull().default("[]"),
		failureCode: text("failure_code"),
		failureMessage: text("failure_message"),
		retryCount: bigint("retry_count", { mode: "number" }).notNull().default(0),
		startedAt: timestamp("started_at"),
		completedAt: timestamp("completed_at"),
		heartbeatAt: timestamp("heartbeat_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => {
		return {
			bucketIdx: index("deep_freeze_jobs_bucket_idx").on(table.bucketId),
			statusIdx: index("deep_freeze_jobs_status_idx").on(table.status),
			actionIdx: index("deep_freeze_jobs_action_idx").on(table.action),
			heartbeatIdx: index("deep_freeze_jobs_heartbeat_idx").on(
				table.heartbeatAt,
			),
		};
	},
);
