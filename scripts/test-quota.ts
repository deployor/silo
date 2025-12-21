
import { AwsClient } from "aws4fetch";
import { db } from "../src/db";
import { buckets, users } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";

const S3_ENDPOINT = "https://cargo.deployor.dev";

async function main() {
  console.log("🧪 Starting Storage Quota Test...");

  // 1. Setup: Get a user and bucket
  const testBucketName = "testtest";
  const accessKey = "CKD4DCC2B3BB4F9AEDC305";
  const secretKey = "4495a68af0cb0c56778f5b363ea22a4e33588eaa";

  let bucket = await db.query.buckets.findFirst({
    where: eq(buckets.name, testBucketName),
  });

  if (!bucket) {
    console.error("❌ Test bucket not found in DB.");
    process.exit(1);
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, bucket.userId),
  });

  if (!user) {
    console.error("❌ User not found.");
    process.exit(1);
  }

  console.log(`User: ${user.id}`);
  console.log(`Current Usage: ${(user.storageUsageBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Limit: ${(user.storageLimitBytes / 1024 / 1024).toFixed(2)} MB`);

  const aws = new AwsClient({
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    service: "s3",
    region: "auto",
  });

  // 2. Simulate filling up to 900MB (by updating DB directly to save time/bandwidth)
  console.log("\n1. Simulating 900MB usage...");
  const usage900MB = 900 * 1024 * 1024;
  await db.update(users).set({ storageUsageBytes: usage900MB }).where(eq(users.id, user.id));
  console.log("✅ DB updated to 900MB usage.");

  // 3. Try to upload a small file (Should Succeed)
  console.log("\n2. Uploading small file (1MB) - Should SUCCEED...");
  const smallFile = new Uint8Array(1024 * 1024).fill(65); // 1MB of 'A'
  const res1 = await aws.fetch(`${S3_ENDPOINT}/${bucket.name}/small.bin`, {
    method: "PUT",
    headers: {
        "Content-Length": smallFile.length.toString()
    },
    body: smallFile,
  });

  if (res1.ok) {
    console.log("✅ Success: Small file uploaded.");
  } else {
    console.error(`❌ Failure: Small file upload failed. Status: ${res1.status}`);
    console.log(await res1.text());
  }

  // 4. Try to upload a large file that exceeds quota (300MB) - Should Fail
  // 900MB + 1MB + 300MB = 1201MB > 1024MB (1GB)
  console.log("\n3. Uploading large file (300MB) - Should FAIL (Quota Exceeded)...");
  
  // We don't want to actually send 300MB over the network for this test if we can avoid it,
  // but the server checks Content-Length header before reading body.
  // So we can send a request with Content-Length: 300MB but a small body,
  // and expect the server to reject it immediately based on header.
  
  const largeSize = 300 * 1024 * 1024;
  
  try {
      // Note: We are faking the body size here.
      // If the server reads the body before checking quota, this might hang or fail differently.
      // But our implementation checks Content-Length header first.
      const res2 = await aws.fetch(`${S3_ENDPOINT}/${bucket.name}/large.bin`, {
        method: "PUT",
        headers: {
            "Content-Length": largeSize.toString()
        },
        body: "fake-body" // This won't match content-length, but server should reject before reading
      });

      if (res2.status === 403) {
        const text = await res2.text();
        if (text.includes("QuotaExceeded")) {
            console.log("✅ Success: Upload blocked with QuotaExceeded error.");
        } else {
            console.log(`⚠️ Blocked with 403 but unexpected message: ${text}`);
        }
      } else {
        console.error(`❌ Failure: Expected 403, got ${res2.status}`);
        console.log(await res2.text());
      }
  } catch (e: any) {
      console.log("Network error (expected if connection closed early):", e.message);
  }

  // 5. Reset Usage
  // console.log("\n4. Resetting usage...");
  // await db.update(users).set({ storageUsageBytes: 0 }).where(eq(users.id, user.id));
  // console.log("✅ Usage reset.");

  process.exit(0);
}

main().catch(console.error);
