
import { s3Client } from "../src/lib/s3-client";
import { AwsClient } from "aws4fetch";

async function run() {
    console.log("Starting Real-World Migration Verification...");

    // 1. Setup Test File
    const filename = "final-migration-test.bin";
    const size = 1024 * 1024 * 5; // 5MB
    const buffer = new Uint8Array(size).fill(88); // 'X'

    console.log(`Uploading ${filename} (${size} bytes) to Source...`);
    await s3Client.fetch(filename, {
        method: "PUT",
        body: buffer
    });

    // 2. Simulate the EXACT fixed logic from offboarding.ts
    console.log("\nSimulating Final Logic...");
    
    // A. Fetch Source Content (GET)
    const getRes = await s3Client.fetch(filename, { method: "GET" });
    if (!getRes.ok) {
        console.error("Failed to read source file");
        process.exit(1);
    }

    let headers: Record<string, string> = {};
    if (getRes.headers.get("content-type")) {
        headers["Content-Type"] = getRes.headers.get("content-type")!;
    }
    
    let body: any = getRes.body;
    let contentLength = getRes.headers.get("content-length");
    console.log(`Initial Content-Length: ${contentLength}`);

    // THE FIX:
    if (body && typeof body.getReader === 'function') {
        console.log("Stream detected. Converting to Blob...");
        body = await getRes.blob();
        contentLength = body.size.toString();
        console.log(`Blob size: ${contentLength}`);
    }

    if (contentLength) {
        headers["Content-Length"] = contentLength;
    } else {
        throw new Error("MissingContentLength: Could not resolve file size. S3 PUT requires Content-Length.");
    }

    // D. Simulate Destination PUT
    const destFilename = "final-migrated-file.bin";
    console.log(`\nPerforming PUT to destination (${destFilename})...`);
    console.log(`Headers: ${JSON.stringify(headers)}`);

    try {
        const putRes = await s3Client.fetch(destFilename, {
            method: "PUT",
            headers,
            body: body
        });

        if (putRes.ok) {
            console.log("SUCCESS: Migration PUT succeeded!");
        } else {
            console.error(`FAILURE: Migration PUT failed with status ${putRes.status}`);
            console.error(await putRes.text());
        }
    } catch (e: any) {
        console.error(`FAILURE: Network error during PUT: ${e.message}`);
    }

    // Cleanup
    console.log("\nCleaning up...");
    await s3Client.fetch(filename, { method: "DELETE" });
    await s3Client.fetch(destFilename, { method: "DELETE" });
}

run().catch(console.error);
