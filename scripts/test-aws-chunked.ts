import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "fs";

const config = {
	region: "auto",
	endpoint: "https://silo.deployor.dev",
	forcePathStyle: true,
	credentials: {
		accessKeyId: "SILO_PROD_DK_C4389670583ADEC61E8A",
		secretAccessKey: "00221037292959993d28174adcccb934d3d8f6ca",
	},
	bucket: "testbucketforscriptindev",
};

const client = new S3Client(config);

async function runTest() {
	console.log("🚀 Starting AWS Chunked Upload Test...");

	// Create a dummy file large enough to trigger chunked upload usually (or force it)
	// AWS SDK usually uses aws-chunked if we pass a stream and the size is known?
	// Or we can manually construct a request if needed, but let's try standard SDK first.
	// Actually, SDK v3 defaults to chunked for streams in Node.js.

	const filename = "chunked-test.txt";
	const content = "A".repeat(1024 * 1024 * 5); // 5MB
	fs.writeFileSync(filename, content);
	const fileStream = fs.createReadStream(filename);

	try {
		console.log(`   Uploading ${filename} (5MB)...`);
		await client.send(
			new PutObjectCommand({
				Bucket: config.bucket,
				Key: "chunked-upload-test.txt",
				Body: fileStream,
				// ContentLength: content.length, // Providing this might disable chunked encoding in some cases?
				// Let's rely on SDK behavior. If it knows the size (fs stream), it might use Content-Length.
				// But we want to FORCE aws-chunked or simulate it.
			}),
		);
		console.log("   ✅ Upload successful");
	} catch (e) {
		console.error("   ❌ Upload failed:", e);
	} finally {
		fs.unlinkSync(filename);
	}
}

runTest();
