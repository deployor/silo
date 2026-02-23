import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config";
import * as schema from "./schema";

const connectionString = config.databaseUrl;

if (!connectionString) {
	throw new Error("DATABASE_URL environment variable is missing");
}

const client = postgres(connectionString, {
	prepare: false,
	max: Number(process.env.DB_POOL_MAX ?? "20"),
	idle_timeout: Number(process.env.DB_IDLE_TIMEOUT ?? "30"),
	connect_timeout: 10,
	max_lifetime: 60 * 30, // recycle connections every 30 min
});
export const db = drizzle(client, { schema });
