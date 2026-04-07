import type { ProviderSummary } from "./engine-model";
import {
  HEAVY_REPEATS,
  LARGE_SIZE_MB,
  LIST_TARGET,
  MANY_OBJECTS_COUNT,
  MANY_OBJECTS_SIZE_BYTES,
  MEDIUM_SIZE_MB,
  PARALLEL_DELETES,
  PARALLEL_READS,
  PARALLEL_UPLOADS,
  REPEATS,
  RUN_ID,
  SMALL_SIZE_MB,
} from "./engine-settings";
import {
  asStringArray,
  clamp,
  formatBytes,
  formatMiBs,
  formatMs,
  numberOrNull,
  numberOrZero,
  round2,
  safeName,
  scoreFromRelative,
  weightedAverage,
} from "./engine-utils";

export function toSummary(run: {
  provider: { name: string };
  aggregates?: ProviderSummary["aggregates"];
  derived?: ProviderSummary["derived"];
  scores?: ProviderSummary["scores"];
}): ProviderSummary {
  return {
    name: run.provider.name,
    providerKey: safeName(run.provider.name),
    aggregates: run.aggregates ?? {},
    derived: run.derived ?? {},
    scores: run.scores,
  };
}

export function computeScores(summaries: ProviderSummary[]) {
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

    const skippedCategories = new Set(asStringArray(summary.derived.skippedCategories));

    let capability = clamp(numberOrZero(summary.derived.capabilitySuccessRate) * 100, 0, 100);
    const integrity = clamp(
      weightedAverage([
        { value: numberOrZero(summary.derived.integritySuccessRate) * 100, weight: 0.6 },
        { value: numberOrZero(summary.derived.deleteValidationSuccessRate) * 100, weight: 0.2 },
        { value: numberOrZero(summary.derived.missingReadExpectedErrorRate) * 100, weight: 0.2 },
      ]),
      0,
      100,
    );

    let latency =
      weightedAverage([
        { value: latencyHead.get(key) ?? 0, weight: 0.2 },
        { value: latencyUpload.get(key) ?? 0, weight: 0.3 },
        { value: latencyDownload.get(key) ?? 0, weight: 0.3 },
        { value: latencyDelete.get(key) ?? 0, weight: 0.2 },
      ]) * failurePenalty;

    let throughput =
      weightedAverage([
        { value: throughputUpload.get(key) ?? 0, weight: 0.3 },
        { value: throughputDownload.get(key) ?? 0, weight: 0.3 },
        { value: throughputParallelUpload.get(key) ?? 0, weight: 0.2 },
        { value: throughputParallelRead.get(key) ?? 0, weight: 0.2 },
      ]) * failurePenalty;

    let consistency =
      weightedAverage([
        { value: consistencyCv.get(key) ?? 0, weight: 0.4 },
        { value: consistencyVisibility.get(key) ?? 0, weight: 0.3 },
        { value: consistencyDelete.get(key) ?? 0, weight: 0.3 },
      ]) * failurePenalty;

    let scalability =
      weightedAverage([
        { value: scalabilityList.get(key) ?? 0, weight: 0.45 },
        { value: scalabilitySeed.get(key) ?? 0, weight: 0.25 },
        { value: scalabilityDelete.get(key) ?? 0, weight: 0.3 },
      ]) * failurePenalty;

    let integrityAdjusted = integrity;
    if (skippedCategories.has("capability")) capability = 0;
    if (skippedCategories.has("latency")) latency = 0;
    if (skippedCategories.has("throughput")) throughput = 0;
    if (skippedCategories.has("consistency")) consistency = 0;
    if (skippedCategories.has("scalability")) scalability = 0;
    if (skippedCategories.has("integrity")) integrityAdjusted = 0;

    const overall = weightedAverage([
      { value: capability, weight: 0.12 },
      { value: latency, weight: 0.20 },
      { value: throughput, weight: 0.24 },
      { value: consistency, weight: 0.18 },
      { value: scalability, weight: 0.16 },
      { value: integrityAdjusted, weight: 0.10 },
    ]);

    summary.scores = {
      capability: round2(capability),
      latency: round2(latency),
      throughput: round2(throughput),
      consistency: round2(consistency),
      scalability: round2(scalability),
      integrity: round2(integrityAdjusted),
      overall: round2(overall),
    };
  }
}

export function buildMarkdownReport(summaries: ProviderSummary[]) {
  const ranked = [...summaries].sort((a, b) => (b.scores?.overall ?? 0) - (a.scores?.overall ?? 0));
  const lines: string[] = [];

  lines.push(`# S3 benchmark report`);
  lines.push("");
  lines.push(`Run ID: ${RUN_ID}`);
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`## Configuration`);
  lines.push(`- Repeats per single-object test: ${REPEATS}`);
  lines.push(`- Heavy workload repeats: ${HEAVY_REPEATS}`);
  lines.push(`- Object sizes: small=${SMALL_SIZE_MB} MiB, medium=${MEDIUM_SIZE_MB} MiB, large=${LARGE_SIZE_MB} MiB`);
  lines.push(`- Parallel uploads=${PARALLEL_UPLOADS}, reads=${PARALLEL_READS}, deletes=${PARALLEL_DELETES}`);
  lines.push(`- Many-object test count=${MANY_OBJECTS_COUNT.toLocaleString()}, payload=${formatBytes(MANY_OBJECTS_SIZE_BYTES)}`);
  lines.push(`- Deep list target=${LIST_TARGET.toLocaleString()} objects`);
  lines.push("");
  lines.push(`## Ranking`);
  lines.push(`| Rank | Provider | Overall | Capability | Latency | Throughput | Consistency | Scalability | Integrity |`);
  lines.push(`| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);

  for (const [index, summary] of ranked.entries()) {
    lines.push(
      `| ${index + 1} | ${summary.name} | ${(summary.scores?.overall ?? 0).toFixed(2)} | ${(summary.scores?.capability ?? 0).toFixed(2)} | ${(summary.scores?.latency ?? 0).toFixed(2)} | ${(summary.scores?.throughput ?? 0).toFixed(2)} | ${(summary.scores?.consistency ?? 0).toFixed(2)} | ${(summary.scores?.scalability ?? 0).toFixed(2)} | ${(summary.scores?.integrity ?? 0).toFixed(2)} |`,
    );
  }

  lines.push("");
  for (const summary of ranked) {
    lines.push(`## ${summary.name}`);
    lines.push("");
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
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
