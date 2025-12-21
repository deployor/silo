
import { AwsClient } from "aws4fetch";
import { db } from "../src/db";
import { buckets, users } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";

const S3_ENDPOINT = "https://cargo.deployor.dev";

async function main() {
  console.log("🧪 Starting Storage Quota Test...");

  // 1. Setup: Get a user and bucket
  const testBucketName = "testtest";
  // These keys must match what's in your DB for the user who owns 'testtest'
  // If you are running this locally, ensure these credentials are valid for your local DB
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
  console.log(`Current Usage: ${(Number(user.storageUsageBytes) / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Limit: ${(Number(user.storageLimitBytes) / 1024 / 1024).toFixed(2)} MB`);

  const aws = new AwsClient({
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    service: "s3",
    region: "auto",
  });

  // --- Test 1: Standard Quota Enforcement ---
  console.log("\n--- Test 1: Standard Quota Enforcement ---");
  
  // Set usage to 900MB (Limit is 1GB = 1024MB)
  const usage900MB = 900 * 1024 * 1024;
  await db.update(users).set({ storageUsageBytes: usage900MB }).where(eq(users.id, user.id));
  console.log("✅ DB updated to 900MB usage.");

  // Upload 1MB file (Should Succeed)
  console.log("1.1 Uploading small file (1MB) - Should SUCCEED...");
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

  // Upload 300MB file (Should Fail)
  console.log("1.2 Uploading large file (300MB) - Should FAIL (Quota Exceeded)...");
  const largeSize = 300 * 1024 * 1024;
  try {
      const res2 = await aws.fetch(`${S3_ENDPOINT}/${bucket.name}/large.bin`, {
        method: "PUT",
        headers: {
            "Content-Length": largeSize.toString()
        },
        body: "fake-body" // Server checks header first
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

  // --- Test 2: Multipart Upload Quota ---
  console.log("\n--- Test 2: Multipart Upload Quota ---");
  
  // Reset usage to Limit - 5MB
  const limit = Number(user.storageLimitBytes);
  const usageNearLimit = limit - (5 * 1024 * 1024);
  await db.update(users).set({ storageUsageBytes: usageNearLimit }).where(eq(users.id, user.id));
  console.log(`✅ DB updated to ${(usageNearLimit / 1024 / 1024).toFixed(2)} MB (5MB remaining).`);

  // Initiate Multipart Upload
  console.log("2.1 Initiating Multipart Upload...");
  const initRes = await aws.fetch(`${S3_ENDPOINT}/${bucket.name}/multipart.bin?uploads`, {
      method: "POST"
  });
  
  if (!initRes.ok) {
      console.error("❌ Failed to initiate multipart upload");
      console.log(await initRes.text());
      process.exit(1);
  }
  
  const initXml = await initRes.text();
  const uploadIdMatch = initXml.match(/<UploadId>(.*?)<\/UploadId>/);
  const uploadId = uploadIdMatch ? uploadIdMatch[1] : null;
  
  if (!uploadId) {
      console.error("❌ Could not parse UploadId");
      process.exit(1);
  }
  console.log(`✅ UploadId: ${uploadId}`);

  // Upload Part 1 (3MB) - Should Succeed (Remaining: 5MB -> 2MB)
  console.log("2.2 Uploading Part 1 (3MB) - Should SUCCEED...");
  const part1 = new Uint8Array(3 * 1024 * 1024).fill(66); // 3MB
  const part1Res = await aws.fetch(`${S3_ENDPOINT}/${bucket.name}/multipart.bin?partNumber=1&uploadId=${uploadId}`, {
      method: "PUT",
      headers: { "Content-Length": part1.length.toString() },
      body: part1
  });

  if (part1Res.ok) {
      console.log("✅ Part 1 uploaded.");
  } else {
      console.error(`❌ Part 1 failed: ${part1Res.status}`);
      console.log(await part1Res.text());
  }

  // Upload Part 2 (3MB) - Should Fail (Remaining: 2MB < 3MB)
  console.log("2.3 Uploading Part 2 (3MB) - Should FAIL (Quota Exceeded)...");
  const part2 = new Uint8Array(3 * 1024 * 1024).fill(67); // 3MB
  const part2Res = await aws.fetch(`${S3_ENDPOINT}/${bucket.name}/multipart.bin?partNumber=2&uploadId=${uploadId}`, {
      method: "PUT",
      headers: { "Content-Length": part2.length.toString() },
      body: part2
  });

  if (part2Res.status === 403) {
      console.log("✅ Part 2 blocked with 403.");
  } else {
      console.error(`❌ Part 2 unexpected status: ${part2Res.status}`);
      console.log(await part2Res.text());
  }

  // Abort multipart (cleanup)
  console.log("2.4 Aborting Multipart Upload...");
  await aws.fetch(`${S3_ENDPOINT}/${bucket.name}/multipart.bin?uploadId=${uploadId}`, {
      method: "DELETE"
  });


  // --- Test 3: Content-Length Spoofing (Lying) ---
  console.log("\n--- Test 3: Content-Length Spoofing ---");
  
  // Reset usage to 0
  await db.update(users).set({ storageUsageBytes: 0 }).where(eq(users.id, user.id));
  console.log("✅ Usage reset to 0.");

  // Attempt to upload 1MB body with Content-Length: 100
  console.log("3.1 Uploading 1MB body with Content-Length: 100...");
  
  // We need to manually construct this request to ensure aws4fetch doesn't correct the header
  // Actually, aws4fetch calculates signature based on headers. If we sign with CL=100, we must send CL=100.
  // If we send a body larger than CL, the server (or upstream) should truncate or error.
  
  const spoofBody = new Uint8Array(1024 * 1024).fill(68); // 1MB
  
  // We use a custom fetch call here to ensure we control the body and headers exactly
  // But we need a valid signature. 
  // We can use aws.sign to get headers, then use global fetch.
  
  const spoofUrl = `${S3_ENDPOINT}/${bucket.name}/spoof.bin`;
  const signed = await aws.sign(spoofUrl, {
      method: "PUT",
      headers: { "Content-Length": "100" },
      // We sign as if the body is empty or we don't provide it to sign?
      // AWS SigV4 includes payload hash. 
      // If we sign with "UNSIGNED-PAYLOAD" (which our server defaults to if not provided), it's easier.
      // Our server sets x-amz-content-sha256 to UNSIGNED-PAYLOAD if missing.
      // So let's try to sign with that.
  });
  
  // Extract headers from signed request
  const headers = new Headers(signed.headers);
  headers.set("Content-Length", "100"); // Ensure it's 100
  
  // Now perform the actual fetch with the large body
  const spoofRes = await fetch(spoofUrl, {
      method: "PUT",
      headers: headers,
      body: spoofBody
  });

  console.log(`Response Status: ${spoofRes.status}`);
  
  // Check usage
  const userAfterSpoof = await db.query.users.findFirst({
      where: eq(users.id, user.id)
  });
  
  const usage = Number(userAfterSpoof?.storageUsageBytes || 0);
  console.log(`Usage after spoof: ${usage} bytes`);
  
  if (usage === 100) {
      console.log("✅ Usage increased by Content-Length (100), not body size. This implies truncation or correct handling.");
  } else if (usage > 100) {
      console.error("❌ Usage increased by more than Content-Length! The server read the full body despite the header.");
  } else {
      console.log("ℹ️ Usage did not increase (upload failed or 0 bytes stored).");
  }

  process.exit(0);
}

main().catch(console.error);
