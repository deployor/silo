import {
	S3Client,
	PutBucketCorsCommand,
} from "@aws-sdk/client-s3";

// Configuration
const ENDPOINT = "https://silo.deployor.dev";
const REGION = "auto";

// Bucket 1 (Public)
const BUCKET_1 = {
	name: "publicbucket",
	accessKeyId: "CK73B3D7CA74F230C3A7D7",
	secretAccessKey: "d1bf4c1318e082b756179f3f038c4016aa6ddb49",
};

const client1 = new S3Client({
	region: REGION,
	endpoint: ENDPOINT,
	credentials: {
		accessKeyId: BUCKET_1.accessKeyId,
		secretAccessKey: BUCKET_1.secretAccessKey,
	},
	forcePathStyle: true,
});

async function debugCors() {
	console.log("🚀 Debugging CORS...");

	try {
		console.log("Setting CORS...");
		await client1.send(
			new PutBucketCorsCommand({
				Bucket: BUCKET_1.name,
				CORSConfiguration: {
					CORSRules: [
						{
							AllowedHeaders: ["*"],
							AllowedMethods: ["GET"],
							AllowedOrigins: ["*"],
						},
					],
				},
			}),
		);
		console.log("✅ PutBucketCors success");

		console.log("Getting CORS (Raw Fetch)...");
        // Sign the request manually or just use the public bucket if possible, 
        // but GetBucketCors usually requires auth. 
        // Actually, let's just use the SDK to sign a request URL if possible, 
        // or just rely on the fact that I can't easily sign it here without a library.
        // Wait, I can use the `aws4fetch` library if it's available, or just use the SDK's middleware stack to see the response?
        // Easier: just use `fetch` with the credentials if I can, but AWS V4 signing is a pain.
        
        // Alternative: Use the SDK but enable logging?
        
        // Let's try to construct a signed URL or just use a simple fetch if the bucket is public? 
        // No, ?cors usually requires permission.
        
        // Let's use the `aws4fetch` library which is in package.json
        const { AwsClient } = require("aws4fetch");
        
        const aws = new AwsClient({
            accessKeyId: BUCKET_1.accessKeyId,
            secretAccessKey: BUCKET_1.secretAccessKey,
            service: "s3",
            region: REGION,
        });
        
        const res = await aws.fetch(`${ENDPOINT}/${BUCKET_1.name}/?cors`);
        const text = await res.text();
        console.log("Raw XML Response:");
        console.log(text);

	} catch (error) {
		console.error("❌ Error:", error);
	}
}

debugCors();
