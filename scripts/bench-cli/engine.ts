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
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  AggregateStats,
  ProgressTotals,
  ProviderConfig,
  ProviderRun,
  ProbeRecord,
  TrialError,
  TrialRecord,
  TrialResult,
} from "./engine-model";
import {
  BATCH_MIN_SUCCESS_RATE,
  BENCH_CONFIG,
  CONSISTENCY_POLL_MS,
  CONSISTENCY_TIMEOUT_MS,
  HEAVY_REPEATS,
  KEEP_TEST_DATA,
  LARGE_SIZE_MB,
  LIST_TARGET,
  MANY_OBJECTS_COUNT,
  MANY_OBJECTS_SIZE_BYTES,
  MEDIUM_SIZE_MB,
  MISSING_KEY_REPEATS,
  MULTIPART_PART_SIZE_MB,
  MULTIPART_PARTS,
  OP_RETRIES,
  OP_TIMEOUT_MS,
  OUTPUT_DIR,
  PARALLEL_DELETES,
  PARALLEL_READS,
  PARALLEL_UPLOADS,
  PHASE_SOFT_TIMEOUT_MS,
  PROVIDER_FILTER,
  PROVIDERS,
  RATE_LIMIT_AUTO_SKIP_PROVIDER,
  RATE_LIMIT_BASE_COOLDOWN_MS,
  RATE_LIMIT_MAX_COOLDOWN_MS,
  RATE_LIMIT_SKIP_THRESHOLD,
  RATE_LIMIT_TOTAL_SKIP_THRESHOLD,
  REPEATS,
  RETRY_BASE_DELAY_MS,
  RUN_ID,
  SMALL_SIZE_MB,
} from "./engine-settings";
import { RATE_LIMIT_STATE, RUNTIME_CONTROLS, emitBenchEvent } from "./engine-runtime";
import {
  ANSI,
  asErrorDetails,
  asStringArray,
  bytesFromMb,
  clamp,
  color,
  formatBytes,
  formatEta,
  formatMiBs,
  formatMs,
  isInteractiveTty,
  mean,
  median,
  numberOrNull,
  numberOrZero,
  percentile,
  progressBar,
  round2,
  safeName,
  sha256Hex,
  sleep,
  stdev,
  summarizeTrials,
  weightedAverage,
} from "./engine-utils";
import { getFirstDetailNumber, providerFolder, saveJson, setTrialThroughput } from "./engine-results";
import { buildMarkdownReport, computeScores, toSummary } from "./engine-scoring";

class LiveProgress {
  private readonly providerName: string;
  private frameIndex = 0;
  private readonly frames = ["-", "\\", "|", "/"];
  private interval?: NodeJS.Timeout;
  private status = "starting";
  private startedAt = performance.now();

  constructor(providerName: string) {
    this.providerName = providerName;
  }

  start() {
    if (!isInteractiveTty()) {
      console.log(color(`\n[provider] ${this.providerName}`, ANSI.cyan));
      return;
    }
    this.render();
    this.interval = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.render();
    }, 90);
  }

  setStatus(status: string) {
    this.status = status;
    if (!isInteractiveTty()) {
      console.log(color(`[${this.providerName}] ${status}`, ANSI.blue));
      return;
    }
    this.render();
  }

  complete(ok: boolean, message: string) {
    if (this.interval) clearInterval(this.interval);
    const elapsed = formatMs(performance.now() - this.startedAt);
    if (isInteractiveTty()) process.stdout.write("\r\x1b[K");
    const prefix = ok ? color("[OK]", ANSI.green) : color("[FAIL]", ANSI.red);
    console.log(`${prefix} ${color(this.providerName, ANSI.cyan)} ${message} ${color(`(${elapsed})`, ANSI.dim)}`);
  }

  private render() {
    if (!isInteractiveTty()) return;
    const frame = this.frames[this.frameIndex];
    const line = `${color(frame, ANSI.yellow)} ${color(this.providerName, ANSI.cyan)} ${this.status}`;
    process.stdout.write(`\r\x1b[K${line}`);
  }
}

