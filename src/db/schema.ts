import {
	bigint,
	boolean,
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
		userId: text("user_id")
			.references(() => users.id)
			.notNull(),
		region: text("region").default("auto"),
		isPublic: boolean("is_public").default(false).notNull(),
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

// Global settings (single-row table)
export const appSettings = pgTable("app_settings", {
	id: text("id").primaryKey().default("global"),
	defaultStorageLimitBytes: bigint("default_storage_limit_bytes", {
		mode: "number",
	}).notNull().default(1073741824),
	// Egress default is formula-based: max(minEgressBytes, storageBytes * egressMultiplier)
	egressMultiplier: bigint("egress_multiplier", { mode: "number" })
		.notNull()
		.default(3),
	minEgressBytes: bigint("min_egress_bytes", { mode: "number" })
		.notNull()
		.default(10737418240),
	defaultMaxBucketsPerUser: bigint("default_max_buckets_per_user", {
		mode: "number",
	}).notNull().default(50),
	defaultMaxKeysPerBucket: bigint("default_max_keys_per_bucket", {
		mode: "number",
	}).notNull().default(20),
	yswsQuotaPerHourBytes: bigint("ysws_quota_per_hour_bytes", {
		mode: "number",
	})
		.notNull()
		.default(1073741824), // 1GB
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
		hackatimeProject: text("hackatime_project"),
		hoursSpent: bigint("hours_spent", { mode: "number" }).notNull(),
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
	},
	(table) => {
		return {
			userIdIdx: index("ysws_user_id_idx").on(table.userId),
			statusIdx: index("ysws_status_idx").on(table.status),
		};
	},
);
