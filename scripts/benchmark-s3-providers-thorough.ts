import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

type ProviderConfig = {
  name: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

type TrialError = {
  name?: string;
  message: string;
  statusCode?: number;
};

type TrialResult = {
  bytes?: number;
  throughputMiBs?: number;
  statusCode?: number;
  details?: Record<string, unknown>;
};

type TrialRecord = {
  operation: string;
  startedAtUtc: string;
  endedAtUtc: string;
  ms: number;
  ok: boolean;
  bytes?: number;
  throughputMiBs?: number;
  statusCode?: number;
  details?: Record<string, unknown>;
  error?: TrialError;
};

type ProbeRecord = {
  name: string;
  ok: boolean;
  ms: number;
  details?: Record<string, unknown>;
  error?: TrialError;
};

type AggregateStats = {
  count: number;
  okCount: number;
  failCount: number;
  successRate: number;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  stdevMs: number | null;
  cv: number | null;
  totalBytes: number;
  meanThroughputMiBs: number | null;
  medianThroughputMiBs: number | null;
};

type CategoryScores = {
  capability: number;
  latency: number;
  throughput: number;
  consistency: number;
  scalability: number;
  integrity: number;
  overall: number;
};

type ProviderRun = {
  provider: Omit<ProviderConfig, "accessKeyId" | "secretAccessKey">;
  runId: string;
  startedAtUtc: string;
  completedAtUtc?: string;
  config: Record<string, unknown>;
  probes: ProbeRecord[];
  trials: Record<string, TrialRecord[]>;
  aggregates?: Record<string, AggregateStats>;
  derived?: Record<string, number | boolean | string | null>;
  scores?: CategoryScores;
  notes: string[];
};

type ProviderSummary = {
  name: string;
  providerKey: string;
  aggregates: Record<string, AggregateStats>;
  derived: Record<string, number | boolean | string | null>;
  scores?: CategoryScores;
};

type ScoreDirection = "higher" | "lower";

const PROVIDERS: ProviderConfig[] = [
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
];

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_DIR = process.env.S3_BENCH_OUTPUT_DIR ?? "./s3-bench-results";

const REPEATS = numberEnv("S3_BENCH_REPEATS", 5);
const HEAVY_REPEATS = numberEnv("S3_BENCH_HEAVY_REPEATS", 2);

const SMALL_SIZE_MB = numberEnv("S3_BENCH_SMALL_MB", 8);
const MEDIUM_SIZE_MB = numberEnv("S3_BENCH_MEDIUM_MB", 64);
const LARGE_SIZE_MB = numberEnv("S3_BENCH_LARGE_MB", 256);

const PARALLEL_UPLOADS = numberEnv("S3_BENCH_PARALLEL_UPLOADS", 16);
const PARALLEL_READS = numberEnv("S3_BENCH_PARALLEL_READS", 16);
const PARALLEL_DELETES = numberEnv("S3_BENCH_PARALLEL_DELETES", 32);

const MANY_OBJECTS_COUNT = numberEnv("S3_BENCH_MANY_OBJECTS_COUNT", 10000);
const MANY_OBJECTS_SIZE_BYTES = numberEnv("S3_BENCH_MANY_OBJECTS_SIZE_BYTES", 1024);
const LIST_TARGET = numberEnv("S3_BENCH_LIST_TARGET", 10000);

const CONSISTENCY_POLL_MS = numberEnv("S3_BENCH_CONSISTENCY_POLL_MS", 50);
const CONSISTENCY_TIMEOUT_MS = numberEnv("S3_BENCH_CONSISTENCY_TIMEOUT_MS", 15000);
const MULTIPART_PART_SIZE_MB = numberEnv("S3_BENCH_MULTIPART_PART_SIZE_MB", 8);
const MULTIPART_PARTS = numberEnv("S3_BENCH_MULTIPART_PARTS", 4);
const MISSING_KEY_REPEATS = numberEnv("S3_BENCH_MISSING_KEY_REPEATS", 3);
const KEEP_TEST_DATA = booleanEnv("S3_BENCH_KEEP_TEST_DATA", false);

function numberEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value);
}

function safeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function bytesFromMb(sizeMb: number) {
  return Math.round(sizeMb * 1024 * 1024);
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

function formatMs(value: number | null | undefined) {
  if (value == null) return "n/a";
  return `${value.toFixed(value >= 100 ? 0 : 1)} ms`;
}

function formatMiBs(value: number | null | undefined) {
  if (value == null) return "n/a";
  return `${value.toFixed(2)} MiB/s`;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown) {
  return numberOrNull(value) ?? 0;
}

function weightedAverage(items: Array<{ value: number; weight: number }>) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (!totalWeight) return 0;
  return items.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
}

