import { createHash } from "node:crypto";
import type { AggregateStats, ScoreDirection, TrialError, TrialRecord } from "./engine-model";

export const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

export function color(value: string, code: string) {
  return `${code}${value}${ANSI.reset}`;
}

export function isInteractiveTty() {
  return Boolean(process.stdout.isTTY && process.env.CI !== "true");
}

export function safeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function bytesFromMb(sizeMb: number) {
  return Math.round(sizeMb * 1024 * 1024);
}

export function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatMs(value: number | null | undefined) {
  if (value == null) return "n/a";
  return `${value.toFixed(value >= 100 ? 0 : 1)} ms`;
}

export function formatEta(valueMs: number | null) {
  if (valueMs == null || !Number.isFinite(valueMs) || valueMs < 0) return "n/a";
  const totalSec = Math.round(valueMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function progressBar(percent: number, width = 24) {
  const clamped = clamp(percent, 0, 1);
  const done = Math.round(clamped * width);
  return `[${"=".repeat(done)}${"-".repeat(width - done)}] ${(clamped * 100).toFixed(1)}%`;
}

export function formatMiBs(value: number | null | undefined) {
  if (value == null) return "n/a";
  return `${value.toFixed(2)} MiB/s`;
}

export function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function numberOrZero(value: unknown) {
  return numberOrNull(value) ?? 0;
}

export function weightedAverage(items: Array<{ value: number; weight: number }>) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (!totalWeight) return 0;
  return items.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
}

export function maybeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function mean(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function stdev(values: number[]) {
  if (values.length < 2) return null;
  const avg = mean(values)!;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function summarizeTrials(trials: TrialRecord[]): AggregateStats {
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

export function asErrorDetails(error: unknown): TrialError {
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

export function scoreFromRelative(values: Array<{ key: string; value: number | null }>, direction: ScoreDirection) {
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