async function withTimeout<T>(label: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRateLimitError(details: TrialError) {
  const status = details.statusCode;
  if (status === 429 || status === 503) return true;
  const message = details.message.toLowerCase();
  return message.includes("reduce your request rate") || message.includes("rate limit") || message.includes("throttl");
}

async function waitForGlobalCooldown(operation: string) {
  const now = Date.now();
  if (RATE_LIMIT_STATE.cooldownUntilMs <= now) return;
  const waitMs = RATE_LIMIT_STATE.cooldownUntilMs - now;
  emitBenchEvent({
    type: "status",
    operation,
    message: `rate-limited cooldown ${Math.ceil(waitMs / 1000)}s before retrying ${operation}`,
    elapsedMs: waitMs,
  });
  await sleep(waitMs);
}

function resetRateLimitState() {
  RATE_LIMIT_STATE.cooldownUntilMs = 0;
  RATE_LIMIT_STATE.consecutiveEvents = 0;
  RATE_LIMIT_STATE.totalEvents = 0;
}

async function withRetries<T>(label: string, retries: number, action: () => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (RUNTIME_CONTROLS.abortAll) throw new Error("Benchmark aborted by user (q)");
    if (RUNTIME_CONTROLS.skipProvider) {
      throw new Error(
        RUNTIME_CONTROLS.skipProviderReason === "user"
          ? "Provider skipped by user (p)"
          : "Provider skipped automatically by benchmark logic",
      );
    }
    await waitForGlobalCooldown(label);
    emitBenchEvent({
      type: "status",
      operation: label,
      attempt: attempt + 1,
      totalAttempts: retries + 1,
      message: `${label} attempt ${attempt + 1}/${retries + 1}`,
    });
    try {
      const result = await withTimeout(label, OP_TIMEOUT_MS, action);
      RATE_LIMIT_STATE.consecutiveEvents = 0;
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      const details = asErrorDetails(error);
      let backoff = RETRY_BASE_DELAY_MS * 2 ** attempt;
      if (isRateLimitError(details)) {
        RATE_LIMIT_STATE.consecutiveEvents += 1;
        RATE_LIMIT_STATE.totalEvents += 1;
        const cooldown = Math.min(
          RATE_LIMIT_MAX_COOLDOWN_MS,
          RATE_LIMIT_BASE_COOLDOWN_MS * 2 ** Math.min(RATE_LIMIT_STATE.consecutiveEvents - 1, 4),
        );
        RATE_LIMIT_STATE.cooldownUntilMs = Math.max(RATE_LIMIT_STATE.cooldownUntilMs, Date.now() + cooldown);
        backoff = Math.max(backoff, cooldown);
        emitBenchEvent({
          type: "status",
          operation: label,
          message: `provider throttling detected (${details.statusCode ?? "n/a"}); cooldown ${Math.ceil(cooldown / 1000)}s`,
          statusCode: details.statusCode,
          details: {
            consecutiveRateLimitEvents: RATE_LIMIT_STATE.consecutiveEvents,
            totalRateLimitEvents: RATE_LIMIT_STATE.totalEvents,
            consecutiveRateLimitThreshold: RATE_LIMIT_SKIP_THRESHOLD,
            totalRateLimitThreshold: RATE_LIMIT_TOTAL_SKIP_THRESHOLD,
          },
        });
        const reachedConsecutiveLimit = RATE_LIMIT_STATE.consecutiveEvents >= RATE_LIMIT_SKIP_THRESHOLD;
        const reachedTotalLimit = RATE_LIMIT_STATE.totalEvents >= RATE_LIMIT_TOTAL_SKIP_THRESHOLD;
        if (RATE_LIMIT_AUTO_SKIP_PROVIDER && (reachedConsecutiveLimit || reachedTotalLimit)) {
          RUNTIME_CONTROLS.skipProvider = true;
          RUNTIME_CONTROLS.skipProviderReason = "auto";
          emitBenchEvent({
            type: "error",
            operation: label,
            statusCode: details.statusCode,
            message: reachedConsecutiveLimit
              ? `auto-skip provider after ${RATE_LIMIT_STATE.consecutiveEvents} consecutive throttling events`
              : `auto-skip provider after ${RATE_LIMIT_STATE.totalEvents} total throttling events`,
          });
          throw new Error(
            reachedConsecutiveLimit
              ? `Provider auto-skipped after repeated throttling (${RATE_LIMIT_STATE.consecutiveEvents} consecutive rate-limit errors)`
              : `Provider auto-skipped after repeated throttling (${RATE_LIMIT_STATE.totalEvents} total rate-limit errors)`,
          );
        }
      }
      emitBenchEvent({
        type: "error",
        operation: label,
        attempt: attempt + 1,
        totalAttempts: retries + 1,
        message: details.message,
        statusCode: details.statusCode,
      });
      await sleep(backoff);
    }
  }
  throw lastError;
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

function setupKeyboardControls() {
  if (!process.stdin.isTTY) return () => {};

  const onData = (chunk: Buffer) => {
    const key = chunk.toString("utf8").toLowerCase();
    if (key === "s") {
      RUNTIME_CONTROLS.skipPhase = true;
      emitBenchEvent({ type: "status", message: "Skip requested for current phase (s)" });
      console.log(color("\n[key] Skip requested for current phase", ANSI.yellow));
      return;
    }
    if (key === "p") {
      RUNTIME_CONTROLS.skipProvider = true;
      RUNTIME_CONTROLS.skipProviderReason = "user";
      emitBenchEvent({ type: "status", message: "Skip requested for current provider (p)" });
      console.log(color("\n[key] Skip requested for current provider", ANSI.yellow));
      return;
    }
    if (key === "q") {
      RUNTIME_CONTROLS.abortAll = true;
      emitBenchEvent({ type: "status", message: "Abort requested for full run (q)" });
      console.log(color("\n[key] Abort requested for full run", ANSI.red));
      return;
    }
    if (key === "h" || key === "?") {
      emitBenchEvent({ type: "status", message: "Controls: s=skip phase, p=skip provider, q=abort run" });
      console.log(color("\n[keys] s=skip phase, p=skip provider, q=abort run", ANSI.dim));
    }
  };

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", onData);

  return () => {
    process.stdin.off("data", onData);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  };
}

function randomBodyBytes(byteLength: number) {
  return randomBytes(byteLength);
}

async function ensureBucket(client: S3Client, bucket: string) {
  await withRetries("head_bucket", OP_RETRIES, async () => {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  });
}

async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array,
  metadata?: Record<string, string>,
) {
  await withRetries("put_object", OP_RETRIES, async () => {
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
  });
}

