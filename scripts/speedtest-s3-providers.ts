import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

const SOURCE = {
	name: "Impossible API",
	region: "eu-central-2",
	endpoint: "https://eu-central-2.storage.impossibleapi.net",
	accessKeyId: "99372DCDE7ED092C3864",
	secretAccessKey: "c512d92d13d76be8e1b67b22e1f64576e7b4e6bf",
	bucket: "silodevtest",
};

const DESTINATION = {
	name: "Hetzner FSN1 Object Storage",
	region: "fsn1",
	endpoint: "https://fsn1.your-objectstorage.com",
	accessKeyId: "FUSNFCBNTWL68LLKIHUW",
	secretAccessKey: "oHaL0sfNNQqKVHBPR979KeVrd19QuPYIDJO55n9t",
	bucket: "hcsilodev",
};

const TEST_SIZE_MB = Number(process.env.S3_SPEEDTEST_SIZE_MB ?? "64");

function createClient(config: {
	region: string;
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
}) {
	return new S3Client({
		region: config.region,
		endpoint: config.endpoint,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		},
		forcePathStyle: true,
	});
}

function formatBytesPerSecond(bytesPerSecond: number) {
	const mibPerSecond = bytesPerSecond / (1024 * 1024);
	return `${mibPerSecond.toFixed(2)} MiB/s`;
}

async function ensureBucket(client: S3Client, config: { bucket: string }) {
	await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
}

async function runUploadDownloadTest(params: {
	name: string;
	client: S3Client;
	bucket: string;
}) {
	const objectKey = `speedtest-${Date.now()}-${crypto.randomUUID()}.bin`;
	const body = crypto.getRandomValues(new Uint8Array(TEST_SIZE_MB * 1024 * 1024));

	const uploadStartedAt = performance.now();
	await params.client.send(
		new PutObjectCommand({
			Bucket: params.bucket,
			Key: objectKey,
			Body: body,
			ContentLength: body.byteLength,
			ContentType: "application/octet-stream",
		}),
	);
	const uploadSeconds = (performance.now() - uploadStartedAt) / 1000;

	const downloadStartedAt = performance.now();
	const getResponse = await params.client.send(
		new GetObjectCommand({
			Bucket: params.bucket,
			Key: objectKey,
		}),
	);
	const downloaded = getResponse.Body
		? await getResponse.Body.transformToByteArray()
		: new Uint8Array();
	const downloadSeconds = (performance.now() - downloadStartedAt) / 1000;

	await params.client.send(
		new DeleteObjectCommand({
			Bucket: params.bucket,
			Key: objectKey,
		}),
	);

	console.log(`\n${params.name}`);
	console.log(`  Upload:   ${formatBytesPerSecond(body.byteLength / uploadSeconds)}`);
	console.log(`  Download: ${formatBytesPerSecond(downloaded.byteLength / downloadSeconds)}`);
}

async function main() {
	const sourceClient = createClient(SOURCE);
	const destinationClient = createClient(DESTINATION);

	await ensureBucket(sourceClient, SOURCE);
	await ensureBucket(destinationClient, DESTINATION);

	console.log(`Running ${TEST_SIZE_MB} MiB upload/download speed tests...`);
	await runUploadDownloadTest({
		name: SOURCE.name,
		client: sourceClient,
		bucket: SOURCE.bucket,
	});
	await runUploadDownloadTest({
		name: DESTINATION.name,
		client: destinationClient,
		bucket: DESTINATION.bucket,
	});
}

void main();
