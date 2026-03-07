import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { bucketKeys, buckets, users } from "../src/db/schema";

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} env var`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const accessKey = mustEnv("TARGET_ACCESS_KEY");

  const keyRows = await db
    .select({
      bucketId: bucketKeys.bucketId,
      accessKey: bucketKeys.accessKey,
    })
    .from(bucketKeys)
    .where(eq(bucketKeys.accessKey, accessKey))
    .limit(1);

  if (keyRows.length === 0) {
    console.error("Access key not found in DB");
    process.exit(1);
  }

  const bucketId = keyRows[0].bucketId;

  const bucketRows = await db
    .select({
      id: buckets.id,
      name: buckets.name,
      userId: buckets.userId,
    })
    .from(buckets)
    .where(eq(buckets.id, bucketId))
    .limit(1);

  if (bucketRows.length === 0 || !bucketRows[0].userId) {
    console.error("Bucket or bucket owner not found");
    process.exit(1);
  }

  const userId = bucketRows[0].userId;

  await db
    .update(users)
    .set({
      isImmortal: true,
      isLocked: false,
      markedAsOverAge: false,
      filesDeleted: false,
    })
    .where(eq(users.id, userId));

  const userRows = await db
    .select({
      id: users.id,
      email: users.email,
      isImmortal: users.isImmortal,
      isLocked: users.isLocked,
      markedAsOverAge: users.markedAsOverAge,
      storageLimitBytes: users.storageLimitBytes,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  console.log("Updated user:", userRows[0]);
  console.log("From bucket:", { id: bucketRows[0].id, name: bucketRows[0].name });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