async function getObjectBytes(client: S3Client, bucket: string, key: string, range?: string) {
  const response = await withRetries("get_object", OP_RETRIES, async () =>
    client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: range,
      }),
    ),
  );
  if (!response.Body) return new Uint8Array();
  return await withTimeout("get_object_body", OP_TIMEOUT_MS, async () => response.Body!.transformToByteArray());
}

async function headObject(client: S3Client, bucket: string, key: string) {
  return await withRetries("head_object", OP_RETRIES, async () =>
    client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
  );
}

async function headObjectOnce(client: S3Client, bucket: string, key: string) {
  return await withTimeout("head_object_once", OP_TIMEOUT_MS, async () =>
    client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
  );
}

async function listObjectsV2(
  client: S3Client,
  input: ConstructorParameters<typeof ListObjectsV2Command>[0],
  label = "list_objects_v2",
) {
  return await withRetries(label, OP_RETRIES, async () => client.send(new ListObjectsV2Command(input)));
}

async function copyObject(
  client: S3Client,
  input: ConstructorParameters<typeof CopyObjectCommand>[0],
  label = "copy_object",
) {
  await withRetries(label, OP_RETRIES, async () => client.send(new CopyObjectCommand(input)));
}

async function deleteObject(client: S3Client, bucket: string, key: string) {
  await withRetries("delete_object", OP_RETRIES, async () => {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  });
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
  options?: { label?: string; provider?: string; phase?: string },
) {
  const errors: Array<{ index: number; error: TrialError }> = [];
  let completed = 0;
  let nextIndex = 0;
  let lastHeartbeat = 0;

  const emitHeartbeat = () => {
    const now = Date.now();
    if (now - lastHeartbeat < 1000) return;
    lastHeartbeat = now;
    const done = completed + errors.length;
    const total = items.length;
    const percent = total > 0 ? done / total : 1;
    emitBenchEvent({
      type: "progress",
      provider: options?.provider,
      phase: options?.phase,
      message: options?.label ? `${options.label} ${done}/${total}` : `batch ${done}/${total}`,
      percent,
      details: {
        done,
        total,
        completed,
        failed: errors.length,
      },
    });
  };

  emitHeartbeat();
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) {
      if (RUNTIME_CONTROLS.abortAll || RUNTIME_CONTROLS.skipProvider) return;
      const currentIndex = nextIndex;
      if (currentIndex >= items.length) return;
      nextIndex += 1;
      try {
        await worker(items[currentIndex], currentIndex);
        completed += 1;
        emitHeartbeat();
      } catch (error) {
        errors.push({ index: currentIndex, error: asErrorDetails(error) });
        emitHeartbeat();
      }
    }
  });
  await Promise.all(workers);
  emitBenchEvent({
    type: "progress",
    provider: options?.provider,
    phase: options?.phase,
    message: options?.label ? `${options.label} complete` : "batch complete",
    percent: 1,
    details: {
      done: completed + errors.length,
      total: items.length,
      completed,
      failed: errors.length,
      successRate: items.length ? completed / items.length : 1,
    },
  });
  return {
    total: items.length,
    completed,
    failed: errors.length,
    successRate: items.length ? completed / items.length : 1,
    errors,
  };
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
  emitBenchEvent({
    type: "status",
    provider: run.provider.name,
    operation,
    message: `${operation} started`,
  });
  const runningHeartbeat = setInterval(() => {
    emitBenchEvent({
      type: "status",
      provider: run.provider.name,
      operation,
      elapsedMs: performance.now() - startedPerf,
      message: `${operation} running ${formatMs(performance.now() - startedPerf)} (op timeout ${Math.round(
        OP_TIMEOUT_MS / 1000,
      )}s)`,
    });
  }, 1000);

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
    emitBenchEvent({
      type: "s3",
      provider: run.provider.name,
      operation,
      ok: true,
      elapsedMs: trial.ms,
      statusCode: trial.statusCode,
      message: `${operation} OK ${formatMs(trial.ms)}`,
    });
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
    emitBenchEvent({
      type: "s3",
      provider: run.provider.name,
      operation,
      ok: false,
      elapsedMs: trial.ms,
      statusCode: trial.error?.statusCode,
      message: `${operation} FAIL ${trial.error?.message ?? "unknown error"}`,
    });
    return trial;
  } finally {
    clearInterval(runningHeartbeat);
  }
}

