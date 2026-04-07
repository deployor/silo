import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { clearLine, cursorTo, moveCursor } from "node:readline";
import { ask } from "./prompts";
import { RESULTS_DIR, RUN_PRESETS, THOROUGH_SCRIPT } from "./config";
import { loadRanking, loadRecentRunSummaries, listRunDirectories } from "./results";
import { generateStudyArtifacts } from "./study";
import {
  banner,
  color,
  createSpinner,
  drawMenu,
  printErr,
  printInfo,
  printKeyHint,
  printOk,
  printSection,
  printWarn,
} from "./ui";
import type { MenuChoice, RunPreset } from "./types";

function formatScore(value: number | null | undefined): string {
  if (typeof value !== "number") return "n/a";
  return value.toFixed(2);
}

function sanitizeEnv(input: string): string {
  return input.replace(/\s+/g, "").trim();
}

function providerEnvFilter(csv: string): string {
  const parts = csv
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  return parts.join(",");
}

type LiveErrorState = {
  active: string | null;
  repeatCount: number;
  lastPrintedAt: number;
};

type BenchEvent = {
  type?: "status" | "progress" | "s3" | "error";
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

const BENCH_EVENT_PREFIX = "__BENCH_EVT__";
const DASHBOARD_FRAMES = ["-", "\\", "|", "/"];

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function normalizeLine(value: string): string {
  return stripAnsi(value).trim().replace(/\s+/g, " ");
}

function looksLikeError(line: string): boolean {
  if (!line) return false;
  if (/^\[(INFO|OK|WARN)\]/i.test(line)) return false;
  return /\[(ERR|ERROR)\]|\berror\b|\bfailed\b|\bexception\b|\btimed out\b/i.test(line);
}

function createLiveErrorState(): LiveErrorState {
  return {
    active: null,
    repeatCount: 0,
    lastPrintedAt: 0,
  };
}

function ingestErrorLine(state: LiveErrorState, rawLine: string): string | null {
  const line = normalizeLine(rawLine);
  if (!looksLikeError(line)) return null;

  if (state.active === line) {
    state.repeatCount += 1;
    return line;
  }

  state.active = line;
  state.repeatCount = 1;
  state.lastPrintedAt = Date.now();
  return line;
}

function parseBenchEvent(line: string): BenchEvent | null {
  if (!line.startsWith(BENCH_EVENT_PREFIX)) return null;
  const payload = line.slice(BENCH_EVENT_PREFIX.length).trim();
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as BenchEvent;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function formatEtaShort(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "n/a";
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function createRunDashboard() {
  const interactive = Boolean(process.stdout.isTTY);
  let initialized = false;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastNonInteractiveAt = 0;
  let lastNonInteractiveLine = "";
  let activity = "waiting for first engine event...";
  let progress = "progress n/a";
  let error = "none";

  const width = () => {
    const cols = process.stdout.columns ?? 120;
    return Math.max(40, cols - 2);
  };

  const truncate = (value: string, maxLen: number) => {
    const plain = normalizeLine(value);
    if (plain.length <= maxLen) return plain;
    if (maxLen <= 3) return plain.slice(0, maxLen);
    return `${plain.slice(0, maxLen - 3)}...`;
  };

  const buildLine1 = () => {
    const glyph = DASHBOARD_FRAMES[frame % DASHBOARD_FRAMES.length];
    frame += 1;
    const plain = `[LIVE] ${glyph} ${activity} | ${progress}`;
    return truncate(plain, width());
  };

  const buildLine2 = () => {
    const plain = error === "none" ? "[ERR] none" : `[ERR] ${error}`;
    return truncate(plain, width());
  };

  const render = () => {
    const line1Raw = buildLine1();
    const line2Raw = buildLine2();
    const line1 = color(line1Raw, "\x1b[36m");
    const line2 = error === "none" ? color(line2Raw, "\x1b[32m") : color(line2Raw, "\x1b[31m");

    if (!interactive) {
      const now = Date.now();
      const merged = `${line1Raw} || ${line2Raw}`;
      if (merged !== lastNonInteractiveLine && now - lastNonInteractiveAt >= 1500) {
        lastNonInteractiveLine = merged;
        lastNonInteractiveAt = now;
        console.log(line1Raw);
        console.log(line2Raw);
      }
      return;
    }

    if (!initialized) {
      process.stdout.write("\n\n");
      initialized = true;
    }

    moveCursor(process.stdout, 0, -2);
    cursorTo(process.stdout, 0);
    clearLine(process.stdout, 0);
    process.stdout.write(`${line1}\n`);
    cursorTo(process.stdout, 0);
    clearLine(process.stdout, 0);
    process.stdout.write(`${line2}\n`);
  };

  return {
    start() {
      if (!interactive) return;
      render();
      timer = setInterval(render, 120);
    },
    setActivity(next: string) {
      activity = normalizeLine(next) || activity;
      render();
    },
    setProgress(next: string) {
      progress = normalizeLine(next) || progress;
      render();
    },
    setError(next: string) {
      error = normalizeLine(next) || error;
      render();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (interactive && initialized) {
        render();
        cursorTo(process.stdout, 0);
        clearLine(process.stdout, 0);
        process.stdout.write("\n");
      }
    },
  };
}

function flushLiveErrorState(state: LiveErrorState): void {
  if (!state.active || state.repeatCount <= 1) return;
  printWarn(`Last error repeated ${state.repeatCount} times.`);
}

export async function runPresetFlow(): Promise<void> {
  banner("Run Benchmarks", "Choose a run profile and execute with live logs");
  const choices: MenuChoice[] = RUN_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    detail: preset.detail,
  }));

  drawMenu("Run Presets", choices);
  printKeyHint();
  const answer = (await ask("Preset"))
    .trim()
    .toLowerCase();

  if (["q", "quit", "exit", "b", "back"].includes(answer)) {
    return;
  }

  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > RUN_PRESETS.length) {
    printWarn("Invalid choice. Returning to menu.");
    return;
  }

  const preset = RUN_PRESETS[index - 1];
  await runBenchmark(preset);
}

