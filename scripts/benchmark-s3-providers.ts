import {
	DeleteObjectCommand,
	GetObjectCommand,
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

const TEST_SIZE_MB = Number(process.env.S3_BENCH_SIZE_MB ?? "64");
const PARALLEL_OBJECTS = Number(process.env.S3_BENCH_PARALLEL_OBJECTS ?? "8");
const MULTIPART_SIZE_MB = Number(process.env.S3_BENCH_MULTIPART_SIZE_MB ?? "256");

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

function randomBody(sizeMb: number) {
	return crypto.getRandomValues(new Uint8Array(sizeMb * 1024 * 1024));
}

async function time<T>(label: string, fn: () => Promise<T>) {
	const startedAt = performance.now();
	const result = await fn();
	const elapsedMs = performance.now() - startedAt;
	return { label, result, elapsedMs };
}

async function benchmarkProvider(provider: (typeof PROVIDERS)[number]) {
	const client = createClient(provider);
	const smallObjectKey = `bench/${Date.now()}-${crypto.randomUUID()}-small.bin`;
	const largeObjectKey = `bench/${Date.now()}-${crypto.randomUUID()}-large.bin`;
	const listPrefix = "bench/";
	const smallBody = randomBody(TEST_SIZE_MB);
	const largeBody = randomBody(MULTIPART_SIZE_MB);

	console.log(`\n=== ${provider.name} ===`);
	console.log(`Endpoint: ${provider.endpoint}`);
	console.log(`Bucket: ${provider.bucket}`);

	const upload = await time("single upload", async () =>
		client.send(
			new PutObjectCommand({
				Bucket: provider.bucket,
				Key: smallObjectKey,
				Body: smallBody,
				ContentLength: smallBody.byteLength,
				ContentType: "application/octet-stream",
			}),
		),
	);
	console.log(
		`Upload ${TEST_SIZE_MB} MiB: ${formatBytesPerSecond(smallBody.byteLength / (upload.elapsedMs / 1000))}`,
	);

	const head = await time("head", async () =>
		client.send(
			new HeadObjectCommand({
				Bucket: provider.bucket,
				Key: smallObjectKey,
			}),
		),
	);
	console.log(`Head latency: ${head.elapsedMs.toFixed(0)} ms`);

	const download = await time("single download", async () => {
		const response = await client.send(
			new GetObjectCommand({
				Bucket: provider.bucket,
				Key: smallObjectKey,
			}),
		);
		return response.Body ? await response.Body.transformToByteArray() : new Uint8Array();
	});
	console.log(
		`Download ${TEST_SIZE_MB} MiB: ${formatBytesPerSecond(download.result.byteLength / (download.elapsedMs / 1000))}`,
	);

	const parallelUpload = await time("parallel upload", async () => {
		const tasks = Array.from({ length: PARALLEL_OBJECTS }, (_, index) => {
			const key = `bench/${Date.now()}-${crypto.randomUUID()}-parallel-${index}.bin`;
			const body = randomBody(8);
			return client.send(
				new PutObjectCommand({
					Bucket: provider.bucket,
					Key: key,
					Body: body,
					ContentLength: body.byteLength,
					ContentType: "application/octet-stream",
				}),
			);
		});
		await Promise.all(tasks);
	});
	console.log(
		`Parallel upload (${PARALLEL_OBJECTS} x 8 MiB): ${parallelUpload.elapsedMs.toFixed(0)} ms`,
	);

	const list = await time("list", async () =>
		client.send(
			new ListObjectsV2Command({
				Bucket: provider.bucket,
				Prefix: listPrefix,
				MaxKeys: 1000,
			}),
		),
	);
	console.log(`List latency: ${list.elapsedMs.toFixed(0)} ms`);

	const multipartUpload = await time("large upload", async () =>
		client.send(
			new PutObjectCommand({
				Bucket: provider.bucket,
				Key: largeObjectKey,
				Body: largeBody,
				ContentLength: largeBody.byteLength,
				ContentType: "application/octet-stream",
			}),
		),
	);
	console.log(
		`Large upload ${MULTIPART_SIZE_MB} MiB: ${formatBytesPerSecond(largeBody.byteLength / (multipartUpload.elapsedMs / 1000))}`,
	);

	await Promise.all([
		client.send(new DeleteObjectCommand({ Bucket: provider.bucket, Key: smallObjectKey })),
		client.send(new DeleteObjectCommand({ Bucket: provider.bucket, Key: largeObjectKey })),
	]);
}

async function main() {
	console.log(
		`Running S3 benchmark with ${TEST_SIZE_MB} MiB single-object test, ${MULTIPART_SIZE_MB} MiB large-object test, ${PARALLEL_OBJECTS} parallel objects.`,
	);
	for (const provider of PROVIDERS) {
		try {
			await benchmarkProvider(provider);
		} catch (error) {
			console.error(`\n=== ${provider.name} FAILED ===`);
			console.error(error);
		}
	}
}

void main();
