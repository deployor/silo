import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

const PROVIDERS = [
	{
		name: "Impossible API",
		region: "eu-central-2",
		endpoint: "https://eu-central-2.storage.impossibleapi.net",
		accessKeyId: "99372DCDE7ED092C3864",
		secretAccessKey: "c512d92d13d76be8e1b67b22e1f64576e7b4e6bf",
		bucket: "silodevtest",
	},
	{
		name: "Hetzner FSN1",
		region: "fsn1",
		endpoint: "https://fsn1.your-objectstorage.com",
		accessKeyId: "FUSNFCBNTWL68LLKIHUW",
		secretAccessKey: "oHaL0sfNNQqKVHBPR979KeVrd19QuPYIDJO55n9t",
		bucket: "hcsilodev",
	},
	{
		name: "MEGA S4 Amsterdam",
		region: "eu-central-1",
		endpoint: "https://s3.eu-central-1.s4.mega.io",
		accessKeyId: "AKIAWEUXIXZA3HE7IXBUEDUCUS7TOKCNVWL5HKE7I2QM",
		secretAccessKey: "KfL9WvSHqjwY8LSiv5ajKPJwAtjyS9jGcMVE57tf",
		bucket: "silo",
	},
] as const;

const SMALL_SIZE_MB = Number(process.env.S3_BENCH_SMALL_MB ?? "8");
const MEDIUM_SIZE_MB = Number(process.env.S3_BENCH_MEDIUM_MB ?? "64");
const LARGE_SIZE_MB = Number(process.env.S3_BENCH_LARGE_MB ?? "256");
const PARALLEL_UPLOADS = Number(process.env.S3_BENCH_PARALLEL_UPLOADS ?? "16");
const PARALLEL_READS = Number(process.env.S3_BENCH_PARALLEL_READS ?? "16");
const LIST_TARGET = Number(process.env.S3_BENCH_LIST_TARGET ?? "10000");

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

function formatBytes(value: number) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = value;
	let unitIndex = 0;
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex += 1;
	}
	return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatThroughput(bytes: number, ms: number) {
	return `${((bytes / 1024 / 1024) / (ms / 1000)).toFixed(2)} MiB/s`;
}

function randomBody(sizeMb: number) {
	return crypto.getRandomValues(new Uint8Array(sizeMb * 1024 * 1024));
}

async function timed<T>(label: string, action: () => Promise<T>) {
	const startedAt = performance.now();
	const result = await action();
	return {
		label,
		result,
		ms: performance.now() - startedAt,
	};
}

async function ensureBucket(client: S3Client, bucket: string) {
	await client.send(new HeadBucketCommand({ Bucket: bucket }));
}

async function putObject(client: S3Client, bucket: string, key: string, body: Uint8Array) {
	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentLength: body.byteLength,
			ContentType: "application/octet-stream",
		}),
	);
}

async function getObjectBytes(client: S3Client, bucket: string, key: string) {
	const response = await client.send(
		new GetObjectCommand({
			Bucket: bucket,
			Key: key,
		}),
	);
	return response.Body ? await response.Body.transformToByteArray() : new Uint8Array();
}

async function deleteObjects(client: S3Client, bucket: string, keys: string[]) {
	await Promise.all(
		keys.map((key) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))),
	);
}

