import { relations, sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	check,
	doublePrecision,
	foreignKey,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
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
	egressPeriod: text("egress_period"),
	totalRequests: bigint("total_requests", { mode: "number" })
		.notNull()
		.default(0),
	createdAt: timestamp("created_at").defaultNow(),
	updatedAt: timestamp("updated_at").defaultNow(),
	isAdmin: boolean("is_admin").default(false).notNull(),
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
		// Legacy signing-region value retained for backwards compatibility.
		region: text("region").default("auto"),
		requestedRegion: text("requested_region").default("auto").notNull(),
		resolvedRegion: text("resolved_region")
			.default("eu-central")
			.notNull()
			.references(() => storageRegionState.regionId, { onDelete: "restrict" }),
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
			nameUniqueIdx: uniqueIndex("buckets_name_unique_idx").on(table.name),
			userIdIdx: index("user_id_idx").on(table.userId),
			requestedRegionCheck: check(
				"buckets_requested_region_check",
				sql`${table.requestedRegion} ~ '^[a-z0-9][a-z0-9-]*$'`,
			),
			resolvedRegionCheck: check(
				"buckets_resolved_region_check",
				sql`${table.resolvedRegion} ~ '^[a-z0-9][a-z0-9-]*$'`,
			),
		};
	},
);

/**
 * Durable logical tombstones intentionally have no user/bucket foreign keys:
 * they must survive cascades long enough to audit and reconcile provider
 * replication after the live bucket row has gone away.
 */
