
import { s3Client } from "../src/lib/s3-client";
import { XMLParser } from "fast-xml-parser";

async function debugS3Contents() {
    console.log("Listing objects in S3 root...");
    
    // List everything under "users/"
    const query = new URLSearchParams();
    query.set("list-type", "2");
    query.set("prefix", "users/");
    query.set("max-keys", "10000"); // Just peek at the top
    
    const res = await s3Client.fetch(`?${query.toString()}`, { method: "GET" });
    const xml = await res.text();
    
    const parser = new XMLParser({
        isArray: (name) => name === "Contents"
    });
    const result = parser.parse(xml).ListBucketResult;
    
    console.log("CommonPrefixes:", result.CommonPrefixes);
    
    if (result.Contents) {
        console.log("\nSample Objects:");
        result.Contents.forEach((c: any) => console.log(`- ${c.Key}`));
    } else {
        console.log("No objects found under users/");
    }
}

debugS3Contents()
    .then(() => process.exit(0))
    .catch(e => {
        console.error(e);
        process.exit(1);
    });
