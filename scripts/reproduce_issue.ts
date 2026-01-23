
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

// Config provided by user
const ACCESS_KEY = "SILO_PROD_DK_3604EE30D797D9217E03";
const SECRET_KEY = "f3351a07fa489e86d4b660bf704fbe4dd9076f17";
const ENDPOINT = "https://silo.deployor.dev";

const s3 = new S3Client({
  region: "auto",
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  },
  forcePathStyle: true, // often needed for custom endpoints
});

async function run() {
  const bucketName = "testmgffoprobjectlength";
  const smallKey = "small-file.txt";
  const largeKey = "large-file.bin";

  // 1. Test Small File (should be buffered in code)
  console.log("--- Testing Small File ---");
  const smallBody = "Hello World";
  try {
    console.log("Uploading small file...");
    await s3.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: smallKey,
      Body: smallBody,
      ContentType: "text/plain",
    }));
    console.log("Small file uploaded.");

    console.log("Getting small file...");
    const smallRes = await s3.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: smallKey,
    }));
    console.log("Small File Content-Length:", smallRes.ContentLength);
    
    if (smallRes.ContentLength === undefined) {
        console.error("FAIL: Content-Length missing for small file");
    } else {
        console.log("PASS: Content-Length present for small file");
    }

  } catch (e) {
    console.error("Error with small file:", e);
  }

  // 2. Test Large File (should be streamed in code)
  // Threshold in code is 10MB. Let's do 11MB.
  console.log("\n--- Testing Large File ---");
  const largeSize = 11 * 1024 * 1024;
  const largeBody = Buffer.alloc(largeSize, 'a');
  
  try {
    console.log(`Uploading large file (${largeSize} bytes)...`);
    await s3.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: largeKey,
      Body: largeBody,
      ContentType: "application/octet-stream",
    }));
    console.log("Large file uploaded.");

    console.log("Getting large file...");
    const largeRes = await s3.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: largeKey,
    }));
    console.log("Large File Content-Length:", largeRes.ContentLength);

    if (largeRes.ContentLength === undefined) {
        console.error("FAIL: Content-Length missing for large file");
    } else {
        console.log("PASS: Content-Length present for large file");
    }

  } catch (e) {
    console.error("Error with large file:", e);
  }
}

run();
