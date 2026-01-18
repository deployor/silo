import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	ListObjectsV2Command,
	HeadObjectCommand,
} from "@aws-sdk/client-s3";

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
	console.log("🚀 Starting intense S3 key validation test...");
	console.log(`Target: ${config.endpoint}/${config.bucket}`);
	console.log(`Key: ${config.credentials.accessKeyId}`);

	const testFiles = [
		{ key: "hello.txt", body: "Hello World!", type: "text/plain" },
		{
			key: "folder/nested.json",
			body: JSON.stringify({ status: "ok" }),
			type: "application/json",
		},
		{
			key: "special chars @#$.txt",
			body: "Special characters test",
			type: "text/plain",
		},
	];

	try {
		// 1. PUT Objects
		console.log("\n1. Testing PUT operations...");
		for (const file of testFiles) {
			console.log(`   Uploading ${file.key}...`);
			await client.send(
				new PutObjectCommand({
					Bucket: config.bucket,
					Key: file.key,
					Body: file.body,
					ContentType: file.type,
					Metadata: { "x-test-meta": "silo-verification" },
					ContentLength: file.body.length,
				}),
			);
			console.log(`   ✅ Uploaded ${file.key}`);
		}

		// 2. LIST Objects
		console.log("\n2. Testing LIST operations...");
		const listRes = await client.send(
			new ListObjectsV2Command({ Bucket: config.bucket }),
		);
		const listedKeys = listRes.Contents?.map((c) => c.Key) || [];
		console.log(`   Found ${listedKeys.length} objects:`, listedKeys);

		const allFound = testFiles.every((f) => listedKeys.includes(f.key));
		if (allFound) console.log("   ✅ All uploaded keys found in listing");
		else console.error("   ❌ Missing keys in listing!");

		// 3. HEAD & GET Objects
		console.log("\n3. Testing HEAD and GET operations...");
		for (const file of testFiles) {
			console.log(`   Verifying ${file.key}...`);
			const head = await client.send(
				new HeadObjectCommand({ Bucket: config.bucket, Key: file.key }),
			);
			
            if (head.Metadata?.["x-test-meta"] === "silo-verification") {
                 console.log(`   ✅ Metadata verified for ${file.key}`);
            } else {
                 console.log(`   ⚠️ Metadata missing/mismatch for ${file.key}`);
            }

			const get = await client.send(
				new GetObjectCommand({ Bucket: config.bucket, Key: file.key }),
			);
			const body = await get.Body?.transformToString();
			if (body === file.body) {
				console.log(`   ✅ Content verified for ${file.key}`);
			} else {
				console.error(`   ❌ Content Mismatch for ${file.key}`);
			}
		}

		// 4. DELETE Objects
		console.log("\n4. Testing DELETE operations...");
		for (const file of testFiles) {
			console.log(`   Deleting ${file.key}...`);
			await client.send(
				new DeleteObjectCommand({ Bucket: config.bucket, Key: file.key }),
			);
			console.log(`   ✅ Deleted ${file.key}`);
		}

		// 5. Verify Deletion
		console.log("\n5. Verifying cleanup...");
		const listResAfter = await client.send(
			new ListObjectsV2Command({ Bucket: config.bucket }),
		);
		if (!listResAfter.Contents || listResAfter.Contents.length === 0) {
			console.log("   ✅ Bucket is empty");
		} else {
			console.log(
				"   ⚠️ Bucket not empty:",
				listResAfter.Contents.map((c) => c.Key),
			);
		}

		console.log("\n✅✅✅ INTENSE TEST COMPLETED SUCCESSFULLY ✅✅✅");
	} catch (error) {
		console.error("\n❌❌❌ TEST FAILED ❌❌❌");
		console.error(error);
	}
}

runTest();
