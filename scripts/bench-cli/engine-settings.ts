import type { ProviderConfig } from "./engine-model";

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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export const PROVIDERS: ProviderConfig[] = [
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
  {
    name: "Cloudflare R2",
    region: "auto",
    endpoint: "https://211d8b16844ebee8eba8cb5c0324806c.r2.cloudflarestorage.com",
    accessKeyId: "fc7166c7fac31bebc2e332f134cbc88e",
    secretAccessKey: "50fe20a9a6f045ecc0eb3e6bbef74ea9a6667d70db5084f6f4f8200f8b038da3",
    bucket: "speedtesting",
  },
  {
    name: "Wasabi EU Central 2",
    region: "eu-central-2",
    endpoint: "https://s3.eu-central-2.wasabisys.com",
    accessKeyId: "USMNFISOJ474CA38ZM9D",
    secretAccessKey: "pbIbBzXgKDb6SCzkOjAP7BY3IcugWoyPwL9acgv7",
    bucket: "speedtestbenchamark",
  },
];

export const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
export const OUTPUT_DIR = process.env.S3_BENCH_OUTPUT_DIR ?? "./s3-bench-results";

export const REPEATS = numberEnv("S3_BENCH_REPEATS", 5);
export const HEAVY_REPEATS = numberEnv("S3_BENCH_HEAVY_REPEATS", 2);

export const SMALL_SIZE_MB = numberEnv("S3_BENCH_SMALL_MB", 8);
export const MEDIUM_SIZE_MB = numberEnv("S3_BENCH_MEDIUM_MB", 64);
export const LARGE_SIZE_MB = numberEnv("S3_BENCH_LARGE_MB", 256);

export const PARALLEL_UPLOADS = numberEnv("S3_BENCH_PARALLEL_UPLOADS", 16);
export const PARALLEL_READS = numberEnv("S3_BENCH_PARALLEL_READS", 16);
export const PARALLEL_DELETES = numberEnv("S3_BENCH_PARALLEL_DELETES", 32);

export const MANY_OBJECTS_COUNT = numberEnv("S3_BENCH_MANY_OBJECTS_COUNT", 10000);
export const MANY_OBJECTS_SIZE_BYTES = numberEnv("S3_BENCH_MANY_OBJECTS_SIZE_BYTES", 1024);
export const LIST_TARGET = numberEnv("S3_BENCH_LIST_TARGET", 10000);

export const CONSISTENCY_POLL_MS = numberEnv("S3_BENCH_CONSISTENCY_POLL_MS", 50);
export const CONSISTENCY_TIMEOUT_MS = numberEnv("S3_BENCH_CONSISTENCY_TIMEOUT_MS", 15000);
export const MULTIPART_PART_SIZE_MB = numberEnv("S3_BENCH_MULTIPART_PART_SIZE_MB", 8);
export const MULTIPART_PARTS = numberEnv("S3_BENCH_MULTIPART_PARTS", 4);
export const MISSING_KEY_REPEATS = numberEnv("S3_BENCH_MISSING_KEY_REPEATS", 3);
export const KEEP_TEST_DATA = booleanEnv("S3_BENCH_KEEP_TEST_DATA", false);
export const OP_TIMEOUT_MS = numberEnv("S3_BENCH_OP_TIMEOUT_MS", 120000);
export const OP_RETRIES = numberEnv("S3_BENCH_OP_RETRIES", 2);
export const RETRY_BASE_DELAY_MS = numberEnv("S3_BENCH_RETRY_BASE_DELAY_MS", 200);
export const RATE_LIMIT_BASE_COOLDOWN_MS = numberEnv("S3_BENCH_RATE_LIMIT_BASE_COOLDOWN_MS", 8000);
export const RATE_LIMIT_MAX_COOLDOWN_MS = numberEnv("S3_BENCH_RATE_LIMIT_MAX_COOLDOWN_MS", 120000);
export const RATE_LIMIT_SKIP_THRESHOLD = numberEnv("S3_BENCH_RATE_LIMIT_SKIP_THRESHOLD", 12);
export const RATE_LIMIT_TOTAL_SKIP_THRESHOLD = numberEnv("S3_BENCH_RATE_LIMIT_TOTAL_SKIP_THRESHOLD", 40);
export const RATE_LIMIT_AUTO_SKIP_PROVIDER = booleanEnv("S3_BENCH_RATE_LIMIT_AUTO_SKIP_PROVIDER", false);
export const BATCH_MIN_SUCCESS_RATE = clamp(numberEnv("S3_BENCH_BATCH_MIN_SUCCESS_RATE", 0.9), 0, 1);
export const PHASE_SOFT_TIMEOUT_MS = numberEnv("S3_BENCH_PHASE_SOFT_TIMEOUT_MS", 0);
export const PROVIDER_FILTER = (process.env.S3_BENCH_PROVIDER_FILTER ?? "")
  .split(",")
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);

export const BENCH_CONFIG: Record<string, unknown> = {
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
  reliability: {
    opTimeoutMs: OP_TIMEOUT_MS,
    opRetries: OP_RETRIES,
    retryBaseDelayMs: RETRY_BASE_DELAY_MS,
    rateLimitBaseCooldownMs: RATE_LIMIT_BASE_COOLDOWN_MS,
    rateLimitMaxCooldownMs: RATE_LIMIT_MAX_COOLDOWN_MS,
    rateLimitSkipThreshold: RATE_LIMIT_SKIP_THRESHOLD,
    rateLimitTotalSkipThreshold: RATE_LIMIT_TOTAL_SKIP_THRESHOLD,
    rateLimitAutoSkipProvider: RATE_LIMIT_AUTO_SKIP_PROVIDER,
    batchMinSuccessRate: BATCH_MIN_SUCCESS_RATE,
    phaseSoftTimeoutMs: PHASE_SOFT_TIMEOUT_MS,
  },
  keepTestData: KEEP_TEST_DATA,
};