function createClient(config: ProviderConfig) {
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

function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function randomBodyBytes(byteLength: number) {
  return randomBytes(byteLength);
}

function mean(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function stdev(values: number[]) {
  if (values.length < 2) return null;
  const avg = mean(values)!;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function summarizeTrials(trials: TrialRecord[]): AggregateStats {
  const okTrials = trials.filter((trial) => trial.ok);
  const times = okTrials.map((trial) => trial.ms);
  const throughputs = okTrials
    .map((trial) => trial.throughputMiBs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const meanMs = mean(times);
  const stdevMs = stdev(times);

  return {
    count: trials.length,
    okCount: okTrials.length,
    failCount: trials.length - okTrials.length,
    successRate: trials.length ? okTrials.length / trials.length : 0,
    minMs: times.length ? Math.min(...times) : null,
    maxMs: times.length ? Math.max(...times) : null,
    meanMs,
    medianMs: median(times),
    p95Ms: percentile(times, 95),
    stdevMs,
    cv: meanMs && stdevMs ? stdevMs / meanMs : null,
    totalBytes: okTrials.reduce((sum, trial) => sum + (trial.bytes ?? 0), 0),
    meanThroughputMiBs: mean(throughputs),
    medianThroughputMiBs: median(throughputs),
  };
}

function asErrorDetails(error: unknown): TrialError {
  if (error instanceof Error) {
    const anyError = error as Error & { $metadata?: { httpStatusCode?: number } };
    return {
      name: anyError.name,
      message: anyError.message,
      statusCode: anyError.$metadata?.httpStatusCode,
    };
  }
  return { message: String(error) };
}

async function ensureBucket(client: S3Client, bucket: string) {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}

async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array,
  metadata?: Record<string, string>,
) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: "application/octet-stream",
      Metadata: metadata,
    }),
  );
}

async function getObjectBytes(client: S3Client, bucket: string, key: string, range?: string) {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: range,
    }),
  );
  return response.Body ? await response.Body.transformToByteArray() : new Uint8Array();
}

async function deleteObject(client: S3Client, bucket: string, key: string) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function repeat(times: number, fn: (index: number) => Promise<void>) {
  for (let index = 0; index < times; index += 1) {
    await fn(index);
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= items.length) return;
      nextIndex += 1;
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

async function waitForCondition(timeoutMs: number, pollMs: number, predicate: () => Promise<boolean>) {
  const startedAt = performance.now();
  while (performance.now() - startedAt <= timeoutMs) {
    if (await predicate()) {
      return performance.now() - startedAt;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

async function recordTrial(
  run: ProviderRun,
  operation: string,
  action: () => Promise<TrialResult | void>,
) {
  const startedPerf = performance.now();
  const startedAtUtc = new Date().toISOString();

  try {
    const result: TrialResult = (await action()) ?? {};
    const trial: TrialRecord = {
      operation,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      ms: performance.now() - startedPerf,
      ok: true,
      bytes: result.bytes,
      throughputMiBs: result.throughputMiBs,
      statusCode: result.statusCode,
      details: result.details,
    };
    (run.trials[operation] ??= []).push(trial);
    return trial;
  } catch (error) {
    const trial: TrialRecord = {
      operation,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      ms: performance.now() - startedPerf,
      ok: false,
      error: asErrorDetails(error),
    };
    (run.trials[operation] ??= []).push(trial);
    return trial;
  }
}

async function recordProbe(
  run: ProviderRun,
  name: string,
  action: () => Promise<Record<string, unknown> | void>,
) {
  const startedPerf = performance.now();
  try {
    const details: Record<string, unknown> | undefined = (await action()) ?? undefined;
    const probe: ProbeRecord = {
      name,
      ok: true,
      ms: performance.now() - startedPerf,
      details,
    };
    run.probes.push(probe);
    return probe;
  } catch (error) {
    const probe: ProbeRecord = {
      name,
      ok: false,
      ms: performance.now() - startedPerf,
      error: asErrorDetails(error),
    };
    run.probes.push(probe);
    return probe;
  }
}

async function runMultipartUpload(client: S3Client, bucket: string, key: string, body: Uint8Array) {
  const created = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
  if (!created.UploadId) {
    throw new Error("Multipart upload did not return UploadId");
  }

  const uploadId = created.UploadId;
  const partSize = bytesFromMb(MULTIPART_PART_SIZE_MB);
  const uploadedParts: Array<{ ETag?: string; PartNumber: number }> = [];

  try {
    const totalParts = Math.ceil(body.byteLength / partSize);
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, body.byteLength);
      const partBody = body.subarray(start, end);
      const part = await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: partBody,
          ContentLength: partBody.byteLength,
        }),
      );
      uploadedParts.push({ ETag: part.ETag, PartNumber: partNumber });
    }

    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: uploadedParts },
      }),
    );
  } catch (error) {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
    throw error;
  }
}

function scoreFromRelative(values: Array<{ key: string; value: number | null }>, direction: ScoreDirection) {
  const usable = values.filter(
    (entry): entry is { key: string; value: number } => entry.value != null && Number.isFinite(entry.value),
  );
  const result = new Map<string, number>();

  if (!usable.length) return result;

  const transformed = usable.map((entry) => ({
    key: entry.key,
    value: Math.log10(Math.max(entry.value, 1e-9) + 1e-9),
  }));
  const min = Math.min(...transformed.map((entry) => entry.value));
  const max = Math.max(...transformed.map((entry) => entry.value));

  if (Math.abs(max - min) < 1e-9) {
    for (const entry of transformed) result.set(entry.key, 100);
    return result;
  }

  for (const entry of transformed) {
    const normalized =
      direction === "higher"
        ? (entry.value - min) / (max - min)
        : (max - entry.value) / (max - min);
    result.set(entry.key, normalized * 100);
  }

  return result;
}

function providerFolder(baseDir: string, providerName: string) {
  return join(baseDir, safeName(providerName));
}