export const bucketDeletionTombstones = pgTable(
	"bucket_deletion_tombstones",
	{
		bucketId: uuid("bucket_id").primaryKey(),
		bucketName: text("bucket_name").notNull(),
		ownerUserId: text("owner_user_id"),
		requestedRegion: text("requested_region").notNull(),
		resolvedRegion: text("resolved_region").notNull(),
		rootPrefix: text("root_prefix"),
		deletedByUserId: text("deleted_by_user_id"),
		deletedAt: timestamp("deleted_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		regionDeletedAtIdx: index(
			"bucket_deletion_tombstones_region_deleted_at_idx",
		).on(table.resolvedRegion, table.deletedAt),
		resolvedRegionCheck: check(
			"bucket_deletion_tombstones_resolved_region_check",
			sql`${table.resolvedRegion} ~ '^[a-z0-9][a-z0-9-]*$'`,
		),
		requestedRegionCheck: check(
			"bucket_deletion_tombstones_requested_region_check",
			sql`${table.requestedRegion} ~ '^[a-z0-9][a-z0-9-]*$'`,
		),
	}),
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
		egressBytes: bigint("egress_bytes", { mode: "number" })
			.notNull()
			.default(0),
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
	s3MaintenanceMode: boolean("s3_maintenance_mode").notNull().default(false),
	fullMaintenanceMode: boolean("full_maintenance_mode")
		.notNull()
		.default(false),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const redemptionPrograms = pgTable("redemption_programs", {
	id: uuid("id").defaultRandom().primaryKey(),
	name: text("name").notNull(),
	prefix: text("prefix").notNull().unique(), // e.g. "HACK"
	description: text("description"),
	quotaCreditBytes: bigint("quota_credit_bytes", { mode: "number" })
		.notNull()
		.default(0),
	apiKeyHash: text("api_key_hash"),
	apiKeySuffix: text("api_key_suffix"),
	apiKeyCreatedAt: timestamp("api_key_created_at"),
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
		quotaCreditBytes: bigint("quota_credit_bytes", { mode: "number" }),
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

export const redemptionTransactions = pgTable(
	"redemption_transactions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		programId: uuid("program_id")
			.references(() => redemptionPrograms.id, { onDelete: "restrict" })
			.notNull(),
		userId: text("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		targetUserId: text("target_user_id"),
		targetEmail: text("target_email"),
		targetSlackId: text("target_slack_id"),
		actorUserId: text("actor_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		source: text("source").notNull(),
		codeId: uuid("code_id").references(() => redemptionCodes.id, {
			onDelete: "set null",
		}),
		externalId: text("external_id"),
		amountBytes: bigint("amount_bytes", { mode: "number" }).notNull(),
		reason: text("reason"),
		ipAddress: text("ip_address"),
		apiKeySuffix: text("api_key_suffix"),
		requestUserAgent: text("request_user_agent"),
		fulfilledAt: timestamp("fulfilled_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => {
		return {
			programIdx: index("redemption_transaction_program_idx").on(
				table.programId,
			),
			userIdIdx: index("redemption_transaction_user_id_idx").on(table.userId),
			targetUserIdIdx: index("redemption_transaction_target_user_id_idx").on(
				table.targetUserId,
			),
			createdAtIdx: index("redemption_transaction_created_at_idx").on(
				table.createdAt,
			),
			externalIdIdx: uniqueIndex("redemption_transaction_external_id_idx").on(
				table.programId,
				table.externalId,
			),
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

export const dataplaneWriterLeases = pgTable(
	"dataplane_writer_lease",
	{
		name: text("name").primaryKey(),
		holderId: text("holder_id").notNull(),
		generation: bigint("generation", { mode: "bigint" }).notNull(),
		leaseExpiresAt: timestamp("lease_expires_at", {
			withTimezone: true,
		}).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		regionNameCheck: check(
			"dataplane_writer_lease_region_name_check",
			sql`${table.name} ~ '^s3:[a-z0-9][a-z0-9-]*$'`,
		),
	}),
);

export const storageRegionBackends = pgTable(
	"storage_region_backends",
	{
		regionId: text("region_id").notNull(),
		backendId: text("backend_id").notNull(),
		provider: text("provider").notNull(),
		bucketName: text("bucket_name"),
		role: text("role").default("primary").notNull(),
		status: text("status").default("standby").notNull(),
		promotionAuthorized: boolean("promotion_authorized")
			.default(false)
			.notNull(),
		replicationCheckpoint: bigint("replication_checkpoint", {
			mode: "bigint",
		})
			.default(0n)
			.notNull(),
		replicationCaughtUpAt: timestamp("replication_caught_up_at", {
			withTimezone: true,
		}),
		lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
		// A newly registered replica is not promotable until the dataplane has
		// copied and verified the complete pre-existing object set. Live event
		// checkpoints alone cannot prove that historical objects were copied.
		bootstrapState: text("bootstrap_state").default("pending").notNull(),
		bootstrapBarrierSequence: bigint("bootstrap_barrier_sequence", {
			mode: "bigint",
		}),
		bootstrapCursor: text("bootstrap_cursor"),
		bootstrapObjectsCopied: bigint("bootstrap_objects_copied", {
			mode: "bigint",
		})
			.default(0n)
			.notNull(),
		bootstrapBytesCopied: bigint("bootstrap_bytes_copied", {
			mode: "bigint",
		})
			.default(0n)
			.notNull(),
		bootstrapSourceBackendId: text("bootstrap_source_backend_id"),
		bootstrapSourceGeneration: bigint("bootstrap_source_generation", {
			mode: "bigint",
		}),
		bootstrapStartedAt: timestamp("bootstrap_started_at", {
			withTimezone: true,
		}),
		bootstrapHeartbeatAt: timestamp("bootstrap_heartbeat_at", {
			withTimezone: true,
		}),
		bootstrapCompletedAt: timestamp("bootstrap_completed_at", {
			withTimezone: true,
		}),
		bootstrapVerifiedAt: timestamp("bootstrap_verified_at", {
			withTimezone: true,
		}),
		bootstrapLastError: text("bootstrap_last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.regionId, table.backendId] }),
		regionStatusIdx: index("storage_region_backends_region_status_idx").on(
			table.regionId,
			table.status,
		),
		activeRegionIdx: uniqueIndex("storage_region_backends_one_active_idx")
			.on(table.regionId)
			.where(sql`${table.status} = 'active'`),
		authorizedRegionIdx: uniqueIndex(
			"storage_region_backends_one_authorized_idx",
		)
			.on(table.regionId)
			.where(sql`${table.promotionAuthorized} = true`),
		regionIdCheck: check(
			"storage_region_backends_region_id_check",
			sql`${table.regionId} ~ '^[a-z0-9][a-z0-9-]*$'`,
		),
		backendIdCheck: check(
			"storage_region_backends_backend_id_check",
			sql`${table.backendId} ~ '^[a-z0-9][a-z0-9-]*$'`,
		),
		roleCheck: check(
			"storage_region_backends_role_check",
			sql`${table.role} IN ('primary', 'replica')`,
		),
		statusCheck: check(
			"storage_region_backends_status_check",
			sql`${table.status} IN ('active', 'standby', 'unavailable', 'disabled')`,
		),
		checkpointCheck: check(
			"storage_region_backends_checkpoint_check",
			sql`${table.replicationCheckpoint} >= 0`,
		),
		bootstrapStateCheck: check(
			"storage_region_backends_bootstrap_state_check",
			sql`${table.bootstrapState} IN ('pending', 'running', 'verifying', 'complete', 'failed')`,
		),
		bootstrapProgressCheck: check(
			"storage_region_backends_bootstrap_progress_check",
			sql`(${table.bootstrapBarrierSequence} IS NULL OR ${table.bootstrapBarrierSequence} >= 0)
				AND ${table.bootstrapObjectsCopied} >= 0
				AND ${table.bootstrapBytesCopied} >= 0
				AND (${table.bootstrapSourceGeneration} IS NULL OR ${table.bootstrapSourceGeneration} > 0)`,
		),
		bootstrapCompleteCheck: check(
			"storage_region_backends_bootstrap_complete_check",
			sql`${table.bootstrapState} <> 'complete' OR (
				${table.bootstrapBarrierSequence} IS NOT NULL
				AND ${table.bootstrapStartedAt} IS NOT NULL
				AND ${table.bootstrapCompletedAt} IS NOT NULL
				AND ${table.bootstrapVerifiedAt} IS NOT NULL
				AND ${table.bootstrapLastError} IS NULL
				AND ${table.replicationCheckpoint} >= ${table.bootstrapBarrierSequence}
			)`,
		),
		promotionBootstrapCheck: check(
			"storage_region_backends_promotion_bootstrap_check",
			sql`${table.promotionAuthorized} = false OR (
				${table.bootstrapState} = 'complete'
				AND ${table.bootstrapVerifiedAt} IS NOT NULL
				AND ${table.bootstrapBarrierSequence} IS NOT NULL
				AND ${table.replicationCheckpoint} >= ${table.bootstrapBarrierSequence}
			)`,
		),
		bootstrapSourceFk: foreignKey({
			columns: [table.regionId, table.bootstrapSourceBackendId],
			foreignColumns: [table.regionId, table.backendId],
		}),
	}),
);

export const storageRegionState = pgTable(
	"storage_region_state",
	{
		regionId: text("region_id").primaryKey(),
		activeBackendId: text("active_backend_id").notNull(),
		backendGeneration: bigint("backend_generation", { mode: "bigint" })
			.default(1n)
			.notNull(),
		requiredReplicationCheckpoint: bigint("required_replication_checkpoint", {
			mode: "bigint",
		})
			.default(0n)
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		activeBackendFk: foreignKey({
			columns: [table.regionId, table.activeBackendId],
			foreignColumns: [
				storageRegionBackends.regionId,
				storageRegionBackends.backendId,
			],
		}),
		generationCheck: check(
			"storage_region_state_generation_check",
			sql`${table.backendGeneration} > 0`,
		),
		checkpointCheck: check(
			"storage_region_state_checkpoint_check",
			sql`${table.requiredReplicationCheckpoint} >= 0`,
		),
		regionIdCheck: check(
			"storage_region_state_region_id_check",
			sql`${table.regionId} ~ '^[a-z0-9][a-z0-9-]*$'`,
		),
	}),
);

export const storageBackendPromotions = pgTable(
	"storage_backend_promotions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		regionId: text("region_id").notNull(),
		fromBackendId: text("from_backend_id").notNull(),
		toBackendId: text("to_backend_id").notNull(),
		oldBackendGeneration: bigint("old_backend_generation", {
			mode: "bigint",
		}).notNull(),
		newBackendGeneration: bigint("new_backend_generation", {
			mode: "bigint",
		}).notNull(),
		requiredReplicationCheckpoint: bigint("required_replication_checkpoint", {
			mode: "bigint",
		}).notNull(),
		observedReplicationCheckpoint: bigint("observed_replication_checkpoint", {
			mode: "bigint",
		}).notNull(),
		actor: text("actor").notNull(),
		reason: text("reason").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		regionCreatedAtIdx: index(
			"storage_backend_promotions_region_created_at_idx",
		).on(table.regionId, table.createdAt),
		fromBackendFk: foreignKey({
			columns: [table.regionId, table.fromBackendId],
			foreignColumns: [
				storageRegionBackends.regionId,
				storageRegionBackends.backendId,
			],
		}),
		toBackendFk: foreignKey({
			columns: [table.regionId, table.toBackendId],
			foreignColumns: [
				storageRegionBackends.regionId,
				storageRegionBackends.backendId,
			],
		}),
	}),
);

export const storageBackendAdminEvents = pgTable(
	"storage_backend_admin_events",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		regionId: text("region_id").notNull(),
		backendId: text("backend_id").notNull(),
		action: text("action").notNull(),
		actor: text("actor").notNull(),
		detailsJson: text("details_json").notNull().default("{}"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		regionCreatedAtIdx: index(
			"storage_backend_admin_events_region_created_at_idx",
		).on(table.regionId, table.createdAt),
		backendFk: foreignKey({
			columns: [table.regionId, table.backendId],
			foreignColumns: [
				storageRegionBackends.regionId,
				storageRegionBackends.backendId,
			],
		}),
		actionCheck: check(
			"storage_backend_admin_events_action_check",
			sql`${table.action} IN ('register', 'status', 'bootstrap', 'bootstrap_retry', 'authorize', 'revoke')`,
		),
	}),
);

export const storageReplicationEvents = pgTable(
	"storage_replication_events",
	{
		sequence: bigserial("sequence", { mode: "bigint" }).primaryKey(),
		eventId: uuid("event_id").defaultRandom().notNull().unique(),
		regionId: text("region_id").notNull(),
		sourceBackendId: text("source_backend_id").notNull(),
		backendGeneration: bigint("backend_generation", {
			mode: "bigint",
		}).notNull(),
		// Deliberately no FK: tombstones must survive logical bucket deletion.
		bucketId: uuid("bucket_id").notNull(),
		objectKey: text("object_key").notNull(),
		operation: text("operation").notNull(),
		state: text("state").default("prepared").notNull(),
		failureReason: text("failure_reason"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		committedAt: timestamp("committed_at", { withTimezone: true }),
		finalizedAt: timestamp("finalized_at", { withTimezone: true }),
	},
	(table) => ({
		eventRegionUniqueIdx: uniqueIndex(
			"storage_replication_events_sequence_region_unique",
		).on(table.sequence, table.regionId),
		regionSequenceIdx: index(
			"storage_replication_events_region_sequence_idx",
		).on(table.regionId, table.sequence),
		committedSequenceIdx: index(
			"storage_replication_events_committed_sequence_idx",
		)
			.on(table.regionId, table.sequence)
			.where(sql`${table.state} = 'committed'`),
		sourceBackendFk: foreignKey({
			columns: [table.regionId, table.sourceBackendId],
			foreignColumns: [
				storageRegionBackends.regionId,
				storageRegionBackends.backendId,
			],
		}),
		operationCheck: check(
			"storage_replication_events_operation_check",
			sql`${table.operation} IN ('put', 'delete')`,
		),
		backendGenerationCheck: check(
			"storage_replication_events_backend_generation_check",
			sql`${table.backendGeneration} > 0`,
		),
		stateCheck: check(
			"storage_replication_events_state_check",
			sql`${table.state} IN ('prepared', 'committed', 'cancelled')`,
		),
	}),
);

export const storageReplicationDeliveries = pgTable(
	"storage_replication_deliveries",
	{
		sequence: bigint("sequence", { mode: "bigint" }).notNull(),
		regionId: text("region_id").notNull(),
		targetBackendId: text("target_backend_id").notNull(),
		status: text("status").default("pending").notNull(),
		attempts: bigint("attempts", { mode: "number" }).default(0).notNull(),
		lastError: text("last_error"),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.sequence, table.targetBackendId] }),
		eventFk: foreignKey({
			columns: [table.sequence, table.regionId],
			foreignColumns: [
				storageReplicationEvents.sequence,
				storageReplicationEvents.regionId,
			],
		}).onDelete("cascade"),
		targetBackendFk: foreignKey({
			columns: [table.regionId, table.targetBackendId],
			foreignColumns: [
				storageRegionBackends.regionId,
				storageRegionBackends.backendId,
			],
		}),
		pendingIdx: index("storage_replication_deliveries_pending_idx")
			.on(table.status, table.nextAttemptAt, table.sequence)
			.where(sql`${table.status} IN ('pending', 'failed')`),
		statusCheck: check(
			"storage_replication_deliveries_status_check",
			sql`${table.status} IN ('pending', 'running', 'complete', 'failed')`,
		),
		attemptsCheck: check(
			"storage_replication_deliveries_attempts_check",
			sql`${table.attempts} >= 0`,
		),
	}),
);

