import {
	CreateBucketCommand,
	GetObjectCommand,
	HeadBucketCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

const SOURCE = {
	region: "eu-central-2",
	endpoint: "https://eu-central-2.storage.impossibleapi.net",
	accessKeyId: "99372DCDE7ED092C3864",
	secretAccessKey: "c512d92d13d76be8e1b67b22e1f64576e7b4e6bf",
	bucket: "silodevtest",
};

const DESTINATION = {
	region: "fsn1",
	endpoint: "https://fsn1.your-objectstorage.com",
	accessKeyId: "FUSNFCBNTWL68LLKIHUW",
	secretAccessKey: "oHaL0sfNNQqKVHBPR979KeVrd19QuPYIDJO55n9t",
	bucket: "hcsilodev",
};

const PAGE_SIZE = 1000;
const COPY_CONCURRENCY = Number(process.env.MIGRATION_CONCURRENCY ?? "64");
const PROGRESS_LOG_EVERY_MS = 5000;

function formatBytes(bytes: number) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

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

async function ensureBucketExists(client: S3Client, bucket: string) {
	await client.send(new HeadBucketCommand({ Bucket: bucket }));
	console.log(`Destination bucket ${bucket} already exists`);
}

async function listAllObjects(client: S3Client, bucket: string) {
	const keys: Array<{ key: string; size: number }> = [];
	let continuationToken: string | undefined;

	do {
		const response = await client.send(
			new ListObjectsV2Command({
				Bucket: bucket,
				ContinuationToken: continuationToken,
				MaxKeys: PAGE_SIZE,
			}),
		);

		for (const object of response.Contents || []) {
			if (!object.Key) continue;
			keys.push({ key: object.Key, size: Number(object.Size || 0) });
		}

		continuationToken = response.NextContinuationToken;
	} while (continuationToken);

	return keys;
}

async function copyObject(
	sourceClient: S3Client,
	destinationClient: S3Client,
	objectKey: string,
) {
	const sourceObject = await sourceClient.send(
		new GetObjectCommand({
			Bucket: SOURCE.bucket,
			Key: objectKey,
		}),
	);

	const contentLength = Number(sourceObject.ContentLength || 0);
	const uploadBody =
		sourceObject.Body && contentLength > 0
			? sourceObject.Body
			: sourceObject.Body
				? await sourceObject.Body.transformToByteArray()
				: new Uint8Array();

	await destinationClient.send(
		new PutObjectCommand({
			Bucket: DESTINATION.bucket,
			Key: objectKey,
			Body: uploadBody,
			ContentLength:
				uploadBody instanceof Uint8Array ? uploadBody.byteLength : contentLength,
			ContentType: sourceObject.ContentType,
			ContentDisposition: sourceObject.ContentDisposition,
			ContentEncoding: sourceObject.ContentEncoding,
			ContentLanguage: sourceObject.ContentLanguage,
			CacheControl: sourceObject.CacheControl,
			Metadata: sourceObject.Metadata,
		}),
	);
}

async function main() {
	const sourceClient = createClient(SOURCE);
	const destinationClient = createClient(DESTINATION);

	await ensureBucketExists(destinationClient, DESTINATION.bucket);
	const objects = await listAllObjects(sourceClient, SOURCE.bucket);

	const totalBytes = objects.reduce((sum, object) => sum + object.size, 0);
	console.log(
		`Found ${objects.length.toLocaleString()} objects (${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB)`,
	);

	let completed = 0;
	let failed = 0;
	let copiedBytes = 0;
	const startedAt = Date.now();
	const queue = [...objects];

	const progressTimer = setInterval(() => {
		const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
		const bytesPerSecond = copiedBytes / elapsedSeconds;
		const remainingBytes = Math.max(0, totalBytes - copiedBytes);
		const etaSeconds =
			bytesPerSecond > 0 ? Math.round(remainingBytes / bytesPerSecond) : null;
		console.log(
			`Progress: ${completed}/${objects.length} objects, ${formatBytes(copiedBytes)}/${formatBytes(totalBytes)} copied, ${formatBytes(bytesPerSecond)}/s${etaSeconds !== null ? `, ETA ${Math.ceil(etaSeconds / 60)}m` : ""}`,
		);
	}, PROGRESS_LOG_EVERY_MS);

	const workers = Array.from({ length: COPY_CONCURRENCY }, async () => {
		while (queue.length > 0) {
			const object = queue.shift();
			if (!object) return;
			try {
				await copyObject(sourceClient, destinationClient, object.key);
				completed += 1;
				copiedBytes += object.size;
				if (completed % 100 === 0 || completed === objects.length) {
					console.log(
						`Copied ${completed}/${objects.length} objects (${(copiedBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB)`,
					);
				}
			} catch (error) {
				failed += 1;
				console.error(`Failed to copy ${object.key}:`, error);
			}
		}
	});

	await Promise.all(workers);
	clearInterval(progressTimer);

	console.log(
		`Final: ${completed}/${objects.length} objects, ${formatBytes(copiedBytes)}/${formatBytes(totalBytes)} copied`,
	);
	console.log(`Done. Copied: ${completed}, Failed: ${failed}`);
	if (failed > 0) {
		process.exitCode = 1;
	}
}

void main();
