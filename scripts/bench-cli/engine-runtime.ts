import type { BenchEvent, RuntimeControls } from "./engine-model";

export const RUNTIME_CONTROLS: RuntimeControls = {
  skipPhase: false,
  skipProvider: false,
  skipProviderReason: null,
  abortAll: false,
};

export const RATE_LIMIT_STATE = {
  cooldownUntilMs: 0,
  consecutiveEvents: 0,
  totalEvents: 0,
};

export const BENCH_EVENT_PREFIX = "__BENCH_EVT__";

export function emitBenchEvent(event: BenchEvent) {
  try {
    process.stdout.write(`${BENCH_EVENT_PREFIX}${JSON.stringify({ t: Date.now(), ...event })}\n`);
  } catch {
    // Do not fail benchmark because telemetry emission failed.
  }
}
