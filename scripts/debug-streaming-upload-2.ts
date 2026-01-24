
import { s3Client } from "../src/lib/s3-client";
import { config } from "../src/config";

async function testStreamingUpload() {
  console.log("Starting streaming upload test (Attempt 2: Fixed Length Stream)...");

  // 1. Create a dummy large file (10MB) as a stream
  const size = 10 * 1024 * 1024;
  const buffer = new Uint8Array(size);
  buffer.fill(65); // 'A'
  
  // Create a ReadableStream from the buffer
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    }
  });

  const endpoint = config.s3.endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const key = "debug-streaming-test-fixed.txt";
  const url = `https://${config.s3.bucket}.${endpoint}/${key}`;
  
  console.log(`Target URL: ${url}`);
  console.log(`File size: ${size} bytes`);

  // 2. Sign the request using aws4fetch
  const signedRequest = await s3Client.sign(url, {
    method: "PUT",
    headers: {
      "Content-Length": size.toString(),
      "Content-Type": "text/plain",
      // Try to hint to Bun/fetch not to use chunked? No standard way.
    }
  });

  console.log("Signed headers:", Object.fromEntries(signedRequest.headers.entries()));

  // 3. Execute the request using Bun's native fetch with potential workarounds
  try {
    // WORKAROUND ATTEMPT: 
    // Is there a way to pass a Request object directly that has the body set?
    // Or maybe using a Blob is the ONLY way for Bun?
    
    // Let's try passing the buffer directly first to confirm it works without stream
    // console.log("Attempt 2a: Uploading Buffer (Control Test)");
    // const resBuffer = await fetch(url, {
    //   method: "PUT",
    //   headers: signedRequest.headers,
    //   body: buffer
    // });
    // console.log(`Buffer Upload Status: ${resBuffer.status}`);
    
    console.log("Attempt 2b: Uploading Stream with explicit Content-Length");
    const response = await fetch(url, {
      method: "PUT",
      headers: signedRequest.headers, // Use the signed headers
      body: stream, 
      // @ts-ignore
      duplex: 'half' 
    });

    console.log(`Response status: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.log(`Response body: ${text}`);

    if (response.ok) {
      console.log("✅ Streaming upload SUCCEEDED!");
    } else {
      console.error("❌ Streaming upload FAILED.");
    }

  } catch (error) {
    console.error("❌ Request threw an error:", error);
  }
}

testStreamingUpload();
