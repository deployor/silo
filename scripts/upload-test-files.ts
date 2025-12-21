import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const client = new S3Client({
  region: "auto",
  endpoint: "https://cargo.deployor.dev",
  credentials: {
    accessKeyId: "CK34738ADC4E2AC8F72239",
    secretAccessKey: "756e5f82796d112fd76dfa788f0ad899a07e1c96",
  },
  forcePathStyle: true,
});

const bucket = "ee";

async function upload(key: string, body: string, contentType: string) {
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
    console.log(`Uploaded ${key}`);
  } catch (e) {
    console.error(`Failed to upload ${key}:`, e);
  }
}

async function main() {
  console.log("Uploading test files...");
  await upload("hello.txt", "Hello World! This is a test file.", "text/plain");
  await upload("folder/config.json", JSON.stringify({ app: "cargo", version: 1 }), "application/json");
  await upload("project/readme.md", "# Project Documentation\n\nThis is a test project.", "text/markdown");
  await upload("image.png", "fake-image-content-placeholder", "image/png");
  console.log("Done!");
}

main();
