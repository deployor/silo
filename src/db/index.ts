import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { config } from "../config";

const connectionString = config.databaseUrl;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is missing");
}

const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client, { schema });
