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
    accessKey: text("access_key").notNull().unique(),
    secretKey: text("secret_key").notNull(),
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
      accessKeyIdx: index("access_key_idx").on(table.accessKey),
      userIdIdx: index("user_id_idx").on(table.userId),
    };
  },
);