async function saveJson(filepath: string, value: unknown) {
  await mkdir(dirname(filepath), { recursive: true });
  await writeFile(filepath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setTrialThroughput(trial: TrialRecord, bytes: number) {
  if (trial.ok && trial.ms > 0) {
    trial.bytes = bytes;
    trial.throughputMiBs = (bytes / 1024 / 1024) / (trial.ms / 1000);
  }
}

function getFirstDetailNumber(run: ProviderRun, operation: string, detailKey: string) {
  const trial = (run.trials[operation] ?? []).find((entry) => entry.ok && typeof entry.details?.[detailKey] === "number");
  return numberOrNull(trial?.details?.[detailKey]);
}

async function benchmarkProvider(provider: ProviderConfig): Promise<ProviderRun> {
  const client = createClient(provider);
  const providerKey = safeName(provider.name);
  const basePrefix = `bench/${RUN_ID}/${providerKey}`;

  const run: ProviderRun = {
    provider: {
      name: provider.name,
      region: provider.region,
      endpoint: provider.endpoint,
      bucket: provider.bucket,
    },
    runId: RUN_ID,
    startedAtUtc: new Date().toISOString(),
    config: {
      repeats: REPEATS,
      heavyRepeats: HEAVY_REPEATS,
      sizesMiB: {
        small: SMALL_SIZE_MB,
        medium: MEDIUM_SIZE_MB,
        large: LARGE_SIZE_MB,
      },
      parallel: {
        uploads: PARALLEL_UPLOADS,
        reads: PARALLEL_READS,
        deletes: PARALLEL_DELETES,
      },
      manyObjectsCount: MANY_OBJECTS_COUNT,
      manyObjectsSizeBytes: MANY_OBJECTS_SIZE_BYTES,
      listTarget: LIST_TARGET,
      consistency: {
        pollMs: CONSISTENCY_POLL_MS,
        timeoutMs: CONSISTENCY_TIMEOUT_MS,
      },
      multipart: {
        partSizeMiB: MULTIPART_PART_SIZE_MB,
        parts: MULTIPART_PARTS,
      },
      keepTestData: KEEP_TEST_DATA,
    },
    probes: [],
    trials: {},
    notes: [],
  };

  const cleanupKeys = new Set<string>();

  const smallBody = randomBodyBytes(bytesFromMb(SMALL_SIZE_MB));
  const mediumBody = randomBodyBytes(bytesFromMb(MEDIUM_SIZE_MB));
  const largeBody = randomBodyBytes(bytesFromMb(LARGE_SIZE_MB));
  const tinyBody = randomBodyBytes(MANY_OBJECTS_SIZE_BYTES);
  const multipartBody = randomBodyBytes(bytesFromMb(MULTIPART_PART_SIZE_MB) * MULTIPART_PARTS);

  const hashes = {
    small: sha256Hex(smallBody),
    medium: sha256Hex(mediumBody),
    large: sha256Hex(largeBody),
    tiny: sha256Hex(tinyBody),
    multipart: sha256Hex(multipartBody),
  };

  await ensureBucket(client, provider.bucket);

  console.log(`\n=== ${provider.name} ===`);
  console.log(`Endpoint: ${provider.endpoint}`);
  console.log(`Bucket: ${provider.bucket}`);
  console.log(`Run ID: ${RUN_ID}`);

  await recordProbe(run, "head_bucket", async () => {
    await client.send(new HeadBucketCommand({ Bucket: provider.bucket }));
    return { bucket: provider.bucket };
  });

  const probeKey = `${basePrefix}/capability/probe.bin`;
  const copyKey = `${basePrefix}/capability/probe-copy.bin`;
  const multipartKey = `${basePrefix}/capability/multipart.bin`;

  cleanupKeys.add(probeKey);
  cleanupKeys.add(copyKey);
  cleanupKeys.add(multipartKey);

  await recordProbe(run, "put_object", async () => {
    await putObject(client, provider.bucket, probeKey, tinyBody, { sha256: hashes.tiny });
    return { key: probeKey, bytes: tinyBody.byteLength };
  });

  await recordProbe(run, "head_object", async () => {
    const response = await client.send(new HeadObjectCommand({ Bucket: provider.bucket, Key: probeKey }));
    return { contentLength: response.ContentLength ?? 0, etag: response.ETag ?? null };
  });

  await recordProbe(run, "get_object", async () => {
    const bytes = await getObjectBytes(client, provider.bucket, probeKey);
    const hash = sha256Hex(bytes);
    if (hash !== hashes.tiny) throw new Error(`Probe object hash mismatch: ${hash}`);
    return { bytes: bytes.byteLength, sha256: hash };
  });

  await recordProbe(run, "get_object_range", async () => {
    const bytes = await getObjectBytes(client, provider.bucket, probeKey, "bytes=0-127");
    return { bytes: bytes.byteLength };
  });

  await recordProbe(run, "copy_object", async () => {
    await client.send(
      new CopyObjectCommand({
        Bucket: provider.bucket,
        Key: copyKey,
        CopySource: `${provider.bucket}/${probeKey}`,
      }),
    );
    return { key: copyKey };
  });

  await recordProbe(run, "list_objects_v2", async () => {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: provider.bucket,
        Prefix: `${basePrefix}/capability/`,
        MaxKeys: 1000,
      }),
    );
    return { keyCount: response.KeyCount ?? 0, truncated: response.IsTruncated ?? false };
  });

  await recordProbe(run, "multipart_upload", async () => {
    await runMultipartUpload(client, provider.bucket, multipartKey, multipartBody);
    return { bytes: multipartBody.byteLength, sha256: hashes.multipart };
  });

  await recordProbe(run, "delete_object", async () => {
    await deleteObject(client, provider.bucket, copyKey);
    return { key: copyKey };
  });

  const sizeEntries = [
    { label: "small", body: smallBody, hash: hashes.small },
    { label: "medium", body: mediumBody, hash: hashes.medium },
    { label: "large", body: largeBody, hash: hashes.large },
  ] as const;

  for (const entry of sizeEntries) {
    await repeat(REPEATS, async (trialIndex) => {
      const key = `${basePrefix}/single/${entry.label}/trial-${String(trialIndex + 1).padStart(2, "0")}-${randomUUID()}.bin`;
      cleanupKeys.add(key);

      const uploadTrial = await recordTrial(run, `upload_${entry.label}`, async () => {
        await putObject(client, provider.bucket, key, entry.body, {
          sha256: entry.hash,
          size: String(entry.body.byteLength),
        });
        return { bytes: entry.body.byteLength, details: { key } };
      });
      setTrialThroughput(uploadTrial, entry.body.byteLength);

      await recordTrial(run, `head_object_${entry.label}`, async () => {
        const head = await client.send(new HeadObjectCommand({ Bucket: provider.bucket, Key: key }));
        return {
          bytes: head.ContentLength ?? entry.body.byteLength,
          details: { key, etag: head.ETag ?? null },
        };
      });

      const downloadTrial = await recordTrial(run, `download_${entry.label}`, async () => {
        const bytes = await getObjectBytes(client, provider.bucket, key);
        const hash = sha256Hex(bytes);
        if (hash !== entry.hash) {
          throw new Error(`Integrity mismatch for ${entry.label}: expected ${entry.hash}, got ${hash}`);
        }
        return {
          bytes: bytes.byteLength,
          details: { key, sha256: hash },
        };
      });
      setTrialThroughput(downloadTrial, entry.body.byteLength);

      if (entry.label !== "large") {
        const rangeTrial = await recordTrial(run, `range_read_${entry.label}`, async () => {
          const bytes = await getObjectBytes(client, provider.bucket, key, "bytes=0-4095");
          return { bytes: bytes.byteLength, details: { key } };
        });
        setTrialThroughput(rangeTrial, 4096);
      }

      await recordTrial(run, `delete_${entry.label}`, async () => {
        await deleteObject(client, provider.bucket, key);
        return { details: { key } };
      });

      await recordTrial(run, `post_delete_head_${entry.label}`, async () => {
        try {
          await client.send(new HeadObjectCommand({ Bucket: provider.bucket, Key: key }));
          throw new Error("Object still visible after delete");
        } catch (error) {
          const details = asErrorDetails(error);
          if (details.statusCode === 404) {
            return { statusCode: 404, details: { key } };
          }
          if ((error as Error).message === "Object still visible after delete") throw error;
          throw error;
        }
      });
    });
  }

  await repeat(REPEATS, async (trialIndex) => {
    const key = `${basePrefix}/consistency/read-after-write-${String(trialIndex + 1).padStart(2, "0")}-${randomUUID()}.bin`;
    cleanupKeys.add(key);

    await putObject(client, provider.bucket, key, smallBody, { sha256: hashes.small });

    await recordTrial(run, "read_after_write_visibility", async () => {
      const elapsed = await waitForCondition(CONSISTENCY_TIMEOUT_MS, CONSISTENCY_POLL_MS, async () => {
        try {
          const head = await client.send(new HeadObjectCommand({ Bucket: provider.bucket, Key: key }));
          return (head.ContentLength ?? 0) === smallBody.byteLength;
        } catch {
          return false;
        }
      });
      if (elapsed == null) throw new Error(`Object did not become visible within ${CONSISTENCY_TIMEOUT_MS} ms`);
      return { bytes: smallBody.byteLength, details: { key, elapsedMs: elapsed } };
    });

    await recordTrial(run, "delete_propagation", async () => {
      await deleteObject(client, provider.bucket, key);
      const elapsed = await waitForCondition(CONSISTENCY_TIMEOUT_MS, CONSISTENCY_POLL_MS, async () => {
        try {
          await client.send(new HeadObjectCommand({ Bucket: provider.bucket, Key: key }));
          return false;
        } catch (error) {
          return asErrorDetails(error).statusCode === 404;
        }
      });
      if (elapsed == null) throw new Error(`Delete did not propagate within ${CONSISTENCY_TIMEOUT_MS} ms`);
      return { details: { key, elapsedMs: elapsed } };
    });
  });

  await repeat(MISSING_KEY_REPEATS, async (trialIndex) => {
    const missingKey = `${basePrefix}/missing/${trialIndex + 1}-${randomUUID()}.bin`;

    await recordTrial(run, "missing_read", async () => {
      try {
        await getObjectBytes(client, provider.bucket, missingKey);
        throw new Error("Missing object unexpectedly downloaded");
      } catch (error) {
        const details = asErrorDetails(error);
        if (details.statusCode === 404) {
          return { statusCode: 404, details: { key: missingKey } };
        }
        if ((error as Error).message === "Missing object unexpectedly downloaded") throw error;
        throw error;
      }
    });

    await recordTrial(run, "missing_head", async () => {
      try {
        await client.send(new HeadObjectCommand({ Bucket: provider.bucket, Key: missingKey }));
        throw new Error("Missing object unexpectedly exists");
      } catch (error) {
        const details = asErrorDetails(error);
        if (details.statusCode === 404) {
          return { statusCode: 404, details: { key: missingKey } };
        }
        if ((error as Error).message === "Missing object unexpectedly exists") throw error;
        throw error;
      }
    });
  });

  await repeat(HEAVY_REPEATS, async (heavyIndex) => {
    const cycle = heavyIndex + 1;
    const cycleLabel = `cycle-${String(cycle).padStart(2, "0")}`;

    const parallelUploadPrefix = `${basePrefix}/parallel/${cycleLabel}`;
    const parallelKeys: string[] = [];

    const parallelUploadTrial = await recordTrial(run, "parallel_upload_batch", async () => {
      await mapWithConcurrency(
        Array.from({ length: PARALLEL_UPLOADS }, (_, index) => index),
        PARALLEL_UPLOADS,
        async (index) => {
          const key = `${parallelUploadPrefix}/item-${String(index).padStart(4, "0")}-${randomUUID()}.bin`;
          parallelKeys.push(key);
          cleanupKeys.add(key);
          await putObject(client, provider.bucket, key, smallBody, {
            sha256: hashes.small,
            cycle: String(cycle),
            batch: "parallel_upload",
          });
        },
      );
      return {
        bytes: parallelKeys.length * smallBody.byteLength,
        details: { count: parallelKeys.length, cycle },
      };
    });
    setTrialThroughput(parallelUploadTrial, parallelKeys.length * smallBody.byteLength);

    const parallelReadTrial = await recordTrial(run, "parallel_read_batch", async () => {
      await mapWithConcurrency(parallelKeys, PARALLEL_READS, async (key) => {
        const bytes = await getObjectBytes(client, provider.bucket, key);
        const hash = sha256Hex(bytes);
        if (hash !== hashes.small) {
          throw new Error(`Parallel read integrity mismatch for ${key}`);
        }
      });
      return {
        bytes: parallelKeys.length * smallBody.byteLength,
        details: { count: parallelKeys.length, cycle },
      };
    });
    setTrialThroughput(parallelReadTrial, parallelKeys.length * smallBody.byteLength);

    await recordTrial(run, "parallel_delete_batch", async () => {
      await mapWithConcurrency(parallelKeys, PARALLEL_DELETES, async (key) => {
        await deleteObject(client, provider.bucket, key);
      });
      return { details: { count: parallelKeys.length, cycle } };
    });

    const manyPrefix = `${basePrefix}/many/${cycleLabel}`;
    const manyKeys = Array.from(
      { length: MANY_OBJECTS_COUNT },
      (_, index) => `${manyPrefix}/obj-${String(index).padStart(8, "0")}.bin`,
    );

    const seedTrial = await recordTrial(run, "seed_many_objects", async () => {
      await mapWithConcurrency(manyKeys, PARALLEL_UPLOADS, async (key) => {
        cleanupKeys.add(key);
        await putObject(client, provider.bucket, key, tinyBody, {
          sha256: hashes.tiny,
          cycle: String(cycle),
          group: "many",
        });
      });
      return {
        bytes: manyKeys.length * tinyBody.byteLength,
        details: { count: manyKeys.length, cycle },
      };
    });
    setTrialThroughput(seedTrial, manyKeys.length * tinyBody.byteLength);

    await recordTrial(run, "list_single_page", async () => {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: provider.bucket,
          Prefix: manyPrefix,
          MaxKeys: 1000,
        }),
      );
      return {
        details: {
          count: response.Contents?.length ?? 0,
          truncated: response.IsTruncated ?? false,
          cycle,
        },
      };
    });

    await recordTrial(run, "list_deep_scan", async () => {
      let continuationToken: string | undefined;
      let listed = 0;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: provider.bucket,
            Prefix: manyPrefix,
            MaxKeys: 1000,
            ContinuationToken: continuationToken,
          }),
        );
        listed += page.Contents?.length ?? 0;
        continuationToken = page.NextContinuationToken;
        if (listed >= LIST_TARGET) break;
      } while (continuationToken);

      return {
        details: {
          listed,
          cycle,
        },
      };
    });

    await recordTrial(run, "parallel_delete_many_objects", async () => {
      await mapWithConcurrency(manyKeys, PARALLEL_DELETES, async (key) => {
        await deleteObject(client, provider.bucket, key);
      });
      return { details: { count: manyKeys.length, cycle } };
    });
  });

  if (!KEEP_TEST_DATA) {
    await mapWithConcurrency([...cleanupKeys], PARALLEL_DELETES, async (key) => {
      try {
        await deleteObject(client, provider.bucket, key);
      } catch {
        // Deliberately ignore cleanup errors.
      }
    });
  } else {
    run.notes.push(`KEEP_TEST_DATA enabled; retained ${cleanupKeys.size} objects under ${basePrefix}`);
  }

  run.completedAtUtc = new Date().toISOString();
  run.aggregates = Object.fromEntries(
    Object.entries(run.trials).map(([operation, trials]) => [operation, summarizeTrials(trials)]),
  );

  const aggregates = run.aggregates;
  const capabilitySuccessRate = run.probes.length
    ? run.probes.filter((probe) => probe.ok).length / run.probes.length
    : 0;

  const integrityRelevant = [
    aggregates["download_small"],
    aggregates["download_medium"],
    aggregates["download_large"],
    aggregates["parallel_read_batch"],
  ].filter(Boolean);
  const integritySuccessRate = integrityRelevant.length
    ? integrityRelevant.reduce((sum, aggregate) => sum + aggregate.successRate, 0) / integrityRelevant.length
    : 0;

  const deleteValidationSuccessRate = weightedAverage([
    { value: aggregates["post_delete_head_small"]?.successRate ?? 0, weight: 1 },
    { value: aggregates["post_delete_head_medium"]?.successRate ?? 0, weight: 1 },
    { value: aggregates["post_delete_head_large"]?.successRate ?? 0, weight: 1 },
  ]);

  const missingReadExpectedErrorRate = aggregates["missing_read"]?.successRate ?? 0;

  const coreAggregates = [
    aggregates["upload_small"],
    aggregates["upload_medium"],
    aggregates["upload_large"],
    aggregates["download_small"],
    aggregates["download_medium"],
    aggregates["download_large"],
    aggregates["delete_small"],
    aggregates["delete_medium"],
    aggregates["delete_large"],
    aggregates["head_object_small"],
  ].filter(Boolean);

  const coreFailureRate = coreAggregates.length
    ? coreAggregates.reduce((sum, aggregate) => sum + (1 - aggregate.successRate), 0) / coreAggregates.length
    : 1;

  const coreCvValues = coreAggregates
    .map((aggregate) => aggregate.cv)
    .filter((value): value is number => value != null && Number.isFinite(value));

  const visibilityElapsedMedianMs = median(
    (run.trials["read_after_write_visibility"] ?? [])
      .filter((trial) => trial.ok)
      .map((trial) => numberOrNull(trial.details?.elapsedMs))
      .filter((value): value is number => value != null),
  );

  const deletePropagationElapsedMedianMs = median(
    (run.trials["delete_propagation"] ?? [])
      .filter((trial) => trial.ok)
      .map((trial) => numberOrNull(trial.details?.elapsedMs))
      .filter((value): value is number => value != null),
  );

  const listDeepScanListed = getFirstDetailNumber(run, "list_deep_scan", "listed") ?? Math.min(LIST_TARGET, MANY_OBJECTS_COUNT);
  const listObjectsPerSecond = aggregates["list_deep_scan"]?.medianMs
    ? listDeepScanListed / (aggregates["list_deep_scan"].medianMs! / 1000)
    : null;

  const seededObjectsCount = getFirstDetailNumber(run, "seed_many_objects", "count") ?? MANY_OBJECTS_COUNT;
  const seedObjectsPerSecond = aggregates["seed_many_objects"]?.medianMs
    ? seededObjectsCount / (aggregates["seed_many_objects"].medianMs! / 1000)
    : null;

  const deletedManyCount = getFirstDetailNumber(run, "parallel_delete_many_objects", "count") ?? MANY_OBJECTS_COUNT;
  const parallelDeletesPerSecond = aggregates["parallel_delete_many_objects"]?.medianMs
    ? deletedManyCount / (aggregates["parallel_delete_many_objects"].medianMs! / 1000)
    : null;

  run.derived = {
    capabilitySuccessRate,
    integritySuccessRate,
    deleteValidationSuccessRate,
    missingReadExpectedErrorRate,
    coreFailureRate,
    coreMedianCv: median(coreCvValues),
    visibilityMedianMs: visibilityElapsedMedianMs,
    deletePropagationMedianMs: deletePropagationElapsedMedianMs,
    parallelUploadAggregateMiBsPerSec: aggregates["parallel_upload_batch"]?.medianThroughputMiBs ?? null,
    parallelReadAggregateMiBsPerSec: aggregates["parallel_read_batch"]?.medianThroughputMiBs ?? null,
    listObjectsPerSecond,
    seedObjectsPerSecond,
    parallelDeletesPerSecond,
  };

  console.log(`Capability success: ${(capabilitySuccessRate * 100).toFixed(1)}%`);
  console.log(`Small upload median: ${formatMs(aggregates["upload_small"]?.medianMs)} | ${formatMiBs(aggregates["upload_small"]?.medianThroughputMiBs)}`);
  console.log(`Large download median: ${formatMs(aggregates["download_large"]?.medianMs)} | ${formatMiBs(aggregates["download_large"]?.medianThroughputMiBs)}`);
  console.log(`Parallel upload aggregate: ${formatMiBs(run.derived.parallelUploadAggregateMiBsPerSec as number | null)}`);
  console.log(`Parallel read aggregate: ${formatMiBs(run.derived.parallelReadAggregateMiBsPerSec as number | null)}`);
  console.log(`Deep list rate: ${numberOrNull(run.derived.listObjectsPerSecond)?.toFixed(0) ?? "n/a"} obj/s`);
  console.log(`Seed-many rate: ${numberOrNull(run.derived.seedObjectsPerSecond)?.toFixed(0) ?? "n/a"} obj/s`);

  return run;
}