async function recordProbe(
  run: ProviderRun,
  name: string,
  action: () => Promise<Record<string, unknown> | void>,
) {
  const startedPerf = performance.now();
  emitBenchEvent({
    type: "status",
    provider: run.provider.name,
    operation: `probe:${name}`,
    message: `probe:${name} started`,
  });
  const runningHeartbeat = setInterval(() => {
    emitBenchEvent({
      type: "status",
      provider: run.provider.name,
      operation: `probe:${name}`,
      elapsedMs: performance.now() - startedPerf,
      message: `probe:${name} running ${formatMs(performance.now() - startedPerf)} (op timeout ${Math.round(
        OP_TIMEOUT_MS / 1000,
      )}s)`,
    });
  }, 1000);
  try {
    const details: Record<string, unknown> | undefined = (await action()) ?? undefined;
    const probe: ProbeRecord = {
      name,
      ok: true,
      ms: performance.now() - startedPerf,
      details,
    };
    run.probes.push(probe);
    emitBenchEvent({
      type: "s3",
      provider: run.provider.name,
      operation: `probe:${name}`,
      ok: true,
      elapsedMs: probe.ms,
      message: `probe:${name} OK ${formatMs(probe.ms)}`,
    });
    return probe;
  } catch (error) {
    const probe: ProbeRecord = {
      name,
      ok: false,
      ms: performance.now() - startedPerf,
      error: asErrorDetails(error),
    };
    run.probes.push(probe);
    emitBenchEvent({
      type: "s3",
      provider: run.provider.name,
      operation: `probe:${name}`,
      ok: false,
      elapsedMs: probe.ms,
      statusCode: probe.error?.statusCode,
      message: `probe:${name} FAIL ${probe.error?.message ?? "unknown error"}`,
    });
    return probe;
  } finally {
    clearInterval(runningHeartbeat);
  }
}

async function runMultipartUpload(client: S3Client, bucket: string, key: string, body: Uint8Array) {
  const created = await withRetries("multipart_create", OP_RETRIES, async () =>
    client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })),
  );
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
      const part = await withRetries(`multipart_upload_part_${partNumber}`, OP_RETRIES, async () =>
        client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: partBody,
            ContentLength: partBody.byteLength,
          }),
        ),
      );
      uploadedParts.push({ ETag: part.ETag, PartNumber: partNumber });
    }

    await withRetries("multipart_complete", OP_RETRIES, async () =>
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: uploadedParts },
        }),
      ),
    );
  } catch (error) {
    await withRetries("multipart_abort", OP_RETRIES, async () =>
      client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
        }),
      ),
    );
    throw error;
  }
}