async function runBenchmark(preset: RunPreset): Promise<void> {
  banner("Benchmark Running", `Profile: ${preset.label}`);
  printInfo("Optional: limit providers by name contains (comma-separated, leave empty for all). Example: mega,cloudflare,wasabi");
  const providerFilterInput = sanitizeEnv(await ask("Providers filter"));
  printInfo("Optional: number of full run repetitions (default 1)");
  const repeatInput = sanitizeEnv(await ask("Run repetitions"));
  const repeats = Math.max(1, Number.parseInt(repeatInput || "1", 10) || 1);
  const knownRunDirs = new Set(await listRunDirectories(RESULTS_DIR));

  const runSpinner = createSpinner(`Running ${repeats} pass(es) of ${preset.label}`);
  runSpinner.start();

  let ok = true;
  const completedRunDirs: string[] = [];
  try {
    for (let i = 1; i <= repeats; i += 1) {
      runSpinner.stop(true, `Starting pass ${i}/${repeats}`);
      const runDir = await runSingle(preset, providerFilterInput, i, repeats);
      if (runDir) completedRunDirs.push(runDir);
      if (i < repeats) {
        runSpinner.start();
      }
    }
  } catch (error) {
    ok = false;
    const msg = error instanceof Error ? error.message : String(error);
    printErr(`Benchmark failed: ${msg}`);
  }

  if (ok) {
    printOk("Benchmark run(s) completed.");

    if (preset.id === "study") {
      if (completedRunDirs.length === 0) {
        const currentDirs = await listRunDirectories(RESULTS_DIR);
        for (const dir of currentDirs) {
          if (!knownRunDirs.has(dir)) {
            completedRunDirs.push(dir);
          }
        }
      }

      printSection("Deep Study Artifacts");
      for (const runDir of completedRunDirs) {
        try {
          const files = await generateStudyArtifacts(RESULTS_DIR, runDir);
          printOk(`Generated study report for ${runDir}`);
          printInfo(`Study report: ${files.mdPath}`);
          printInfo(`Study JSON: ${files.jsonPath}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          printErr(`Study artifact generation failed for ${runDir}: ${msg}`);
        }
      }
    }
  }

  printInfo(`Results directory: ${RESULTS_DIR}`);
  await ask("Press Enter to continue");
}

function runSingle(preset: RunPreset, providerFilterInput: string, pass: number, total: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...preset.env,
    } as Record<string, string>;

    let detectedRunDir: string | null = null;
    const errorState = createLiveErrorState();
    const dashboard = createRunDashboard();
    let stdoutRemainder = "";
    let stderrRemainder = "";

    if (providerFilterInput) {
      env.S3_BENCH_PROVIDER_FILTER = providerEnvFilter(providerFilterInput);
    }

    const child = spawn("bun", ["run", THOROUGH_SCRIPT], {
      env,
      stdio: ["inherit", "pipe", "pipe"],
      shell: false,
    });

    printSection(`Live Output ${pass}/${total}`);
    printInfo("Run controls: s=skip phase, p=skip provider, q=abort run, h=help");
    dashboard.start();

    const onLine = (line: string) => {
      const raw = line.trimEnd();
      if (!raw) return;

      const event = parseBenchEvent(raw);
      if (event) {
        if (event.type === "error") {
          const msg = event.message || "unknown error";
          const merged = event.statusCode ? `${msg} (status=${event.statusCode})` : msg;
          ingestErrorLine(errorState, merged);
          dashboard.setError(merged);
          dashboard.setActivity(event.provider ? `${event.provider}: ${msg}` : msg);
          return;
        }

        if (event.type === "progress") {
          const details = [
            event.provider ? `provider ${event.provider}` : null,
            event.phase ? `phase ${event.phase}` : null,
            `progress ${formatPct(event.percent)}`,
            `ETA ${formatEtaShort(event.etaMs)}`,
          ]
            .filter(Boolean)
            .join(" | ");
          dashboard.setProgress(details || "progress update");
          if (event.message) dashboard.setActivity(event.message);
          return;
        }

        if (event.type === "s3") {
          const op = event.operation ?? "s3-op";
          const status = event.ok ? "OK" : "FAIL";
          const msg = event.message ? ` | ${event.message}` : "";
          dashboard.setActivity(`${event.provider ?? "provider"} ${op} ${status}${msg}`);
          if (!event.ok && event.message) {
            ingestErrorLine(errorState, event.message);
            dashboard.setError(event.message);
          }
          return;
        }

        if (event.type === "status") {
          if (event.message) {
            const details = event.details ?? {};
            const consecutive =
              typeof details.consecutiveRateLimitEvents === "number" ? details.consecutiveRateLimitEvents : null;
            const total = typeof details.totalRateLimitEvents === "number" ? details.totalRateLimitEvents : null;
            const consecutiveThreshold =
              typeof details.consecutiveRateLimitThreshold === "number"
                ? details.consecutiveRateLimitThreshold
                : null;
            const totalThreshold =
              typeof details.totalRateLimitThreshold === "number" ? details.totalRateLimitThreshold : null;
            if (consecutive !== null || total !== null) {
              const parts: string[] = [event.message];
              if (consecutive !== null) {
                parts.push(
                  `throttle consecutive ${consecutive}${consecutiveThreshold !== null ? `/${consecutiveThreshold}` : ""}`,
                );
              }
              if (total !== null) {
                parts.push(`throttle total ${total}${totalThreshold !== null ? `/${totalThreshold}` : ""}`);
              }
              dashboard.setActivity(parts.join(" | "));
            } else {
              dashboard.setActivity(event.message);
            }
          }
          return;
        }

        return;
      }

      const runMatch = raw.match(/run=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9\-]+Z)/);
      if (runMatch?.[1]) {
        detectedRunDir = runMatch[1];
      }

      const maybeError = ingestErrorLine(errorState, raw);
      if (maybeError) {
        dashboard.setError(maybeError);
        return;
      }

      dashboard.setActivity(raw);
    };

    child.stdout.on("data", (chunk) => {
      const combined = stdoutRemainder + String(chunk);
      const lines = combined.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      const combined = stderrRemainder + String(chunk);
      const lines = combined.split(/\r?\n/);
      stderrRemainder = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line);
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (stdoutRemainder) {
        onLine(stdoutRemainder);
      }
      if (stderrRemainder) {
        onLine(stderrRemainder);
      }
      dashboard.stop();
      flushLiveErrorState(errorState);

      if (code === 0) {
        resolve(detectedRunDir);
      } else {
        reject(new Error(`runner exited with code ${code ?? -1}`));
      }
    });
  });
}

export async function browseRecentRunsFlow(): Promise<void> {
  banner("Recent Runs", "Latest benchmark sessions and top providers");
  const summaries = await loadRecentRunSummaries(RESULTS_DIR, 15);

  if (summaries.length === 0) {
    printWarn("No benchmark runs found yet.");
    await ask("Press Enter to continue");
    return;
  }

  for (const [idx, item] of summaries.entries()) {
    const n = String(idx + 1).padStart(2, "0");
    const top = item.topProvider ? `${item.topProvider} (${formatScore(item.topScore)})` : "n/a";
    console.log(`${n}. ${item.runDir}`);
    console.log(`    started: ${item.startedAtUtc ?? "n/a"}`);
    console.log(`    providers: ${item.providerCount ?? 0}  top: ${top}`);
  }

  printInfo("Enter run number to open ranking details, or press Enter to go back.");
  const answer = sanitizeEnv(await ask("Run"));
  if (!answer) return;

  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > summaries.length) {
    printWarn("Invalid choice.");
    await ask("Press Enter to continue");
    return;
  }

  await showRankingFlow(summaries[index - 1].runDir);
}

export async function showRankingFlow(runDirFromMenu?: string): Promise<void> {
  banner("Run Ranking", "Provider category scores and overall rank");
  let runDir = runDirFromMenu;

  if (!runDir) {
    const dirs = await listRunDirectories(RESULTS_DIR);
    if (dirs.length === 0) {
      printWarn("No runs found.");
      await ask("Press Enter to continue");
      return;
    }

    printInfo("Recent run directories:");
    dirs.slice(0, 10).forEach((d, i) => console.log(`${String(i + 1).padStart(2, "0")}. ${d}`));
    const choice = sanitizeEnv(await ask("Select run number"));
    const idx = Number(choice);
    if (!Number.isInteger(idx) || idx < 1 || idx > Math.min(10, dirs.length)) {
      printWarn("Invalid run selection.");
      await ask("Press Enter to continue");
      return;
    }
    runDir = dirs[idx - 1];
  }

  try {
    const rows = await loadRanking(RESULTS_DIR, runDir);
    printOk(`Run: ${runDir}`);
    console.log("Provider                     Overall  Capab  Latency  Throughput  Consistency  Scalability  Integrity");
    console.log("------------------------------------------------------------------------------------------------------");
    for (const row of rows) {
      const name = row.name.padEnd(27, " ").slice(0, 27);
      const line = [
        name,
        formatScore(row.overall).padStart(7, " "),
        formatScore(row.capability).padStart(6, " "),
        formatScore(row.latency).padStart(8, " "),
        formatScore(row.throughput).padStart(10, " "),
        formatScore(row.consistency).padStart(11, " "),
        formatScore(row.scalability).padStart(11, " "),
        formatScore(row.integrity).padStart(9, " "),
      ].join("  ");
      console.log(line);
    }
    printInfo(`JSON: ${join(RESULTS_DIR, runDir, "ranking.json")}`);
    printInfo(`Report: ${join(RESULTS_DIR, runDir, "report.md")}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    printErr(`Could not load ranking: ${msg}`);
  }

  await ask("Press Enter to continue");
}

export async function showStudyReportFlow(): Promise<void> {
  banner("Study Report", "Open generated deep-study markdown report");
  const dirs = await listRunDirectories(RESULTS_DIR);
  if (dirs.length === 0) {
    printWarn("No runs found.");
    await ask("Press Enter to continue");
    return;
  }

  printInfo("Recent run directories:");
  dirs.slice(0, 15).forEach((d, i) => console.log(`${String(i + 1).padStart(2, "0")}. ${d}`));
  const choice = sanitizeEnv(await ask("Select run number"));
  const idx = Number(choice);
  if (!Number.isInteger(idx) || idx < 1 || idx > Math.min(15, dirs.length)) {
    printWarn("Invalid run selection.");
    await ask("Press Enter to continue");
    return;
  }

  const runDir = dirs[idx - 1];
  const reportPath = join(RESULTS_DIR, runDir, "study-report.md");
  const jsonPath = join(RESULTS_DIR, runDir, "study-insights.json");
  try {
    const body = await readFile(reportPath, "utf8");
    printOk(`Run: ${runDir}`);
    printInfo(`Study report: ${reportPath}`);
    printInfo(`Study JSON: ${jsonPath}`);
    printSection("Report Preview");
    const lines = body.split("\n");
    for (const line of lines.slice(0, 80)) {
      console.log(line);
    }
    if (lines.length > 80) {
      printInfo(`Preview truncated (${lines.length - 80} more lines)`);
    }
  } catch {
    printErr("Study report not found for this run. Re-run with the Blog Post and Deep Study preset.");
  }

  await ask("Press Enter to continue");
}
