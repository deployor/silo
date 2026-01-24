
import { s3Client } from "../src/lib/s3-client";
import { config } from "../src/config";

async function testBlobUpload() {
  console.log("Starting Blob upload test...");

  // 1. Create a dummy large file (10MB)
  const size = 10 * 1024 * 1024;
  const buffer = new Uint8Array(size);
  buffer.fill(66); // 'B'
  
  // Create a Blob from the buffer
  const blob = new Blob([buffer], { type: "text/plain" });

  const endpoint = config.s3.endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const key = "debug-blob-test.txt";
  const url = `https://${config.s3.bucket}.${endpoint}/${key}`;
  
  console.log(`Target URL: ${url}`);
  console.log(`Blob size: ${blob.size} bytes`);

  // 2. Sign the request
  const signedRequest = await s3Client.sign(url, {
    method: "PUT",
    headers: {
      "Content-Length": blob.size.toString(),
      "Content-Type": "text/plain",
    }
  });

  console.log("Signed headers:", Object.fromEntries(signedRequest.headers.entries()));

  // 3. Execute using Blob body
  try {
    console.log("Uploading Blob...");
    const response = await fetch(url, {
      method: "PUT",
      headers: signedRequest.headers,
      body: blob,
      // @ts-ignore
      duplex: 'half' 
    });

    console.log(`Response status: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.log(`Response body: ${text}`);

    if (response.ok) {
      console.log("✅ Blob upload SUCCEEDED!");
    } else {
      console.error("❌ Blob upload FAILED.");
    }

  } catch (error) {
    console.error("❌ Request threw an error:", error);
  }
}

testBlobUpload();
