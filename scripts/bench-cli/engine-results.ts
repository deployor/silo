import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderRun, TrialRecord } from "./engine-model";
import { numberOrNull, safeName } from "./engine-utils";

export function providerFolder(baseDir: string, providerName: string) {
  return join(baseDir, safeName(providerName));
}

export async function saveJson(filepath: string, value: unknown) {
  await mkdir(dirname(filepath), { recursive: true });
  await writeFile(filepath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function setTrialThroughput(trial: TrialRecord, bytes: number) {
  if (trial.ok && trial.ms > 0) {
    trial.bytes = bytes;
    trial.throughputMiBs = (bytes / 1024 / 1024) / (trial.ms / 1000);
  }
}

export function getFirstDetailNumber(run: ProviderRun, operation: string, detailKey: string) {
  const trial = (run.trials[operation] ?? []).find((entry) => entry.ok && typeof entry.details?.[detailKey] === "number");
  return numberOrNull(trial?.details?.[detailKey]);
}