async function benchmarkProvider(provider: (typeof PROVIDERS)[number]) {
	const client = createClient(provider);
	await ensureBucket(client, provider.bucket);

	console.log(`\n=== ${provider.name} ===`);
	console.log(`Endpoint: ${provider.endpoint}`);
	console.log(`Bucket: ${provider.bucket}`);

	const smallKey = `bench/${Date.now()}-${crypto.randomUUID()}-small.bin`;
	const mediumKey = `bench/${Date.now()}-${crypto.randomUUID()}-medium.bin`;
	const largeKey = `bench/${Date.now()}-${crypto.randomUUID()}-large.bin`;
	const smallBody = randomBody(SMALL_SIZE_MB);
	const mediumBody = randomBody(MEDIUM_SIZE_MB);
	const largeBody = randomBody(LARGE_SIZE_MB);
	const cleanupKeys = [smallKey, mediumKey, largeKey];

	const smallUpload = await timed("small upload", () =>
		putObject(client, provider.bucket, smallKey, smallBody),
	);
	console.log(`Small upload (${SMALL_SIZE_MB} MiB): ${formatThroughput(smallBody.byteLength, smallUpload.ms)}`);

	const mediumUpload = await timed("medium upload", () =>
		putObject(client, provider.bucket, mediumKey, mediumBody),
	);
	console.log(`Medium upload (${MEDIUM_SIZE_MB} MiB): ${formatThroughput(mediumBody.byteLength, mediumUpload.ms)}`);

	const largeUpload = await timed("large upload", () =>
		putObject(client, provider.bucket, largeKey, largeBody),
	);
	console.log(`Large upload (${LARGE_SIZE_MB} MiB): ${formatThroughput(largeBody.byteLength, largeUpload.ms)}`);

	const head = await timed("head object", () =>
		client.send(new HeadObjectCommand({ Bucket: provider.bucket, Key: mediumKey })),
	);
	console.log(`Head object latency: ${head.ms.toFixed(0)} ms`);

	const smallDownload = await timed("small download", () =>
		getObjectBytes(client, provider.bucket, smallKey),
	);
	console.log(`Small download (${SMALL_SIZE_MB} MiB): ${formatThroughput(smallDownload.result.byteLength, smallDownload.ms)}`);

	const mediumDownload = await timed("medium download", () =>
		getObjectBytes(client, provider.bucket, mediumKey),
	);
	console.log(`Medium download (${MEDIUM_SIZE_MB} MiB): ${formatThroughput(mediumDownload.result.byteLength, mediumDownload.ms)}`);

	const parallelUpload = await timed("parallel uploads", async () => {
		const jobs = Array.from({ length: PARALLEL_UPLOADS }, (_, index) => {
			const key = `bench/${Date.now()}-${crypto.randomUUID()}-parallel-${index}.bin`;
			cleanupKeys.push(key);
			return putObject(client, provider.bucket, key, randomBody(8));
		});
		await Promise.all(jobs);
	});
	console.log(`Parallel uploads (${PARALLEL_UPLOADS} x 8 MiB): ${parallelUpload.ms.toFixed(0)} ms`);

	const parallelRead = await timed("parallel reads", async () => {
		await Promise.all(
			Array.from({ length: PARALLEL_READS }, () =>
				getObjectBytes(client, provider.bucket, mediumKey),
			),
		);
	});
	console.log(`Parallel reads (${PARALLEL_READS} x ${MEDIUM_SIZE_MB} MiB): ${parallelRead.ms.toFixed(0)} ms`);

	const listPrefix = "bench/";
	const listOnePage = await timed("list 1 page", () =>
		client.send(
			new ListObjectsV2Command({
				Bucket: provider.bucket,
				Prefix: listPrefix,
				MaxKeys: 1000,
			}),
		),
	);
	console.log(`List 1 page latency: ${listOnePage.ms.toFixed(0)} ms`);

	const listMany = await timed("list many", async () => {
		let continuationToken: string | undefined;
		let listed = 0;
		do {
			const page = await client.send(
				new ListObjectsV2Command({
					Bucket: provider.bucket,
					Prefix: listPrefix,
					MaxKeys: 1000,
					ContinuationToken: continuationToken,
				}),
			);
			listed += (page.Contents || []).length;
			continuationToken = page.NextContinuationToken;
			if (listed >= LIST_TARGET) break;
		} while (continuationToken);
		return listed;
	});
	console.log(`List up to ${LIST_TARGET.toLocaleString()} objects: ${listMany.ms.toFixed(0)} ms (listed ${listMany.result.toLocaleString()})`);

	const score =
		mediumDownload.result.byteLength / mediumDownload.ms +
		smallBody.byteLength / smallUpload.ms +
		largeBody.byteLength / largeUpload.ms +
		PARALLEL_UPLOADS / parallelUpload.ms +
		PARALLEL_READS / parallelRead.ms +
		listMany.result / Math.max(listMany.ms, 1);
	console.log(`Overall score: ${score.toFixed(2)}`);

	await deleteObjects(client, provider.bucket, cleanupKeys);
	return {
		name: provider.name,
		score,
		metrics: {
			smallUploadMs: smallUpload.ms,
			mediumUploadMs: mediumUpload.ms,
			largeUploadMs: largeUpload.ms,
			headMs: head.ms,
			smallDownloadMs: smallDownload.ms,
			mediumDownloadMs: mediumDownload.ms,
			parallelUploadMs: parallelUpload.ms,
			parallelReadMs: parallelRead.ms,
			listOnePageMs: listOnePage.ms,
			listManyMs: listMany.ms,
		},
	};
}

async function main() {
	console.log(
		`Running thorough S3 benchmark: small=${SMALL_SIZE_MB} MiB, medium=${MEDIUM_SIZE_MB} MiB, large=${LARGE_SIZE_MB} MiB, parallel uploads=${PARALLEL_UPLOADS}, parallel reads=${PARALLEL_READS}, list target=${LIST_TARGET.toLocaleString()}`,
	);
	const results = [] as Array<Awaited<ReturnType<typeof benchmarkProvider>>>;
	for (const provider of PROVIDERS) {
		try {
			results.push(await benchmarkProvider(provider));
		} catch (error) {
			console.error(`\n=== ${provider.name} FAILED ===`);
			console.error(error);
		}
	}

	console.log("\n=== Ranking ===");
	for (const [index, result] of results.sort((a, b) => b.score - a.score).entries()) {
		console.log(`${index + 1}. ${result.name} — score ${result.score.toFixed(2)}`);
	}
}

void main();