function toSummary(run: ProviderRun): ProviderSummary {
  return {
    name: run.provider.name,
    providerKey: safeName(run.provider.name),
    aggregates: run.aggregates ?? {},
    derived: run.derived ?? {},
    scores: run.scores,
  };
}

function computeScores(summaries: ProviderSummary[]) {
  const latencyHead = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: summary.aggregates["head_object_small"]?.medianMs ?? null })),
    "lower",
  );
  const latencyUpload = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: summary.aggregates["upload_small"]?.medianMs ?? null })),
    "lower",
  );
  const latencyDownload = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: summary.aggregates["download_small"]?.medianMs ?? null })),
    "lower",
  );
  const latencyDelete = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: summary.aggregates["delete_small"]?.medianMs ?? null })),
    "lower",
  );

  const throughputUpload = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: summary.aggregates["upload_large"]?.medianThroughputMiBs ?? null })),
    "higher",
  );
  const throughputDownload = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: summary.aggregates["download_large"]?.medianThroughputMiBs ?? null })),
    "higher",
  );
  const throughputParallelUpload = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: numberOrNull(summary.derived.parallelUploadAggregateMiBsPerSec) })),
    "higher",
  );
  const throughputParallelRead = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: numberOrNull(summary.derived.parallelReadAggregateMiBsPerSec) })),
    "higher",
  );

  const consistencyCv = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: numberOrNull(summary.derived.coreMedianCv) })),
    "lower",
  );
  const consistencyVisibility = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: numberOrNull(summary.derived.visibilityMedianMs) })),
    "lower",
  );
  const consistencyDelete = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: numberOrNull(summary.derived.deletePropagationMedianMs) })),
    "lower",
  );

  const scalabilityList = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: numberOrNull(summary.derived.listObjectsPerSecond) })),
    "higher",
  );
  const scalabilitySeed = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: numberOrNull(summary.derived.seedObjectsPerSecond) })),
    "higher",
  );
  const scalabilityDelete = scoreFromRelative(
    summaries.map((summary) => ({ key: summary.providerKey, value: numberOrNull(summary.derived.parallelDeletesPerSecond) })),
    "higher",
  );

  for (const summary of summaries) {
    const key = summary.providerKey;
    const failurePenalty = clamp(1 - numberOrZero(summary.derived.coreFailureRate) * 2.5, 0, 1);

    const capability = clamp(numberOrZero(summary.derived.capabilitySuccessRate) * 100, 0, 100);
    const integrity = clamp(
      weightedAverage([
        { value: numberOrZero(summary.derived.integritySuccessRate) * 100, weight: 0.6 },
        { value: numberOrZero(summary.derived.deleteValidationSuccessRate) * 100, weight: 0.2 },
        { value: numberOrZero(summary.derived.missingReadExpectedErrorRate) * 100, weight: 0.2 },
      ]),
      0,
      100,
    );

    const latency =
      weightedAverage([
        { value: latencyHead.get(key) ?? 0, weight: 0.2 },
        { value: latencyUpload.get(key) ?? 0, weight: 0.3 },
        { value: latencyDownload.get(key) ?? 0, weight: 0.3 },
        { value: latencyDelete.get(key) ?? 0, weight: 0.2 },
      ]) * failurePenalty;

    const throughput =
      weightedAverage([
        { value: throughputUpload.get(key) ?? 0, weight: 0.3 },
        { value: throughputDownload.get(key) ?? 0, weight: 0.3 },
        { value: throughputParallelUpload.get(key) ?? 0, weight: 0.2 },
        { value: throughputParallelRead.get(key) ?? 0, weight: 0.2 },
      ]) * failurePenalty;

    const consistency =
      weightedAverage([
        { value: consistencyCv.get(key) ?? 0, weight: 0.4 },
        { value: consistencyVisibility.get(key) ?? 0, weight: 0.3 },
        { value: consistencyDelete.get(key) ?? 0, weight: 0.3 },
      ]) * failurePenalty;

    const scalability =
      weightedAverage([
        { value: scalabilityList.get(key) ?? 0, weight: 0.45 },
        { value: scalabilitySeed.get(key) ?? 0, weight: 0.25 },
        { value: scalabilityDelete.get(key) ?? 0, weight: 0.3 },
      ]) * failurePenalty;

    const overall = weightedAverage([
      { value: capability, weight: 0.12 },
      { value: latency, weight: 0.20 },
      { value: throughput, weight: 0.24 },
      { value: consistency, weight: 0.18 },
      { value: scalability, weight: 0.16 },
      { value: integrity, weight: 0.10 },
    ]);

    summary.scores = {
      capability: round2(capability),
      latency: round2(latency),
      throughput: round2(throughput),
      consistency: round2(consistency),
      scalability: round2(scalability),
      integrity: round2(integrity),
      overall: round2(overall),
    };
  }
}

