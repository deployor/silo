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
	storageLimitBytes: bigint("storage_limit_bytes", { mode: "number" }).default(
		1073741824,
	),
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
	// Admin impersonation support (best-practice):
	// - userId always remains the real session owner (admin)
	// - impersonatedUserId is the effective "current user" for dashboard actions
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
		// The owner of the bucket (for billing/quota)
		ownerId: text("owner_id").references(() => users.id, {
			onDelete: "set null",
		}),
		// The user who performed the action (might be null for public)
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
	defaultEgressLimitBytes: bigint("default_egress_limit_bytes", {
		mode: "number",
	}).notNull().default(0),
	defaultMaxBucketsPerUser: bigint("default_max_buckets_per_user", {
		mode: "number",
	}).notNull().default(50),
	defaultMaxKeysPerBucket: bigint("default_max_keys_per_bucket", {
		mode: "number",
	}).notNull().default(20),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
