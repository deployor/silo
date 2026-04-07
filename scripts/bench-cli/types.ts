export type MenuChoice = {
  id: string;
  label: string;
  detail: string;
};

export type RunPreset = {
  id: string;
  label: string;
  detail: string;
  env: Record<string, string>;
};

export type BenchRunSummary = {
  runDir: string;
  startedAtUtc?: string;
  providerCount?: number;
  topProvider?: string;
  topScore?: number;
};

export type RankedProvider = {
  name: string;
  overall?: number | null;
  capability?: number | null;
  latency?: number | null;
  throughput?: number | null;
  consistency?: number | null;
  scalability?: number | null;
  integrity?: number | null;
};
