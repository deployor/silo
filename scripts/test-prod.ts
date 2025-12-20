import { AwsClient } from "aws4fetch";

async function runTest() {
  console.log("🧪 Starting Integration Test...");

  const testBucketName = "testtest";
  const accessKey = "CKD4DCC2B3BB4F9AEDC305";
  const secretKey = "4495a68af0cb0c56778f5b363ea22a4e33588eaa";
  const endpoint = "https://cargo.deployor.dev";

  const s3 = new AwsClient({
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    service: "s3",
    region: "auto",
  });

  try {
    console.log("\nTesting PUT Object...");
    const putRes = await s3.fetch(`${endpoint}/${testBucketName}/hello.txt`, {
      method: "PUT",
      body: "Hello World!",
    });

    if (putRes.status !== 200) {
      throw new Error(
        `PUT failed with status ${putRes.status}: ${await putRes.text()}`,
      );
    }
    console.log("✅ PUT Object success");

    console.log("\nTesting GET Object...");
    const getRes = await s3.fetch(`${endpoint}/${testBucketName}/hello.txt`);

    if (getRes.status !== 200) {
      throw new Error(
        `GET failed with status ${getRes.status}: ${await getRes.text()}`,
      );
    }
    const content = await getRes.text();
    if (content !== "Hello World!") {
      throw new Error(
        `GET content mismatch. Expected 'Hello World!', got '${content}'`,
      );
    }
    console.log("✅ GET Object success");

    console.log("\nTesting List Objects...");
    const listRes = await s3.fetch(
      `${endpoint}/${testBucketName}/?list-type=2`,
    );

    if (listRes.status !== 200) {
      throw new Error(
        `LIST failed with status ${listRes.status}: ${await listRes.text()}`,
      );
    }
    const xml = await listRes.text();
    if (!xml.includes("hello.txt")) {
      throw new Error("LIST response missing hello.txt");
    }
    console.log("✅ List Objects success");

    console.log("\nTesting DELETE Object...");
    const delRes = await s3.fetch(`${endpoint}/${testBucketName}/hello.txt`, {
      method: "DELETE",
    });

    if (delRes.status !== 204 && delRes.status !== 200) {
      throw new Error(
        `DELETE failed with status ${delRes.status}: ${await delRes.text()}`,
      );
    }
    console.log("✅ DELETE Object success");

    console.log("\n🎉 All tests passed!");
  } catch (error) {
    console.error("\n❌ Test Failed:", error);
  }
}

runTest();
