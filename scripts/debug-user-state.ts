
import { db } from "../src/db";
import { buckets, users, bucketKeys } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function inspectUser() {
    const userEmail = "tom@daamen.uk";
    
    console.log(`Inspecting user ${userEmail}...`);

    const user = await db.select().from(users).where(eq(users.email, userEmail)).limit(1);
    
    if (!user.length) {
        console.log("User not found.");
        return;
    }

    const u = user[0];
    console.log("User found:", {
        id: u.id,
        markedAsOverAge: u.markedAsOverAge,
        overAgeGracePeriodEndsAt: u.overAgeGracePeriodEndsAt,
        filesDeleted: u.filesDeleted,
        isLocked: u.isLocked
    });

    const userBuckets = await db.select().from(buckets).where(eq(buckets.userId, u.id));
    console.log(`Found ${userBuckets.length} buckets in DB.`);
    
    for (const b of userBuckets) {
        console.log(`- Bucket: ${b.name} (ID: ${b.id})`);
    }

    // List all buckets in DB just in case
    // const allBuckets = await db.select().from(buckets);
    // console.log("Total buckets in DB:", allBuckets.length);
}

inspectUser()
    .then(() => process.exit(0))
    .catch(e => {
        console.error(e);
        process.exit(1);
    });