function buildMarkdownReport(summaries: ProviderSummary[]) {
  const ranked = [...summaries].sort((a, b) => (b.scores?.overall ?? 0) - (a.scores?.overall ?? 0));
  const lines: string[] = [];

  lines.push(`# S3 benchmark report`);
  lines.push(``);
  lines.push(`Run ID: ${RUN_ID}`);
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`## Configuration`);
  lines.push(`- Repeats per single-object test: ${REPEATS}`);
  lines.push(`- Heavy workload repeats: ${HEAVY_REPEATS}`);
  lines.push(`- Object sizes: small=${SMALL_SIZE_MB} MiB, medium=${MEDIUM_SIZE_MB} MiB, large=${LARGE_SIZE_MB} MiB`);
  lines.push(`- Parallel uploads=${PARALLEL_UPLOADS}, reads=${PARALLEL_READS}, deletes=${PARALLEL_DELETES}`);
  lines.push(`- Many-object test count=${MANY_OBJECTS_COUNT.toLocaleString()}, payload=${formatBytes(MANY_OBJECTS_SIZE_BYTES)}`);
  lines.push(`- Deep list target=${LIST_TARGET.toLocaleString()} objects`);
  lines.push(``);
  lines.push(`## Ranking`);
  lines.push(`| Rank | Provider | Overall | Capability | Latency | Throughput | Consistency | Scalability | Integrity |`);
  lines.push(`| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);

  for (const [index, summary] of ranked.entries()) {
    lines.push(
      `| ${index + 1} | ${summary.name} | ${(summary.scores?.overall ?? 0).toFixed(2)} | ${(summary.scores?.capability ?? 0).toFixed(2)} | ${(summary.scores?.latency ?? 0).toFixed(2)} | ${(summary.scores?.throughput ?? 0).toFixed(2)} | ${(summary.scores?.consistency ?? 0).toFixed(2)} | ${(summary.scores?.scalability ?? 0).toFixed(2)} | ${(summary.scores?.integrity ?? 0).toFixed(2)} |`,
    );
  }

  lines.push(``);
  for (const summary of ranked) {
    lines.push(`## ${summary.name}`);
    lines.push(``);
    lines.push(`- Capability success: ${(numberOrZero(summary.derived.capabilitySuccessRate) * 100).toFixed(1)}%`);
    lines.push(`- Core failure rate: ${(numberOrZero(summary.derived.coreFailureRate) * 100).toFixed(1)}%`);
    lines.push(`- Small upload median: ${formatMs(summary.aggregates["upload_small"]?.medianMs)} | ${formatMiBs(summary.aggregates["upload_small"]?.medianThroughputMiBs)}`);
    lines.push(`- Large upload median: ${formatMs(summary.aggregates["upload_large"]?.medianMs)} | ${formatMiBs(summary.aggregates["upload_large"]?.medianThroughputMiBs)}`);
    lines.push(`- Small download median: ${formatMs(summary.aggregates["download_small"]?.medianMs)} | ${formatMiBs(summary.aggregates["download_small"]?.medianThroughputMiBs)}`);
    lines.push(`- Large download median: ${formatMs(summary.aggregates["download_large"]?.medianMs)} | ${formatMiBs(summary.aggregates["download_large"]?.medianThroughputMiBs)}`);
    lines.push(`- Head small median latency: ${formatMs(summary.aggregates["head_object_small"]?.medianMs)}`);
    lines.push(`- Delete small median latency: ${formatMs(summary.aggregates["delete_small"]?.medianMs)}`);
    lines.push(`- Parallel upload aggregate throughput: ${formatMiBs(numberOrNull(summary.derived.parallelUploadAggregateMiBsPerSec))}`);
    lines.push(`- Parallel read aggregate throughput: ${formatMiBs(numberOrNull(summary.derived.parallelReadAggregateMiBsPerSec))}`);
    lines.push(`- List scan rate: ${numberOrNull(summary.derived.listObjectsPerSecond)?.toFixed(0) ?? "n/a"} obj/s`);
    lines.push(`- Seed-many rate: ${numberOrNull(summary.derived.seedObjectsPerSecond)?.toFixed(0) ?? "n/a"} obj/s`);
    lines.push(`- Delete-many rate: ${numberOrNull(summary.derived.parallelDeletesPerSecond)?.toFixed(0) ?? "n/a"} obj/s`);
    lines.push(`- Read-after-write visibility median: ${formatMs(numberOrNull(summary.derived.visibilityMedianMs))}`);
    lines.push(`- Delete propagation median: ${formatMs(numberOrNull(summary.derived.deletePropagationMedianMs))}`);
    lines.push(``);
  }

  return `${lines.join("\n")}\n`;
}

