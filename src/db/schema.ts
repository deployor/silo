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
		isCdn: boolean("is_cdn").default(false).notNull(),
		isPaused: boolean("is_paused").default(false).notNull(),
		pauseReason: text("pause_reason"),
		corsConfig: text("cors_config"), // JSON string of CORS rules
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

export const bucketAnalyticsMinute = pgTable(
	"bucket_analytics_minute",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		bucketId: uuid("bucket_id")
			.references(() => buckets.id, { onDelete: "cascade" })
			.notNull(),
		minuteStart: timestamp("minute_start").notNull(),
		requestCount: bigint("request_count", { mode: "number" })
			.notNull()
			.default(0),
		getCount: bigint("get_count", { mode: "number" }).notNull().default(0),
		putCount: bigint("put_count", { mode: "number" }).notNull().default(0),
		deleteCount: bigint("delete_count", { mode: "number" })
			.notNull()
			.default(0),
		headCount: bigint("head_count", { mode: "number" }).notNull().default(0),
		status2xx: bigint("status_2xx", { mode: "number" }).notNull().default(0),
		status3xx: bigint("status_3xx", { mode: "number" }).notNull().default(0),
		status4xx: bigint("status_4xx", { mode: "number" }).notNull().default(0),
		status5xx: bigint("status_5xx", { mode: "number" }).notNull().default(0),
		status401: bigint("status_401", { mode: "number" }).notNull().default(0),
		status403: bigint("status_403", { mode: "number" }).notNull().default(0),
		status404: bigint("status_404", { mode: "number" }).notNull().default(0),
		status429: bigint("status_429", { mode: "number" }).notNull().default(0),
		errorCount: bigint("error_count", { mode: "number" }).notNull().default(0),
		ingressBytes: bigint("ingress_bytes", { mode: "number" })
			.notNull()
			.default(0),
		egressBytes: bigint("egress_bytes", { mode: "number" })
			.notNull()
			.default(0),
		latencyTotalMs: bigint("latency_total_ms", { mode: "number" })
			.notNull()
			.default(0),
		latencyMaxMs: bigint("latency_max_ms", { mode: "number" })
			.notNull()
			.default(0),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => {
		return {
			bucketMinuteIdx: index("bucket_analytics_minute_bucket_minute_idx").on(
				table.bucketId,
				table.minuteStart,
			),
			minuteIdx: index("bucket_analytics_minute_minute_idx").on(
				table.minuteStart,
			),
		};
	},
);

export const bucketObjectAnalytics = pgTable(
	"bucket_object_analytics",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		bucketId: uuid("bucket_id")
			.references(() => buckets.id, { onDelete: "cascade" })
			.notNull(),
		objectKey: text("object_key").notNull(),
		hitCount: bigint("hit_count", { mode: "number" }).notNull().default(0),
		errorCount: bigint("error_count", { mode: "number" }).notNull().default(0),
		ingressBytes: bigint("ingress_bytes", { mode: "number" })
			.notNull()
			.default(0),
		egressBytes: bigint("egress_bytes", { mode: "number" })
			.notNull()
			.default(0),
		lastAccessedAt: timestamp("last_accessed_at"),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => {
		return {
			bucketObjectIdx: index("bucket_object_analytics_bucket_object_idx").on(
				table.bucketId,
				table.objectKey,
			),
			hitCountIdx: index("bucket_object_analytics_bucket_hits_idx").on(
				table.bucketId,
				table.hitCount,
			),
			egressIdx: index("bucket_object_analytics_bucket_egress_idx").on(
				table.bucketId,
				table.egressBytes,
			),
		};
	},
);

export const bucketAnalyticsSnapshot = pgTable("bucket_analytics_snapshot", {
	bucketId: uuid("bucket_id")
		.references(() => buckets.id, { onDelete: "cascade" })
		.primaryKey(),
	windowStart: timestamp("window_start").notNull(),
	windowEnd: timestamp("window_end").notNull(),
	requestCount24h: bigint("request_count_24h", { mode: "number" })
		.notNull()
		.default(0),
	egressBytes24h: bigint("egress_bytes_24h", { mode: "number" })
		.notNull()
		.default(0),
	ingressBytes24h: bigint("ingress_bytes_24h", { mode: "number" })
		.notNull()
		.default(0),
	errorCount24h: bigint("error_count_24h", { mode: "number" })
		.notNull()
		.default(0),
	status42924h: bigint("status_429_24h", { mode: "number" })
		.notNull()
		.default(0),
	avgLatencyMs24h: doublePrecision("avg_latency_ms_24h").notNull().default(0),
	peakMinuteRequests24h: bigint("peak_minute_requests_24h", { mode: "number" })
		.notNull()
		.default(0),
	peakMinuteAt24h: timestamp("peak_minute_at_24h"),
	hotObjectsJson: text("hot_objects_json").notNull().default("[]"),
	statusBreakdownJson: text("status_breakdown_json").notNull().default("{}"),
	methodBreakdownJson: text("method_breakdown_json").notNull().default("{}"),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

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
	cdnForceSlackUpload: boolean("cdn_force_slack_upload")
		.default(true)
		.notNull(),
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
