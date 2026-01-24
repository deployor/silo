
import { s3Client } from "../src/lib/s3-client";
import { AwsClient } from "aws4fetch";

async function run() {
    console.log("Starting Real-World Migration Simulation...");

    // 1. Setup Test File
    const filename = "migration-test-file.bin";
    const size = 1024 * 1024 * 5; // 5MB
    const buffer = new Uint8Array(size).fill(88); // 'X'

    console.log(`Uploading ${filename} (${size} bytes) to Source...`);
    await s3Client.fetch(filename, {
        method: "PUT",
        body: buffer
    });

    // 2. Simulate Migration Logic (Internal)
    console.log("\nSimulating Migration Logic...");
    
    // A. Fetch Source Metadata (ListObjects)
    const listRes = await s3Client.fetch(`?list-type=2&prefix=${filename}`, { method: "GET" });
    const xml = await listRes.text();
    const { XMLParser } = await import("fast-xml-parser");
    const parser = new XMLParser();
    const result = parser.parse(xml).ListBucketResult;
    const contents = result.Contents 
        ? (Array.isArray(result.Contents) ? result.Contents : [result.Contents]) 
        : [];
    const item = contents.find((i: any) => i.Key === filename);
    
    if (!item) {
        console.error("Source file not found!");
        process.exit(1);
    }

    // B. Fetch Source Content (GET)
    const getRes = await s3Client.fetch(filename, { method: "GET" });
    if (!getRes.ok) {
        console.error("Failed to read source file");
        process.exit(1);
    }

    // C. Resolve Content-Length
    let contentLength = getRes.headers.get("content-length");
    console.log(`Initial GET Content-Length: ${contentLength}`);

    if (!contentLength && item.Size !== undefined) {
        console.log(`Fallback: Using item.Size (${item.Size})`);
        contentLength = item.Size.toString();
    }

    if (!contentLength) {
        console.error("FAILED to resolve Content-Length!");
        process.exit(1);
    }

    // D. Simulate Destination PUT
    // We will PUT back to the SAME bucket but with a different name to simulate the destination write
    const destFilename = "migrated-file.bin";
    const headers: Record<string, string> = {};
    headers["Content-Length"] = contentLength!;
    if (getRes.headers.get("content-type")) {
        headers["Content-Type"] = getRes.headers.get("content-type")!;
    }

    console.log(`\nPerforming PUT to destination (${destFilename})...`);
    console.log(`Headers: ${JSON.stringify(headers)}`);

    try {
        console.log("Attempting PUT with .blob() conversion (guaranteed length)...");
        // FIX: Convert stream to blob to force exact content length
        const blob = await getRes.blob();
        headers["Content-Length"] = blob.size.toString();
        
        const putRes = await s3Client.fetch(destFilename, {
            method: "PUT",
            headers,
            body: blob
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
