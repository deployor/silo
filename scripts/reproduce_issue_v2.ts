
import { db } from "../src/db";
import { buckets } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  console.log("Attempting to query buckets with user relation...");
  try {
    // We don't need a real ID, we just want to see if the query builder crashes
    const bucket = await db.query.buckets.findFirst({
      where: eq(buckets.id, "00000000-0000-0000-0000-000000000000"),
      with: {
        user: true,
      },
    });
    console.log("Query executed successfully (result might be null/undefined which is fine):", bucket);
  } catch (error) {
    console.error("Query failed:", error);
    process.exit(1);
  }
}

main().catch(console.error);
