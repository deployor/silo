import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Aggregates = Record<
  string,
  {
    medianMs?: number | null;
    medianThroughputMiBs?: number | null;
    successRate?: number | null;
    cv?: number | null;
  }
>;

type Derived = Record<string, number | string | boolean | null | undefined>;

type Scores = {
  capability?: number | null;
  latency?: number | null;
  throughput?: number | null;
  consistency?: number | null;
  scalability?: number | null;
  integrity?: number | null;
  overall?: number | null;
};

type ProviderSummary = {
  name: string;
  aggregates?: Aggregates;
  derived?: Derived;
  scores?: Scores;
};

type RankingEntry = {
  rank: number;
  provider: string;
  scores?: Scores;
};

type ProviderInsight = {
  provider: string;
  rank: number | null;
  overall: number | null;
  strengths: string[];
  weaknesses: string[];
  weirdSignals: string[];
  highlights: Record<string, number | null>;
};

type StudyInsights = {
  runDir: string;
  generatedAtUtc: string;
  winner: string | null;
  ranking: Array<{ provider: string; rank: number; overall: number | null }>;
  categoryWinners: Record<string, string | null>;
  providerInsights: ProviderInsight[];
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function maybePct(value: number | null): string {
  if (value == null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function fmt(value: number | null, digits = 2): string {
  if (value == null) return "n/a";
  return value.toFixed(digits);
}

function bestBy(
  rows: ProviderSummary[],
  pick: (row: ProviderSummary) => number | null,
  direction: "higher" | "lower",
): string | null {
  let bestName: string | null = null;
  let bestValue: number | null = null;

  for (const row of rows) {
    const value = pick(row);
    if (value == null) continue;
    if (bestValue == null) {
      bestValue = value;
      bestName = row.name;
      continue;
    }
    const better = direction === "higher" ? value > bestValue : value < bestValue;
    if (better) {
      bestValue = value;
      bestName = row.name;
    }
  }

  return bestName;
}

function rankLookup(ranking: RankingEntry[]): Map<string, RankingEntry> {
  return new Map(ranking.map((entry) => [entry.provider, entry]));
}

function buildProviderInsight(summary: ProviderSummary, rankingMap: Map<string, RankingEntry>): ProviderInsight {
  const aggregates = summary.aggregates ?? {};
  const derived = summary.derived ?? {};
  const scores = summary.scores ?? {};
  const rankEntry = rankingMap.get(summary.name);

  const capability = num(derived.capabilitySuccessRate);
  const failureRate = num(derived.coreFailureRate);
  const cv = num(derived.coreMedianCv);
  const vis = num(derived.visibilityMedianMs);
  const delProp = num(derived.deletePropagationMedianMs);
  const uploadLarge = num(aggregates.upload_large?.medianThroughputMiBs);
  const downloadLarge = num(aggregates.download_large?.medianThroughputMiBs);
  const parallelUpload = num(derived.parallelUploadAggregateMiBsPerSec);
  const parallelRead = num(derived.parallelReadAggregateMiBsPerSec);
  const listRate = num(derived.listObjectsPerSecond);
  const seedRate = num(derived.seedObjectsPerSecond);
  const deleteRate = num(derived.parallelDeletesPerSecond);

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const weirdSignals: string[] = [];

  if (capability != null && capability >= 0.98) strengths.push("Near-perfect capability probe coverage");
  if (failureRate != null && failureRate <= 0.03) strengths.push("Very low core operation failure rate");
  if (parallelUpload != null && parallelUpload >= 700) strengths.push("Excellent parallel upload throughput");
  if (parallelRead != null && parallelRead >= 700) strengths.push("Excellent parallel read throughput");
  if (listRate != null && listRate >= 6000) strengths.push("Strong deep-list scalability");

  if (failureRate != null && failureRate >= 0.1) weaknesses.push("Core operation failures are elevated");
  if (cv != null && cv >= 0.35) weaknesses.push("Latency/throughput variance is high");
  if (vis != null && vis >= 1200) weaknesses.push("Read-after-write visibility is relatively slow");
  if (delProp != null && delProp >= 1200) weaknesses.push("Delete propagation is relatively slow");
  if (uploadLarge != null && uploadLarge <= 20) weaknesses.push("Large upload throughput is low");
  if (downloadLarge != null && downloadLarge <= 20) weaknesses.push("Large download throughput is low");

  const uploadReadRatio =
    parallelUpload != null && parallelRead != null && parallelRead > 0 ? parallelUpload / parallelRead : null;
  if (uploadReadRatio != null && uploadReadRatio >= 1.8) {
    weirdSignals.push("Uploads are much faster than reads under concurrency");
  }
  if (uploadReadRatio != null && uploadReadRatio <= 0.55) {
    weirdSignals.push("Reads are much faster than uploads under concurrency");
  }

  if (seedRate != null && listRate != null && seedRate > 0) {
    const ratio = listRate / seedRate;
    if (ratio >= 2.2) weirdSignals.push("Listing is disproportionately faster than object creation");
    if (ratio <= 0.45) weirdSignals.push("Object creation is disproportionately faster than listing");
  }

  if (deleteRate != null && parallelRead != null && parallelRead > 0) {
    const delta = deleteRate / parallelRead;
    if (delta >= 3) weirdSignals.push("Deletes scale much more aggressively than reads");
  }

  if (strengths.length === 0) strengths.push("No standout top-tier strengths detected in this run");
  if (weaknesses.length === 0) weaknesses.push("No major weakness signal crossed configured thresholds");
  if (weirdSignals.length === 0) weirdSignals.push("No unusual behavior pattern crossed anomaly thresholds");

  return {
    provider: summary.name,
    rank: rankEntry?.rank ?? null,
    overall: num(scores.overall),
    strengths,
    weaknesses,
    weirdSignals,
    highlights: {
      capabilitySuccessRate: capability,
      coreFailureRate: failureRate,
      coreMedianCv: cv,
      visibilityMedianMs: vis,
      deletePropagationMedianMs: delProp,
      uploadLargeMiBs: uploadLarge,
      downloadLargeMiBs: downloadLarge,
      parallelUploadMiBs: parallelUpload,
      parallelReadMiBs: parallelRead,
      listObjectsPerSecond: listRate,
      seedObjectsPerSecond: seedRate,
      parallelDeletesPerSecond: deleteRate,
    },
  };
}

function buildMarkdown(insights: StudyInsights, summaries: ProviderSummary[]): string {
  const lines: string[] = [];

  lines.push("# Deep Study Report");
  lines.push("");
  lines.push(`Run: ${insights.runDir}`);
  lines.push(`Generated at: ${insights.generatedAtUtc}`);
  lines.push(`Winner: ${insights.winner ?? "n/a"}`);
  lines.push("");

  lines.push("## Ranking Snapshot");
  lines.push("| Rank | Provider | Overall | Capability | Latency | Throughput | Consistency | Scalability | Integrity |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

  for (const entry of insights.ranking) {
    const row = summaries.find((summary) => summary.name === entry.provider);
    const score = row?.scores ?? {};
    lines.push(
      `| ${entry.rank} | ${entry.provider} | ${fmt(entry.overall)} | ${fmt(num(score.capability))} | ${fmt(num(score.latency))} | ${fmt(num(score.throughput))} | ${fmt(num(score.consistency))} | ${fmt(num(score.scalability))} | ${fmt(num(score.integrity))} |`,
    );
  }

  lines.push("");
  lines.push("## Category Winners");
  for (const [category, winner] of Object.entries(insights.categoryWinners)) {
    lines.push(`- ${category}: ${winner ?? "n/a"}`);
  }

  lines.push("");
  lines.push("## Provider Deep Dive");
  for (const provider of insights.providerInsights) {
    lines.push("");
    lines.push(`### ${provider.provider}`);
    lines.push(`- Rank: ${provider.rank ?? "n/a"}`);
    lines.push(`- Overall: ${fmt(provider.overall)}`);
    lines.push(`- Strengths: ${provider.strengths.join("; ")}`);
    lines.push(`- Weaknesses: ${provider.weaknesses.join("; ")}`);
    lines.push(`- Weird signals: ${provider.weirdSignals.join("; ")}`);
    lines.push(`- Capability success: ${maybePct(num(provider.highlights.capabilitySuccessRate))}`);
    lines.push(`- Core failure rate: ${maybePct(num(provider.highlights.coreFailureRate))}`);
    lines.push(`- Core variability (CV): ${fmt(num(provider.highlights.coreMedianCv), 3)}`);
    lines.push(`- Visibility median (ms): ${fmt(num(provider.highlights.visibilityMedianMs))}`);
    lines.push(`- Delete propagation median (ms): ${fmt(num(provider.highlights.deletePropagationMedianMs))}`);
    lines.push(`- Large upload (MiB/s): ${fmt(num(provider.highlights.uploadLargeMiBs))}`);
    lines.push(`- Large download (MiB/s): ${fmt(num(provider.highlights.downloadLargeMiBs))}`);
    lines.push(`- Parallel upload (MiB/s): ${fmt(num(provider.highlights.parallelUploadMiBs))}`);
    lines.push(`- Parallel read (MiB/s): ${fmt(num(provider.highlights.parallelReadMiBs))}`);
    lines.push(`- Deep list rate (obj/s): ${fmt(num(provider.highlights.listObjectsPerSecond))}`);
    lines.push(`- Seed-many rate (obj/s): ${fmt(num(provider.highlights.seedObjectsPerSecond))}`);
    lines.push(`- Delete-many rate (obj/s): ${fmt(num(provider.highlights.parallelDeletesPerSecond))}`);
  }

  lines.push("");
  lines.push("## Story Angles for Writeup");
  lines.push("- Which provider wins overall, and whether category leadership is concentrated or split.");
  lines.push("- Cases where throughput leadership does not align with consistency or integrity.");
  lines.push("- Any asymmetry between read and write performance under parallel load.");
  lines.push("- Scalability shape across list/seed/delete rates.");
  lines.push("- Reliability and variance tradeoffs, not just raw speed.");

  return `${lines.join("\n")}\n`;
}

export async function generateStudyArtifacts(resultsDir: string, runDir: string): Promise<{ mdPath: string; jsonPath: string }> {
  const rankingPath = join(resultsDir, runDir, "ranking.json");
  const allResultsPath = join(resultsDir, runDir, "all-results.json");

  const rankingRaw = await readFile(rankingPath, "utf8");
  const allResultsRaw = await readFile(allResultsPath, "utf8");

  const parsedRanking = JSON.parse(rankingRaw) as RankingEntry[];
  const parsedAllResults = JSON.parse(allResultsRaw) as ProviderSummary[];

  const ranking = Array.isArray(parsedRanking)
    ? parsedRanking
        .map((entry) => ({
          rank: num(entry.rank) ?? 0,
          provider: entry.provider,
          scores: entry.scores,
        }))
        .filter((entry) => entry.rank > 0 && typeof entry.provider === "string")
    : [];

  const summaries = Array.isArray(parsedAllResults) ? parsedAllResults : [];
  const rankingMap = rankLookup(ranking);

  const categoryWinners = {
    capability: bestBy(summaries, (row) => num(row.scores?.capability), "higher"),
    latency: bestBy(summaries, (row) => num(row.scores?.latency), "higher"),
    throughput: bestBy(summaries, (row) => num(row.scores?.throughput), "higher"),
    consistency: bestBy(summaries, (row) => num(row.scores?.consistency), "higher"),
    scalability: bestBy(summaries, (row) => num(row.scores?.scalability), "higher"),
    integrity: bestBy(summaries, (row) => num(row.scores?.integrity), "higher"),
    overall: bestBy(summaries, (row) => num(row.scores?.overall), "higher"),
  };

  const providerInsights = summaries.map((summary) => buildProviderInsight(summary, rankingMap));

  const insights: StudyInsights = {
    runDir,
    generatedAtUtc: new Date().toISOString(),
    winner: ranking[0]?.provider ?? categoryWinners.overall,
    ranking: ranking.map((entry) => ({
      provider: entry.provider,
      rank: entry.rank,
      overall: num(entry.scores?.overall),
    })),
    categoryWinners,
    providerInsights,
  };

  const reportMd = buildMarkdown(insights, summaries);

  const mdPath = join(resultsDir, runDir, "study-report.md");
  const jsonPath = join(resultsDir, runDir, "study-insights.json");
  await writeFile(mdPath, reportMd, "utf8");
  await writeFile(jsonPath, `${JSON.stringify(insights, null, 2)}\n`, "utf8");

  return { mdPath, jsonPath };
}
