import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchRunSummary, RankedProvider } from "./types";

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

export async function listRunDirectories(resultsDir: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(resultsDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name))
    .sort((a, b) => b.localeCompare(a));
}

export async function loadSummary(resultsDir: string, runDir: string): Promise<BenchRunSummary | null> {
  try {
    const summaryPath = join(resultsDir, runDir, "summary.json");
    const raw = await readFile(summaryPath, "utf8");
    const parsed = JSON.parse(raw) as {
      startedAtUtc?: string;
      providers?: Array<{ name?: string; scores?: { overall?: number | null } }>;
    };

    const providers = Array.isArray(parsed.providers) ? parsed.providers : [];
    let topProvider: string | undefined;
    let topScore: number | undefined;

    for (const provider of providers) {
      const score = numOrNull(provider?.scores?.overall);
      if (score == null) continue;
      if (topScore == null || score > topScore) {
        topScore = score;
        topProvider = provider.name ?? "Unknown";
      }
    }

    return {
      runDir,
      startedAtUtc: parsed.startedAtUtc,
      providerCount: providers.length,
      topProvider,
      topScore,
    };
  } catch {
    return null;
  }
}

export async function loadRanking(resultsDir: string, runDir: string): Promise<RankedProvider[]> {
  const rankingPath = join(resultsDir, runDir, "ranking.json");
  const raw = await readFile(rankingPath, "utf8");
  const parsed = JSON.parse(raw) as
    | {
        ranking?: Array<{
          provider?: string;
          scores?: {
            overall?: number;
            capability?: number;
            latency?: number;
            throughput?: number;
            consistency?: number;
            scalability?: number;
            integrity?: number;
          };
        }>;
      }
    | Array<{
        provider?: string;
        scores?: {
          overall?: number;
          capability?: number;
          latency?: number;
          throughput?: number;
          consistency?: number;
          scalability?: number;
          integrity?: number;
        };
      }>;

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.ranking)
      ? parsed.ranking
      : [];
  return rows.map((row) => ({
    name: row.provider ?? "Unknown",
    overall: numOrNull(row.scores?.overall),
    capability: numOrNull(row.scores?.capability),
    latency: numOrNull(row.scores?.latency),
    throughput: numOrNull(row.scores?.throughput),
    consistency: numOrNull(row.scores?.consistency),
    scalability: numOrNull(row.scores?.scalability),
    integrity: numOrNull(row.scores?.integrity),
  }));
}

export async function loadRecentRunSummaries(resultsDir: string, maxItems = 10): Promise<BenchRunSummary[]> {
  const dirs = await listRunDirectories(resultsDir);
  const slice = dirs.slice(0, maxItems);
  const out: BenchRunSummary[] = [];

  for (const runDir of slice) {
    const summary = await loadSummary(resultsDir, runDir);
    if (summary) out.push(summary);
  }

  return out;
}