async function main() {

  const runDir = join(OUTPUT_DIR, RUN_ID);
  await mkdir(runDir, { recursive: true });

  console.log(
    `Running heavy S3 benchmark | run=${RUN_ID} | repeats=${REPEATS} | heavyRepeats=${HEAVY_REPEATS} | sizes=${SMALL_SIZE_MB}/${MEDIUM_SIZE_MB}/${LARGE_SIZE_MB} MiB | manyObjects=${MANY_OBJECTS_COUNT.toLocaleString()} | listTarget=${LIST_TARGET.toLocaleString()}`,
  );

  const runs: ProviderRun[] = [];

  for (const provider of PROVIDERS) {
    try {
      const run = await benchmarkProvider(provider);
      runs.push(run);

      const folder = providerFolder(runDir, provider.name);
      await mkdir(folder, { recursive: true });
      await saveJson(join(folder, "raw.json"), run);
    } catch (error) {
      console.error(`\n=== ${provider.name} FAILED ===`);
      console.error(error);

      const failedRun: ProviderRun = {
        provider: {
          name: provider.name,
          region: provider.region,
          endpoint: provider.endpoint,
          bucket: provider.bucket,
        },
        runId: RUN_ID,
        startedAtUtc: new Date().toISOString(),
        completedAtUtc: new Date().toISOString(),
        config: {},
        probes: [],
        trials: {},
        notes: [asErrorDetails(error).message],
      };

      runs.push(failedRun);
      const folder = providerFolder(runDir, provider.name);
      await mkdir(folder, { recursive: true });
      await saveJson(join(folder, "raw.json"), failedRun);
    }
  }

  const summaries = runs.map(toSummary);
  computeScores(summaries);

  for (const summary of summaries) {
    const folder = providerFolder(runDir, summary.name);
    await saveJson(join(folder, "summary.json"), summary);
  }

  const ranking = [...summaries]
    .sort((a, b) => (b.scores?.overall ?? 0) - (a.scores?.overall ?? 0))
    .map((summary, index) => ({
      rank: index + 1,
      provider: summary.name,
      scores: summary.scores,
      derived: summary.derived,
    }));

  await saveJson(join(runDir, "ranking.json"), ranking);
  await saveJson(join(runDir, "all-results.json"), summaries);
  await writeFile(join(runDir, "report.md"), buildMarkdownReport(summaries), "utf8");

  console.log("\n=== Ranking ===");
  for (const entry of ranking) {
    console.log(
      `${entry.rank}. ${entry.provider} — overall ${(entry.scores?.overall ?? 0).toFixed(2)} | throughput ${(entry.scores?.throughput ?? 0).toFixed(2)} | latency ${(entry.scores?.latency ?? 0).toFixed(2)} | consistency ${(entry.scores?.consistency ?? 0).toFixed(2)}`,
    );
  }

  console.log(`\nSaved raw JSON, summary JSON, ranking JSON, and report markdown under ${runDir}`);
}

void main();