async function benchmarkProvider(
  provider: ProviderConfig,
  providerIndex: number,
  totalProviders: number,
  totals: ProgressTotals,
): Promise<ProviderRun> {
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
    config: BENCH_CONFIG,
    probes: [],
    trials: {},
    phaseTimingsMs: {},
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

  resetRateLimitState();
  const progress = new LiveProgress(provider.name);
  progress.start();
  const phaseStarted = new Map<string, number>();
  let phaseHeartbeatTimer: NodeJS.Timeout | null = null;
  let currentPhaseName: string | null = null;
  const skippedCategories = new Set<string>();
  const skippedPhases: string[] = [];
  const maybeMarkSkipped = (phaseName: string, categories: string[], reason: string) => {
    skippedPhases.push(`${phaseName}: ${reason}`);
    for (const category of categories) skippedCategories.add(category);
    run.notes.push(`Skipped ${phaseName}: ${reason}`);
    emitBenchEvent({
      type: "status",
      provider: provider.name,
      phase: phaseName,
      message: `Skipped ${phaseName}: ${reason}`,
    });
  };
  const shouldStopPhase = (phaseName: string, startedPerf: number) => {
    if (RUNTIME_CONTROLS.abortAll) throw new Error("Benchmark aborted by user (q)");
    if (RUNTIME_CONTROLS.skipProvider) {
      throw new Error(
        RUNTIME_CONTROLS.skipProviderReason === "user"
          ? "Provider skipped by user (p)"
          : "Provider skipped automatically by benchmark logic",
      );
    }
    if (RUNTIME_CONTROLS.skipPhase) {
      RUNTIME_CONTROLS.skipPhase = false;
      return "manual-skip";
    }
    if (PHASE_SOFT_TIMEOUT_MS > 0 && performance.now() - startedPerf > PHASE_SOFT_TIMEOUT_MS) {
      return `soft-timeout-${PHASE_SOFT_TIMEOUT_MS}ms`;
    }
    return null;
  };

  const printGlobalProgress = (phaseName: string) => {
    const percent = totals.totalPhases > 0 ? totals.completedPhases / totals.totalPhases : 0;
    const elapsed = performance.now() - totals.startedPerf;
    const eta = percent > 0 ? elapsed * (1 / percent - 1) : null;
    const text = `${progressBar(percent)} ETA ${formatEta(eta)} | provider ${providerIndex + 1}/${totalProviders} | phase ${phaseName}`;
    console.log(color(text, ANSI.blue));
    emitBenchEvent({
      type: "progress",
      provider: provider.name,
      phase: phaseName,
      message: text,
      percent,
      etaMs: eta,
      providerIndex: providerIndex + 1,
      totalProviders,
    });
  };

  const enterPhase = (name: string) => {
    phaseStarted.set(name, performance.now());
    currentPhaseName = name;
    progress.setStatus(name);
    printGlobalProgress(name);
    emitBenchEvent({
      type: "status",
      provider: provider.name,
      phase: name,
      message: `Entering phase: ${name}`,
      providerIndex: providerIndex + 1,
      totalProviders,
    });
    if (phaseHeartbeatTimer) clearInterval(phaseHeartbeatTimer);
    phaseHeartbeatTimer = setInterval(() => {
      if (!currentPhaseName) return;
      const started = phaseStarted.get(currentPhaseName);
      if (started == null) return;
      const phaseElapsed = performance.now() - started;
      const percent = totals.totalPhases > 0 ? totals.completedPhases / totals.totalPhases : 0;
      const elapsed = performance.now() - totals.startedPerf;
      const eta = percent > 0 ? elapsed * (1 / percent - 1) : null;
      emitBenchEvent({
        type: "progress",
        provider: provider.name,
        phase: currentPhaseName,
        message: `${currentPhaseName} running ${formatMs(phaseElapsed)}`,
        percent,
        etaMs: eta,
        providerIndex: providerIndex + 1,
        totalProviders,
        elapsedMs: phaseElapsed,
      });
    }, 1000);
  };
  const exitPhase = (name: string) => {
    const started = phaseStarted.get(name);
    if (phaseHeartbeatTimer) {
      clearInterval(phaseHeartbeatTimer);
      phaseHeartbeatTimer = null;
    }
    currentPhaseName = null;
    if (started != null) {
      run.phaseTimingsMs![name] = round2(performance.now() - started);
    }
    totals.completedPhases += 1;
    emitBenchEvent({
      type: "status",
      provider: provider.name,
      phase: name,
      message: `Completed phase: ${name}`,
      providerIndex: providerIndex + 1,
      totalProviders,
    });
  };

  try {

  enterPhase("bucket verification");
  await ensureBucket(client, provider.bucket);
  exitPhase("bucket verification");

  emitBenchEvent({
    type: "status",
    provider: provider.name,
    message: `Provider started: ${provider.name}`,
    providerIndex: providerIndex + 1,
    totalProviders,
  });
  console.log(`\n${color("===", ANSI.dim)} ${color(provider.name, ANSI.cyan)}`);
  console.log(`${color("Endpoint:", ANSI.dim)} ${provider.endpoint}`);
  console.log(`${color("Bucket:", ANSI.dim)} ${provider.bucket}`);
  console.log(`${color("Run ID:", ANSI.dim)} ${RUN_ID}`);

  enterPhase("capability probes");
  await recordProbe(run, "head_bucket", async () => {
    await ensureBucket(client, provider.bucket);
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
    const response = await headObject(client, provider.bucket, probeKey);
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
    await copyObject(client, {
      Bucket: provider.bucket,
      Key: copyKey,
      CopySource: `${provider.bucket}/${probeKey}`,
    });
    return { key: copyKey };
  });

  await recordProbe(run, "list_objects_v2", async () => {
    const response = await listObjectsV2(client, {
      Bucket: provider.bucket,
      Prefix: `${basePrefix}/capability/`,
      MaxKeys: 1000,
    });
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
  exitPhase("capability probes");

  enterPhase("single object baseline");
  const sizeEntries = [
    { label: "small", body: smallBody, hash: hashes.small },
    { label: "medium", body: mediumBody, hash: hashes.medium },
    { label: "large", body: largeBody, hash: hashes.large },
  ] as const;

  for (const entry of sizeEntries) {
    const baselinePhaseStarted = performance.now();
    const maybeStop = shouldStopPhase("single object baseline", baselinePhaseStarted);
    if (maybeStop) {
      maybeMarkSkipped("single object baseline", ["latency", "throughput", "consistency", "integrity"], maybeStop);
      break;
    }
    await repeat(REPEATS, async (trialIndex) => {
      const stopReason = shouldStopPhase("single object baseline", baselinePhaseStarted);
      if (stopReason) {
        maybeMarkSkipped("single object baseline", ["latency", "throughput", "consistency", "integrity"], stopReason);
        return;
      }
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
        const head = await headObject(client, provider.bucket, key);
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
          await headObjectOnce(client, provider.bucket, key);
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
  exitPhase("single object baseline");

  enterPhase("consistency checks");
  const consistencyPhaseStarted = performance.now();
  await repeat(REPEATS, async (trialIndex) => {
    const stopReason = shouldStopPhase("consistency checks", consistencyPhaseStarted);
    if (stopReason) {
      maybeMarkSkipped("consistency checks", ["consistency"], stopReason);
      return;
    }
    const key = `${basePrefix}/consistency/read-after-write-${String(trialIndex + 1).padStart(2, "0")}-${randomUUID()}.bin`;
    cleanupKeys.add(key);

    await putObject(client, provider.bucket, key, smallBody, { sha256: hashes.small });

    await recordTrial(run, "read_after_write_visibility", async () => {
      const elapsed = await waitForCondition(CONSISTENCY_TIMEOUT_MS, CONSISTENCY_POLL_MS, async () => {
        try {
          const head = await headObjectOnce(client, provider.bucket, key);
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
          await headObjectOnce(client, provider.bucket, key);
          return false;
        } catch (error) {
          return asErrorDetails(error).statusCode === 404;
        }
      });
      if (elapsed == null) throw new Error(`Delete did not propagate within ${CONSISTENCY_TIMEOUT_MS} ms`);
      return { details: { key, elapsedMs: elapsed } };
    });
  });
  exitPhase("consistency checks");

  enterPhase("missing key behavior");
  const missingPhaseStarted = performance.now();
  await repeat(MISSING_KEY_REPEATS, async (trialIndex) => {
    const stopReason = shouldStopPhase("missing key behavior", missingPhaseStarted);
    if (stopReason) {
      maybeMarkSkipped("missing key behavior", ["integrity"], stopReason);
      return;
    }
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
        await headObjectOnce(client, provider.bucket, missingKey);
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
  exitPhase("missing key behavior");

  enterPhase("heavy stress cycles");
  const heavyPhaseStarted = performance.now();
  await repeat(HEAVY_REPEATS, async (heavyIndex) => {
    const stopReason = shouldStopPhase("heavy stress cycles", heavyPhaseStarted);
    if (stopReason) {
      maybeMarkSkipped("heavy stress cycles", ["throughput", "scalability", "consistency"], stopReason);
      return;
    }
    const cycle = heavyIndex + 1;
    const cycleLabel = `cycle-${String(cycle).padStart(2, "0")}`;

    const parallelUploadPrefix = `${basePrefix}/parallel/${cycleLabel}`;
    const parallelKeys: string[] = [];

    const parallelUploadTrial = await recordTrial(run, "parallel_upload_batch", async () => {
      const outcome = await mapWithConcurrency(
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
        { label: `parallel upload cycle ${cycle}`, provider: provider.name, phase: "heavy stress cycles" },
      );
      if (outcome.successRate < BATCH_MIN_SUCCESS_RATE) {
        throw new Error(
          `parallel_upload_batch success rate ${(outcome.successRate * 100).toFixed(1)}% is below ${(BATCH_MIN_SUCCESS_RATE * 100).toFixed(1)}%`,
        );
      }
      return {
        bytes: outcome.completed * smallBody.byteLength,
        details: {
          requested: PARALLEL_UPLOADS,
          completed: outcome.completed,
          failed: outcome.failed,
          successRate: outcome.successRate,
          cycle,
          sampleErrors: outcome.errors.slice(0, 3),
        },
      };
    });
    setTrialThroughput(parallelUploadTrial, numberOrZero(parallelUploadTrial.bytes));

    const parallelReadTrial = await recordTrial(run, "parallel_read_batch", async () => {
      const outcome = await mapWithConcurrency(parallelKeys, PARALLEL_READS, async (key) => {
        const bytes = await getObjectBytes(client, provider.bucket, key);
        const hash = sha256Hex(bytes);
        if (hash !== hashes.small) {
          throw new Error(`Parallel read integrity mismatch for ${key}`);
        }
      }, { label: `parallel read cycle ${cycle}`, provider: provider.name, phase: "heavy stress cycles" });
      if (outcome.successRate < BATCH_MIN_SUCCESS_RATE) {
        throw new Error(
          `parallel_read_batch success rate ${(outcome.successRate * 100).toFixed(1)}% is below ${(BATCH_MIN_SUCCESS_RATE * 100).toFixed(1)}%`,
        );
      }
      return {
        bytes: outcome.completed * smallBody.byteLength,
        details: {
          requested: parallelKeys.length,
          completed: outcome.completed,
          failed: outcome.failed,
          successRate: outcome.successRate,
          cycle,
          sampleErrors: outcome.errors.slice(0, 3),
        },
      };
    });
    setTrialThroughput(parallelReadTrial, numberOrZero(parallelReadTrial.bytes));

    await recordTrial(run, "parallel_delete_batch", async () => {
      const outcome = await mapWithConcurrency(parallelKeys, PARALLEL_DELETES, async (key) => {
        await deleteObject(client, provider.bucket, key);
      }, { label: `parallel delete cycle ${cycle}`, provider: provider.name, phase: "heavy stress cycles" });
      if (outcome.successRate < BATCH_MIN_SUCCESS_RATE) {
        throw new Error(
          `parallel_delete_batch success rate ${(outcome.successRate * 100).toFixed(1)}% is below ${(BATCH_MIN_SUCCESS_RATE * 100).toFixed(1)}%`,
        );
      }
      return {
        details: {
          requested: parallelKeys.length,
          completed: outcome.completed,
          failed: outcome.failed,
          successRate: outcome.successRate,
          cycle,
          sampleErrors: outcome.errors.slice(0, 3),
        },
      };
    });

    const manyPrefix = `${basePrefix}/many/${cycleLabel}`;
    const manyKeys = Array.from(
      { length: MANY_OBJECTS_COUNT },
      (_, index) => `${manyPrefix}/obj-${String(index).padStart(8, "0")}.bin`,
    );

    const seedTrial = await recordTrial(run, "seed_many_objects", async () => {
      const outcome = await mapWithConcurrency(manyKeys, PARALLEL_UPLOADS, async (key) => {
        cleanupKeys.add(key);
        await putObject(client, provider.bucket, key, tinyBody, {
          sha256: hashes.tiny,
          cycle: String(cycle),
          group: "many",
        });
      }, { label: `seed many objects cycle ${cycle}`, provider: provider.name, phase: "heavy stress cycles" });
      if (outcome.successRate < BATCH_MIN_SUCCESS_RATE) {
        throw new Error(
          `seed_many_objects success rate ${(outcome.successRate * 100).toFixed(1)}% is below ${(BATCH_MIN_SUCCESS_RATE * 100).toFixed(1)}%`,
        );
      }
      return {
        bytes: outcome.completed * tinyBody.byteLength,
        details: {
          requested: manyKeys.length,
          completed: outcome.completed,
          failed: outcome.failed,
          successRate: outcome.successRate,
          count: outcome.completed,
          cycle,
          sampleErrors: outcome.errors.slice(0, 3),
        },
      };
    });
    setTrialThroughput(seedTrial, numberOrZero(seedTrial.bytes));

    await recordTrial(run, "list_single_page", async () => {
      const response = await listObjectsV2(client, {
        Bucket: provider.bucket,
        Prefix: manyPrefix,
        MaxKeys: 1000,
      });
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
        const page = await listObjectsV2(
          client,
          {
            Bucket: provider.bucket,
            Prefix: manyPrefix,
            MaxKeys: 1000,
            ContinuationToken: continuationToken,
          },
          "list_objects_v2_deep_scan",
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
      const outcome = await mapWithConcurrency(manyKeys, PARALLEL_DELETES, async (key) => {
        await deleteObject(client, provider.bucket, key);
      }, { label: `delete many objects cycle ${cycle}`, provider: provider.name, phase: "heavy stress cycles" });
      if (outcome.successRate < BATCH_MIN_SUCCESS_RATE) {
        throw new Error(
          `parallel_delete_many_objects success rate ${(outcome.successRate * 100).toFixed(1)}% is below ${(BATCH_MIN_SUCCESS_RATE * 100).toFixed(1)}%`,
        );
      }
      return {
        details: {
          requested: manyKeys.length,
          completed: outcome.completed,
          failed: outcome.failed,
          successRate: outcome.successRate,
          count: outcome.completed,
          cycle,
          sampleErrors: outcome.errors.slice(0, 3),
        },
      };
    });
  });
  exitPhase("heavy stress cycles");

  if (!KEEP_TEST_DATA) {
    enterPhase("cleanup");
    await mapWithConcurrency([...cleanupKeys], PARALLEL_DELETES, async (key) => {
      try {
        await deleteObject(client, provider.bucket, key);
      } catch {
        // Deliberately ignore cleanup errors.
      }
    }, { label: "cleanup objects", provider: provider.name, phase: "cleanup" });
    exitPhase("cleanup");
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
    skippedPhases,
    skippedCategoryCount: skippedCategories.size,
    skippedCategories: [...skippedCategories],
    abortedByUser: RUNTIME_CONTROLS.abortAll,
  };

  console.log(`${color("Capability success:", ANSI.dim)} ${(capabilitySuccessRate * 100).toFixed(1)}%`);
  console.log(`${color("Small upload median:", ANSI.dim)} ${formatMs(aggregates["upload_small"]?.medianMs)} | ${formatMiBs(aggregates["upload_small"]?.medianThroughputMiBs)}`);
  console.log(`${color("Large download median:", ANSI.dim)} ${formatMs(aggregates["download_large"]?.medianMs)} | ${formatMiBs(aggregates["download_large"]?.medianThroughputMiBs)}`);
  console.log(`${color("Parallel upload aggregate:", ANSI.dim)} ${formatMiBs(run.derived.parallelUploadAggregateMiBsPerSec as number | null)}`);
  console.log(`${color("Parallel read aggregate:", ANSI.dim)} ${formatMiBs(run.derived.parallelReadAggregateMiBsPerSec as number | null)}`);
  console.log(`${color("Deep list rate:", ANSI.dim)} ${numberOrNull(run.derived.listObjectsPerSecond)?.toFixed(0) ?? "n/a"} obj/s`);
  console.log(`${color("Seed-many rate:", ANSI.dim)} ${numberOrNull(run.derived.seedObjectsPerSecond)?.toFixed(0) ?? "n/a"} obj/s`);

  run.status = "ok";
  progress.complete(true, "benchmark completed");

  return run;
  } catch (error) {
    const details = asErrorDetails(error);
    emitBenchEvent({
      type: "error",
      provider: provider.name,
      phase: currentPhaseName ?? undefined,
      message: details.message,
      statusCode: details.statusCode,
    });
    if (!KEEP_TEST_DATA && cleanupKeys.size > 0) {
      enterPhase("cleanup-after-failure");
      await mapWithConcurrency([...cleanupKeys], PARALLEL_DELETES, async (key) => {
        try {
          await deleteObject(client, provider.bucket, key);
        } catch {
          // Ignore cleanup failures in error path.
        }
      }, { label: "cleanup after failure", provider: provider.name, phase: "cleanup-after-failure" });
      exitPhase("cleanup-after-failure");
    }
    if (phaseHeartbeatTimer) {
      clearInterval(phaseHeartbeatTimer);
      phaseHeartbeatTimer = null;
    }
    run.status = "failed";
    run.fatalError = details;
    run.notes.push(details.message);
    run.completedAtUtc = new Date().toISOString();
    progress.complete(false, details.message);
    throw error;
  }
}

export async function main() {

  const runDir = join(OUTPUT_DIR, RUN_ID);
  await mkdir(runDir, { recursive: true });
  const selectedProviders =
    PROVIDER_FILTER.length > 0
      ? PROVIDERS.filter((provider) =>
          PROVIDER_FILTER.some((needle) =>
            provider.name.toLowerCase().includes(needle) ||
            provider.endpoint.toLowerCase().includes(needle) ||
            provider.bucket.toLowerCase().includes(needle),
          ),
        )
      : PROVIDERS;

  if (selectedProviders.length === 0) {
    throw new Error(`No providers matched S3_BENCH_PROVIDER_FILTER=${PROVIDER_FILTER.join(",")}`);
  }

  console.log(
    `${color("Running heavy S3 benchmark", ANSI.cyan)} | run=${RUN_ID} | providers=${selectedProviders.length} | repeats=${REPEATS} | heavyRepeats=${HEAVY_REPEATS} | sizes=${SMALL_SIZE_MB}/${MEDIUM_SIZE_MB}/${LARGE_SIZE_MB} MiB | manyObjects=${MANY_OBJECTS_COUNT.toLocaleString()} | listTarget=${LIST_TARGET.toLocaleString()}${PROVIDER_FILTER.length > 0 ? ` | filter=${PROVIDER_FILTER.join(",")}` : ""}`,
  );
  emitBenchEvent({
    type: "status",
    message: `Run started ${RUN_ID}`,
    details: {
      runId: RUN_ID,
      providers: selectedProviders.length,
      repeats: REPEATS,
      heavyRepeats: HEAVY_REPEATS,
      sizesMiB: [SMALL_SIZE_MB, MEDIUM_SIZE_MB, LARGE_SIZE_MB],
    },
  });

  const runs: ProviderRun[] = [];
  const totals: ProgressTotals = {
    totalPhases: selectedProviders.length * 6,
    completedPhases: 0,
    startedPerf: performance.now(),
  };

  console.log(color("controls: s=skip phase, p=skip provider, q=abort run, h=help", ANSI.dim));
  const teardownKeys = setupKeyboardControls();

  try {
    for (const [providerIndex, provider] of selectedProviders.entries()) {
      if (RUNTIME_CONTROLS.abortAll) {
        break;
      }
    RUNTIME_CONTROLS.skipProvider = false;
    RUNTIME_CONTROLS.skipProviderReason = null;
    RUNTIME_CONTROLS.skipPhase = false;
    try {
      const run = await benchmarkProvider(provider, providerIndex, selectedProviders.length, totals);
      runs.push(run);
      emitBenchEvent({
        type: "status",
        provider: provider.name,
        message: `Provider completed ${provider.name}`,
      });

      const folder = providerFolder(runDir, provider.name);
      await mkdir(folder, { recursive: true });
      await saveJson(join(folder, "raw.json"), run);
    } catch (error) {
      const details = asErrorDetails(error);
      console.error(
        `\n${color("===", ANSI.dim)} ${color(provider.name, ANSI.red)} ${color("FAILED", ANSI.red)} ${color(details.message, ANSI.red)}`,
      );
      emitBenchEvent({
        type: "error",
        provider: provider.name,
        message: details.message,
        statusCode: details.statusCode,
      });

      const now = new Date().toISOString();

      const failedRun: ProviderRun = {
        provider: {
          name: provider.name,
          region: provider.region,
          endpoint: provider.endpoint,
          bucket: provider.bucket,
        },
        runId: RUN_ID,
        startedAtUtc: now,
        completedAtUtc: now,
        status: "failed",
        config: BENCH_CONFIG,
        probes: [],
        trials: {},
        fatalError: details,
        notes: [details.message],
      };

      runs.push(failedRun);
      const folder = providerFolder(runDir, provider.name);
      await mkdir(folder, { recursive: true });
      await saveJson(join(folder, "raw.json"), failedRun);
    }
  }
  } finally {
    teardownKeys();
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
  emitBenchEvent({
    type: "status",
    message: `Run completed ${RUN_ID}`,
    details: { runDir },
  });
}

function isDirectEngineInvocation(): boolean {
  const entry = process.argv[1] ?? "";
  if (!entry) return false;
  const normalized = entry.replace(/\\/g, "/");
  return normalized.endsWith("/scripts/bench-cli/engine.ts");
}

if (isDirectEngineInvocation()) {
  void main();
}
