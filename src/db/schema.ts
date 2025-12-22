import {
  pgTable,
  text,
  timestamp,
  bigint,
  uuid,
  index,
  boolean,
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
  ingressBytes: bigint("ingress_bytes", { mode: "number" })
    .notNull()
    .default(0),
  egressBytes: bigint("egress_bytes", { mode: "number" }).notNull().default(0),
  totalRequests: bigint("total_requests", { mode: "number" })
    .notNull()
    .default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
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
    // The owner of the bucket (for billing/quota)
    ownerId: text("owner_id").references(() => users.id),
    // The user who performed the action (might be null for public)
    requesterId: text("requester_id").references(() => users.id),
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
