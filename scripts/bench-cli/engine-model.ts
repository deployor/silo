export type ProviderConfig = {
  name: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export type TrialError = {
  name?: string;
  message: string;
  statusCode?: number;
};

export type TrialResult = {
  bytes?: number;
  throughputMiBs?: number;
  statusCode?: number;
  details?: Record<string, unknown>;
};

export type TrialRecord = {
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

export type ProbeRecord = {
  name: string;
  ok: boolean;
  ms: number;
  details?: Record<string, unknown>;
  error?: TrialError;
};

export type AggregateStats = {
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

export type CategoryScores = {
  capability: number;
  latency: number;
  throughput: number;
  consistency: number;
  scalability: number;
  integrity: number;
  overall: number;
};

export type ProviderRun = {
  provider: Omit<ProviderConfig, "accessKeyId" | "secretAccessKey">;
  runId: string;
  startedAtUtc: string;
  completedAtUtc?: string;
  status?: "ok" | "failed";
  config: Record<string, unknown>;
  probes: ProbeRecord[];
  trials: Record<string, TrialRecord[]>;
  aggregates?: Record<string, AggregateStats>;
  derived?: Record<string, unknown>;
  scores?: CategoryScores;
  phaseTimingsMs?: Record<string, number>;
  fatalError?: TrialError;
  notes: string[];
};

export type ProviderSummary = {
  name: string;
  providerKey: string;
  aggregates: Record<string, AggregateStats>;
  derived: Record<string, unknown>;
  scores?: CategoryScores;
};

export type ProgressTotals = {
  totalPhases: number;
  completedPhases: number;
  startedPerf: number;
};

export type RuntimeControls = {
  skipPhase: boolean;
  skipProvider: boolean;
  skipProviderReason: "user" | "auto" | null;
  abortAll: boolean;
};

export type ScoreDirection = "higher" | "lower";

export type BenchEvent = {
  type: "status" | "progress" | "s3" | "error";
  provider?: string;
  phase?: string;
  message?: string;
  percent?: number;
  etaMs?: number | null;
  providerIndex?: number;
  totalProviders?: number;
  elapsedMs?: number;
  operation?: string;
  ok?: boolean;
  statusCode?: number;
  attempt?: number;
  totalAttempts?: number;
  details?: Record<string, unknown>;
};
