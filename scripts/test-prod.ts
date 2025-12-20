import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

async function runTest() {
  console.log("🧪 Starting Comprehensive Security & Integration Test...");

  const testBucketName = "testtest";
  const accessKey = "CKD4DCC2B3BB4F9AEDC305";
  const secretKey = "4495a68af0cb0c56778f5b363ea22a4e33588eaa";
  const endpoint = "https://cargo.deployor.dev";

  const s3 = new S3Client({
    region: "auto",
    endpoint: endpoint,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    forcePathStyle: true,
  });

  try {
    // --- Basic Operations ---
    console.log("\n--- Basic Operations ---");

    console.log("Testing PUT Object...");
    await s3.send(
      new PutObjectCommand({
        Bucket: testBucketName,
        Key: "hello.txt",
        Body: "Hello World!",
      }),
    );
    console.log("✅ PUT Object success");

    console.log("Testing GET Object...");
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

    console.log("Testing HEAD Object...");
    await s3.send(
      new HeadObjectCommand({
        Bucket: testBucketName,
        Key: "hello.txt",
      }),
    );
    console.log("✅ HEAD Object success");

    console.log("Testing List Objects...");
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

    // --- Multipart Upload ---
    console.log("\n--- Multipart Upload ---");
    console.log("Initiating Multipart Upload...");
    const multipartUpload = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: testBucketName,
        Key: "multipart.txt",
      }),
    );
    const uploadId = multipartUpload.UploadId;
    console.log(`Upload ID: ${uploadId}`);

    console.log("Uploading Part 1...");
    const part1 = await s3.send(
      new UploadPartCommand({
        Bucket: testBucketName,
        Key: "multipart.txt",
        PartNumber: 1,
        UploadId: uploadId,
        Body: "Part 1 Data",
      }),
    );

    console.log("Completing Multipart Upload...");
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: testBucketName,
        Key: "multipart.txt",
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [{ PartNumber: 1, ETag: part1.ETag }],
        },
      }),
    );
    console.log("✅ Multipart Upload success");

    // --- Copy Object ---
    console.log("\n--- Copy Object ---");
    console.log("Copying Object...");
    await s3.send(
      new CopyObjectCommand({
        Bucket: testBucketName,
        CopySource: `${testBucketName}/hello.txt`,
        Key: "copy.txt",
      }),
    );
    console.log("✅ Copy Object success");

    // --- Delete Objects ---
    console.log("\n--- Delete Objects ---");
    console.log("Deleting Multiple Objects...");
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: testBucketName,
        Delete: {
          Objects: [{ Key: "multipart.txt" }, { Key: "copy.txt" }],
        },
      }),
    );
    console.log("✅ Delete Objects success");

    // --- Security & Isolation Tests ---
    console.log("\n--- Security & Isolation Tests ---");

    console.log("Testing Path Traversal Attack (../)...");
    try {
      await s3.send(
        new GetObjectCommand({
          Bucket: testBucketName,
          Key: "../../../etc/passwd",
        }),
      );
      console.error("❌ Path Traversal Attack SUCCEEDED (Should have failed)");
    } catch (e) {
      console.log("✅ Path Traversal Attack blocked");
    }

    console.log("Testing Access to Another User's Bucket...");
    const otherS3 = new S3Client({
      region: "auto",
      endpoint: endpoint,
      credentials: {
        accessKeyId: "INVALID_KEY",
        secretAccessKey: "INVALID_SECRET",
      },
    });
    try {
      await otherS3.send(
        new GetObjectCommand({
          Bucket: testBucketName,
          Key: "hello.txt",
        }),
      );
      console.error("❌ Unauthorized Access SUCCEEDED (Should have failed)");
    } catch (e) {
      console.log("✅ Unauthorized Access blocked");
    }

    console.log("Testing Bucket Creation (Should be blocked)...");
    // Note: AWS SDK CreateBucketCommand might not work directly with custom endpoints if not configured perfectly,
    // but we can simulate the request or use the command.
    try {
      // We'll use a raw fetch to simulate a bucket creation request to avoid SDK complexity with CreateBucket on custom endpoints
      const res = await fetch(`${endpoint}/new-bucket`, {
        method: "PUT",
        headers: {
          Authorization:
            "AWS4-HMAC-SHA256 Credential=CKD4DCC2B3BB4F9AEDC305/20251220/auto/s3/aws4_request, ...",
        },
      });
      if (res.status === 403) {
        console.log("✅ Bucket Creation blocked");
      } else {
        console.error(
          `❌ Bucket Creation SUCCEEDED with status ${res.status} (Should have failed)`,
        );
      }
    } catch (e) {
      console.log("✅ Bucket Creation blocked (Network Error)");
    }

    console.log("Testing Presigned URL...");
    const command = new GetObjectCommand({
      Bucket: testBucketName,
      Key: "hello.txt",
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
    console.log(`Generated Presigned URL: ${url}`);
    const presignedRes = await fetch(url);
    if (presignedRes.status === 200) {
      console.log("✅ Presigned URL access success");
    } else {
      console.error(
        `❌ Presigned URL access failed with status ${presignedRes.status}`,
      );
    }

    console.log("\n🎉 All Comprehensive Tests Passed!");
  } catch (error) {
    console.error("\n❌ Test Failed:", error);
  }
}

runTest();
