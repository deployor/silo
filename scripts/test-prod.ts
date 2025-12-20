import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { AwsClient } from "aws4fetch";

async function runTest() {
  console.log("🧪 Starting Integration Test (AWS SDK v3)...");

  const testBucketName = "testtest";
  const accessKey = "CKD4DCC2B3BB4F9AEDC305";
  const secretKey = "4495a68af0cb0c56778f5b363ea22a4e33588eaa";
  const endpoint = "https://cargo.deployor.dev";

  // DEBUG: Perform a raw request to see the actual response body
  console.log("\n🔍 Debug: Performing raw PUT request...");
  try {
    const client = new AwsClient({
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      service: "s3",
      region: "auto",
    });

    const url = `${endpoint}/${testBucketName}/hello.txt`;
    const res = await client.fetch(url, {
      method: "PUT",
      body: "Hello World!",
    });

    console.log("Raw Response Status:", res.status);
    console.log("Raw Response Headers:", Object.fromEntries(res.headers.entries()));
    const text = await res.text();
    console.log("Raw Response Body Preview:", text.slice(0, 500));
  } catch (e) {
    console.error("Raw fetch failed:", e);
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint: endpoint,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    forcePathStyle: true, // Use path-style URLs
  });

  try {
    console.log("\nTesting PUT Object...");
    await s3.send(
      new PutObjectCommand({
        Bucket: testBucketName,
        Key: "hello.txt",
        Body: "Hello World!",
      }),
    );
    console.log("✅ PUT Object success");

    console.log("\nTesting GET Object...");
    const getRes = await s3.send(
      new GetObjectCommand({
        Bucket: testBucketName,
        Key: "hello.txt",
      }),
    );
    const content = await getRes.Body?.transformToString();
    if (content !== "Hello World!") {
      throw new Error(
        `GET content mismatch. Expected 'Hello World!', got '${content}'`,
      );
    }
    console.log("✅ GET Object success");

    console.log("\nTesting List Objects...");
    const listRes = await s3.send(
      new ListObjectsV2Command({
        Bucket: testBucketName,
      }),
    );
    const found = listRes.Contents?.some((obj) => obj.Key === "hello.txt");
    if (!found) {
      throw new Error("LIST response missing hello.txt");
    }
    console.log("✅ List Objects success");

    console.log("\nTesting DELETE Object...");
    await s3.send(
      new DeleteObjectCommand({
        Bucket: testBucketName,
        Key: "hello.txt",
      }),
    );
    console.log("✅ DELETE Object success");

    console.log("\n🎉 All tests passed!");
  } catch (error) {
    console.error("\n❌ Test Failed:", error);
  }
}

runTest();