export const multipartUploadGenerations = pgTable(
	"multipart_upload_generations",
	{
		uploadId: text("upload_id").primaryKey(),
		bucketId: uuid("bucket_id").notNull(),
		storageRegion: text("storage_region").default("eu-central").notNull(),
		backendId: text("backend_id").default("primary").notNull(),
		backendGeneration: bigint("backend_generation", { mode: "bigint" })
			.default(1n)
			.notNull(),
		writerGeneration: bigint("writer_generation", {
			mode: "bigint",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		createdAtIdx: index("multipart_upload_generations_created_at_idx").on(
			table.createdAt,
		),
		storageRegionIdx: index(
			"multipart_upload_generations_storage_region_idx",
		).on(table.storageRegion),
		storageBackendFk: foreignKey({
			columns: [table.storageRegion, table.backendId],
			foreignColumns: [
				storageRegionBackends.regionId,
				storageRegionBackends.backendId,
			],
		}),
		storageRegionCheck: check(
			"multipart_upload_generations_storage_region_check",
			sql`${table.storageRegion} ~ '^[a-z0-9][a-z0-9-]*$'`,
		),
		backendGenerationCheck: check(
			"multipart_upload_generations_backend_generation_check",
			sql`${table.backendGeneration} > 0`,
		),
	}),
);

export const dataplaneAccountingEvents = pgTable(
	"dataplane_accounting_events",
	{
		id: text("id").primaryKey(),
		appliedAt: timestamp("applied_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
);

export const dataplaneQuotaReservations = pgTable(
	"dataplane_quota_reservations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: text("user_id")
			.references(() => users.id, { onDelete: "cascade" })
			.notNull(),
		kind: text("kind").default("storage").notNull(),
		bytes: bigint("bytes", { mode: "bigint" }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		userKindExpiryIdx: index(
			"dataplane_quota_reservations_user_kind_expiry_idx",
		).on(table.userId, table.kind, table.expiresAt),
		kindCheck: check(
			"dataplane_quota_reservations_kind_check",
			sql`${table.kind} = 'storage'`,
		),
		bytesCheck: check(
			"dataplane_quota_reservations_bytes_check",
			sql`${table.bytes} > 0`,
		),
	}),
);

/**
 * Durable provider-mutation journal. The dataplane records intent before the
 * physical write, then applies accounting and reservation release
 * idempotently after provider success. Prepared/ambiguous rows intentionally
 * survive for provider reconciliation rather than guessing an object delta.
 */
export const dataplaneMutationIntents = pgTable(
	"dataplane_mutation_intents",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		regionId: text("region_id")
			.references(() => storageRegionState.regionId, { onDelete: "restrict" })
			.notNull(),
		bucketId: uuid("bucket_id")
			.references(() => buckets.id, { onDelete: "restrict" })
			.notNull(),
		userId: text("user_id").references(() => users.id, {
			onDelete: "restrict",
		}),
		objectKey: text("object_key").notNull(),
		operation: text("operation").notNull(),
		oldSize: bigint("old_size", { mode: "bigint" }).notNull(),
		newSize: bigint("new_size", { mode: "bigint" }).notNull(),
		quotaReservationId: uuid("quota_reservation_id").references(
			() => dataplaneQuotaReservations.id,
			{ onDelete: "set null" },
		),
		replicationEventId: uuid("replication_event_id").references(
			() => storageReplicationEvents.eventId,
			{ onDelete: "restrict" },
		),
		state: text("state").default("prepared").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		committedAt: timestamp("committed_at", { withTimezone: true }),
		appliedAt: timestamp("applied_at", { withTimezone: true }),
		lastError: text("last_error"),
	},
	(table) => ({
		stateCreatedAtIdx: index(
			"dataplane_mutation_intents_state_created_at_idx",
		).on(table.state, table.createdAt),
		regionBucketStateIdx: index(
			"dataplane_mutation_intents_region_bucket_state_idx",
		).on(table.regionId, table.bucketId, table.state),
		replicationEventIdx: uniqueIndex(
			"dataplane_mutation_intents_replication_event_unique_idx",
		)
			.on(table.replicationEventId)
			.where(sql`${table.replicationEventId} IS NOT NULL`),
		operationCheck: check(
			"dataplane_mutation_intents_operation_check",
			sql`${table.operation} IN ('put', 'delete')`,
		),
		stateCheck: check(
			"dataplane_mutation_intents_state_check",
			sql`${table.state} IN ('prepared', 'committed', 'cancelled', 'applied')`,
		),
		sizeCheck: check(
			"dataplane_mutation_intents_size_check",
			sql`${table.oldSize} >= 0 AND ${table.newSize} >= 0`,
		),
		stateTimestampsCheck: check(
			"dataplane_mutation_intents_state_timestamps_check",
			sql`(${table.state} NOT IN ('committed', 'applied') OR ${table.committedAt} IS NOT NULL)
				AND (${table.state} <> 'applied' OR ${table.appliedAt} IS NOT NULL)`,
		),
	}),
);

export const dataplaneMultipartQuotaUploads = pgTable(
	"dataplane_multipart_quota_uploads",
	{
		uploadId: text("upload_id").primaryKey(),
		userId: text("user_id")
			.references(() => users.id, { onDelete: "cascade" })
			.notNull(),
		bucketId: uuid("bucket_id")
			.references(() => buckets.id, { onDelete: "cascade" })
			.notNull(),
		storageRegion: text("storage_region").notNull(),
		backendId: text("backend_id").notNull(),
		backendGeneration: bigint("backend_generation", {
			mode: "bigint",
		}).notNull(),
		existingCredit: bigint("existing_credit", { mode: "bigint" })
			.default(0n)
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => ({
		backendFk: foreignKey({
			columns: [table.storageRegion, table.backendId],
			foreignColumns: [
				storageRegionBackends.regionId,
				storageRegionBackends.backendId,
			],
		}),
		regionCheck: check(
			"dataplane_multipart_quota_uploads_region_check",
			sql`${table.storageRegion} ~ '^[a-z0-9][a-z0-9-]*$'`,
		),
		generationCheck: check(
			"dataplane_multipart_quota_uploads_generation_check",
			sql`${table.backendGeneration} > 0`,
		),
		creditCheck: check(
			"dataplane_multipart_quota_uploads_credit_check",
			sql`${table.existingCredit} >= 0`,
		),
		expiresAtIdx: index("dataplane_multipart_quota_uploads_expires_at_idx").on(
			table.expiresAt,
		),
	}),
);

export const dataplaneMultipartQuotaParts = pgTable(
	"dataplane_multipart_quota_parts",
	{
		uploadId: text("upload_id")
			.references(() => dataplaneMultipartQuotaUploads.uploadId, {
				onDelete: "cascade",
			})
			.notNull(),
		partNumber: integer("part_number").notNull(),
		partBytes: bigint("part_bytes", { mode: "bigint" }).default(0n).notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.uploadId, table.partNumber] }),
		partNumberCheck: check(
			"dataplane_multipart_quota_parts_part_number_check",
			sql`${table.partNumber} BETWEEN 1 AND 10000`,
		),
		partBytesCheck: check(
			"dataplane_multipart_quota_parts_bytes_check",
			sql`${table.partBytes} >= 0`,
		),
	}),
);
