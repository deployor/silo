import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
import { fetchJson } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type BucketCandidate = {
	name: string;
	ownerEmail: string | null;
	totalBytes: number;
	totalRequests: number;
	isPaused: boolean;
};

type BucketListResponse = {
	buckets: BucketCandidate[];
};

type SpeedtestSuite = {
	id: "single" | "many-small" | "concurrent" | "cache-heavy";
	label: string;
	config: {
		iterations: number;
		fileSizeBytes: number;
		fileCount: number;
		concurrency: number;
		warmPasses: number;
	};
	totals: {
		uploadMs: number;
		downloadColdMs: number;
		downloadWarmMs: number;
		putRequests: number;
		getRequests: number;
		deleteRequests: number;
		bytesUp: number;
		bytesDown: number;
	};
	latency: {
		headSamplesMs: number[];
		avgMs: number;
		p95Ms: number;
	};
	cache: {
		warmHitCount: number;
		warmMissCount: number;
	};
	cacheDiagnostics?: {
		redisHitsDelta: number;
		redisMissesDelta: number;
		diskEntriesDelta: number;
		diskSizeDeltaBytes: number;
		demandEntriesDelta: number;
		stressGetAvgMs: number;
		stressGetP50Ms: number;
		stressGetP95Ms: number;
		coldRps: number;
		hotRps: number;
		coldSuccessRate: number;
		hotSuccessRate: number;
		hotRateLimited: number;
		hotTimeouts: number;
		internalHitRatePercent: number;
	};
	iterationsDetail: Array<{
		index: number;
		key: string;
		uploadMs: number;
		downloadColdMs: number;
		downloadWarmMs: number;
		warmCacheHeader: string | null;
		sizeBytes: number;
	}>;
};

type SpeedtestRunResult = {
	bucketName: string;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	serverBenchmarkMs: number;
	suites: SpeedtestSuite[];
	summary: {
		totalBytesUp: number;
		totalBytesDown: number;
		totalRequests: number;
	};
};

type SpeedtestRunResponse = {
	ok: true;
	result: SpeedtestRunResult;
};

export function AdminSpeedtestPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		pageTitle?: string;
	};

	const [buckets, setBuckets] = useState<BucketCandidate[]>([]);
	const [bucketName, setBucketName] = useState("");
	const [sizeMb, setSizeMb] = useState(8);
	const [iterations, setIterations] = useState(3);
	const [runSingle, setRunSingle] = useState(true);
	const [runManySmall, setRunManySmall] = useState(true);
	const [runConcurrent, setRunConcurrent] = useState(false);
	const [runCacheHeavy, setRunCacheHeavy] = useState(false);
	const [smallFileKb, setSmallFileKb] = useState(256);
	const [smallFileCount, setSmallFileCount] = useState(16);
	const [concurrency, setConcurrency] = useState(4);
	const [warmPasses, setWarmPasses] = useState(1);
	const [cacheStressLoops, setCacheStressLoops] = useState(80);
	const [cacheObjectCount, setCacheObjectCount] = useState(4);
	const [cacheTimeoutMs, setCacheTimeoutMs] = useState(8000);
	const [running, setRunning] = useState(false);
	const [startedAt, setStartedAt] = useState<number | null>(null);
	const [elapsed, setElapsed] = useState(0);
	const [result, setResult] = useState<SpeedtestRunResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [serverPing, setServerPing] = useState<{
		avgMs: number;
		p95Ms: number;
		samplesMs: number[];
	} | null>(null);
	const [clientApiTiming, setClientApiTiming] = useState<{
		roundTripMs: number;
		serverBenchmarkMs: number;
		estimatedOverheadMs: number;
	} | null>(null);

	useEffect(() => {
		void (async () => {
			try {
				const data = await fetchJson<BucketListResponse>(
					"/api/admin/buckets?limit=200&offset=0&sortBy=totalRequests&sortOrder=desc",
				);
				const active = (data.buckets || []).filter((b) => !b.isPaused);
				setBuckets(active);
				if (active[0]) setBucketName(active[0].name);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to load buckets");
			}
		})();
	}, []);

	useEffect(() => {
		if (!running || startedAt === null) return;
		const timer = window.setInterval(() => {
			setElapsed((Date.now() - startedAt) / 1000);
		}, 100);
		return () => window.clearInterval(timer);
	}, [running, startedAt]);

	const measureServerPing = useCallback(async () => {
		try {
			const samples: number[] = [];
			for (let i = 0; i < 5; i++) {
				const started = performance.now();
				const res = await fetch("/api/admin/speedtest/ping", {
					method: "GET",
				});
				if (!res.ok) {
					throw new Error(await res.text());
				}
				samples.push(performance.now() - started);
			}
			const sorted = [...samples].sort((a, b) => a - b);
			const avgMs =
				samples.reduce((acc, value) => acc + value, 0) / samples.length;
			const p95Ms =
				sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ||
				0;
			setServerPing({ avgMs, p95Ms, samplesMs: samples });
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "Failed to measure server ping",
			);
		}
	}, []);

	useEffect(() => {
		void measureServerPing();
	}, [measureServerPing]);

	const runSpeedtest = async () => {
		if (!bucketName) return;
		if (!runSingle && !runManySmall && !runConcurrent && !runCacheHeavy) {
			setError("Enable at least one suite before running benchmark.");
			return;
		}

		setRunning(true);
		setStartedAt(Date.now());
		setElapsed(0);
		setError(null);
		setResult(null);
		setClientApiTiming(null);
		try {
			const requestStarted = performance.now();
			const res = await fetch("/api/admin/speedtest/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					bucketName,
					sizeMb,
					iterations,
					runSingle,
					runManySmall,
					runConcurrent,
					runCacheHeavy,
					smallFileKb,
					smallFileCount,
					concurrency,
					warmPasses,
					cacheStressLoops,
					cacheObjectCount,
					cacheTimeoutMs,
				}),
			});
			if (!res.ok) {
				throw new Error(await res.text());
			}
			const requestRoundTripMs = performance.now() - requestStarted;
			const payload = (await res.json()) as SpeedtestRunResponse;
			setResult(payload.result);
			setClientApiTiming({
				roundTripMs: requestRoundTripMs,
				serverBenchmarkMs:
					payload.result.serverBenchmarkMs || payload.result.durationMs,
				estimatedOverheadMs: Math.max(
					0,
					requestRoundTripMs -
						(payload.result.serverBenchmarkMs || payload.result.durationMs),
				),
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : "Speed test failed");
		} finally {
			setRunning(false);
		}
	};

	const suiteStats = useMemo(() => {
		if (!result) return [];
		return result.suites.map((suite) => {
			const upMbps =
				suite.totals.uploadMs > 0
					? suite.totals.bytesUp /
						(1024 * 1024) /
						(suite.totals.uploadMs / 1000)
					: 0;
			const downColdMbps =
				suite.totals.downloadColdMs > 0
					? suite.totals.bytesDown /
						(1024 * 1024) /
						(suite.totals.downloadColdMs / 1000)
					: 0;
			const downWarmMbps =
				suite.totals.downloadWarmMs > 0
					? suite.totals.bytesDown /
						(1024 * 1024) /
						(suite.totals.downloadWarmMs / 1000)
					: 0;
			const cacheBoost =
				downColdMbps > 0 ? (downWarmMbps / downColdMbps - 1) * 100 : 0;
			const cacheTotal = suite.cache.warmHitCount + suite.cache.warmMissCount;
			const cacheHitRate =
				cacheTotal > 0 ? (suite.cache.warmHitCount / cacheTotal) * 100 : 0;

			return {
				suite,
				upMbps,
				downColdMbps,
				downWarmMbps,
				cacheBoost,
				cacheHitRate,
			};
		});
	}, [result]);

	const applyPreset = (preset: "quick" | "balanced" | "heavy") => {
		if (preset === "quick") {
			setIterations(2);
			setSizeMb(4);
			setRunSingle(true);
			setRunManySmall(false);
			setRunConcurrent(false);
			setRunCacheHeavy(false);
			setSmallFileKb(128);
			setSmallFileCount(8);
			setConcurrency(2);
			setWarmPasses(1);
			setCacheStressLoops(20);
			setCacheObjectCount(2);
			setCacheTimeoutMs(6000);
			return;
		}

		if (preset === "balanced") {
			setIterations(3);
			setSizeMb(8);
			setRunSingle(true);
			setRunManySmall(true);
			setRunConcurrent(true);
			setRunCacheHeavy(false);
			setSmallFileKb(256);
			setSmallFileCount(16);
			setConcurrency(4);
			setWarmPasses(1);
			setCacheStressLoops(80);
			setCacheObjectCount(4);
			setCacheTimeoutMs(8000);
			return;
		}

		setIterations(5);
		setSizeMb(16);
		setRunSingle(true);
		setRunManySmall(true);
		setRunConcurrent(true);
		setRunCacheHeavy(true);
		setSmallFileKb(512);
		setSmallFileCount(32);
		setConcurrency(8);
		setWarmPasses(2);
		setCacheStressLoops(200);
		setCacheObjectCount(8);
		setCacheTimeoutMs(12000);
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			pageTitle={p.pageTitle || "ADMIN"}
			config={bootstrap.config}
		>
			<AdminSubnav active="speedtest" />

			<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow mb-8">
				<div className="p-6 border-b border-white/10 flex justify-between items-start gap-4 flex-wrap">
					<div>
						<h2 className="text-xl font-bold text-white">Proxy Speed Lab</h2>
						<p className="text-text-muted text-sm mt-1">
							Admin-only benchmark suite for single-file throughput, many
							small-file patterns, concurrent bursts, cache behavior, and
							latency.
						</p>
					</div>
					<div className="text-right">
						{running ? (
							<div className="text-sm text-hc-red font-mono">
								Running… {elapsed.toFixed(1)}s
							</div>
						) : (
							<div className="text-xs text-text-muted font-mono">Idle</div>
						)}
					</div>
				</div>

				<div className="p-6 space-y-6">
					<div className="flex flex-wrap gap-2 items-center">
						<button
							type="button"
							onClick={() => applyPreset("quick")}
							className="px-3 py-1.5 text-xs rounded-lg border border-white/15 text-text-muted hover:text-white hover:border-white/30"
						>
							Quick
						</button>
						<button
							type="button"
							onClick={() => applyPreset("balanced")}
							className="px-3 py-1.5 text-xs rounded-lg border border-white/15 text-text-muted hover:text-white hover:border-white/30"
						>
							Balanced
						</button>
						<button
							type="button"
							onClick={() => applyPreset("heavy")}
							className="px-3 py-1.5 text-xs rounded-lg border border-white/15 text-text-muted hover:text-white hover:border-white/30"
						>
							Heavy
						</button>
						<button
							type="button"
							onClick={() => void measureServerPing()}
							className="px-3 py-1.5 text-xs rounded-lg border border-hc-red/40 text-hc-red hover:border-hc-red hover:text-red-300"
						>
							Measure Server RTT
						</button>
						{serverPing ? (
							<div className="text-xs text-text-muted font-mono">
								Server RTT avg {serverPing.avgMs.toFixed(1)} ms · p95{" "}
								{serverPing.p95Ms.toFixed(1)} ms
							</div>
						) : null}
					</div>

					<div className="grid grid-cols-1 md:grid-cols-4 gap-3">
						<div>
							<label
								htmlFor="speedtest-bucket"
								className="block text-xs uppercase font-bold text-text-muted mb-1"
							>
								Test Bucket
							</label>
							<select
								id="speedtest-bucket"
								value={bucketName}
								onChange={(e) => setBucketName(e.target.value)}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"
							>
								{buckets.map((b) => (
									<option key={b.name} value={b.name}>
										{b.name} ({b.ownerEmail || "unknown"})
									</option>
								))}
							</select>
						</div>
						<div>
							<label
								htmlFor="speedtest-size"
								className="block text-xs uppercase font-bold text-text-muted mb-1"
							>
								Payload Size (MB)
							</label>
							<input
								id="speedtest-size"
								type="number"
								min={1}
								max={64}
								value={sizeMb}
								onChange={(e) => setSizeMb(Number(e.target.value) || 1)}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"
							/>
						</div>
						<div>
							<label
								htmlFor="speedtest-iterations"
								className="block text-xs uppercase font-bold text-text-muted mb-1"
							>
								Iterations
							</label>
							<input
								id="speedtest-iterations"
								type="number"
								min={1}
								max={10}
								value={iterations}
								onChange={(e) => setIterations(Number(e.target.value) || 1)}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"
							/>
						</div>
						<div>
							<label
								htmlFor="speedtest-concurrency"
								className="block text-xs uppercase font-bold text-text-muted mb-1"
							>
								Concurrency
							</label>
							<input
								id="speedtest-concurrency"
								type="number"
								min={1}
								max={20}
								value={concurrency}
								onChange={(e) => setConcurrency(Number(e.target.value) || 1)}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"
							/>
						</div>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-4 gap-3">
						<div>
							<label
								htmlFor="speedtest-small-kb"
								className="block text-xs uppercase font-bold text-text-muted mb-1"
							>
								Small File Size (KB)
							</label>
							<input
								id="speedtest-small-kb"
								type="number"
								min={16}
								max={4096}
								value={smallFileKb}
								onChange={(e) => setSmallFileKb(Number(e.target.value) || 16)}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"
							/>
						</div>
						<div>
							<label
								htmlFor="speedtest-small-count"
								className="block text-xs uppercase font-bold text-text-muted mb-1"
							>
								Small Files / Iteration
							</label>
							<input
								id="speedtest-small-count"
								type="number"
								min={1}
								max={200}
								value={smallFileCount}
								onChange={(e) => setSmallFileCount(Number(e.target.value) || 1)}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"
							/>
						</div>
						<div>
							<label
								htmlFor="speedtest-warm-passes"
								className="block text-xs uppercase font-bold text-text-muted mb-1"
							>
								Warm Passes
							</label>
							<input
								id="speedtest-warm-passes"
								type="number"
								min={1}
								max={3}
								value={warmPasses}
								onChange={(e) => setWarmPasses(Number(e.target.value) || 1)}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"
							/>
						</div>
						<div className="flex items-end">
							<button
								type="button"
								onClick={() => void runSpeedtest()}
								disabled={running || !bucketName}
								className="w-full bg-hc-red hover:bg-red-600 disabled:opacity-60 text-white font-bold py-2.5 rounded-xl"
							>
								{running ? "Running…" : "Run Benchmark"}
							</button>
						</div>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
						<div>
							<label
								htmlFor="speedtest-cache-loops"
								className="block text-xs uppercase font-bold text-text-muted mb-1"
							>
								Cache Stress Loops
							</label>
							<input
								id="speedtest-cache-loops"
								type="number"
								min={5}
								max={500}
								value={cacheStressLoops}
								onChange={(e) =>
									setCacheStressLoops(Number(e.target.value) || 5)
								}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"
							/>
						</div>
						<div>
							<label
								htmlFor="speedtest-cache-timeout"
								className="block text-xs uppercase font-bold text-text-muted mb-1"
							>
								Cache Timeout (ms)
							</label>
							<input
								id="speedtest-cache-timeout"
								type="number"
								min={1000}
								max={60000}
								value={cacheTimeoutMs}
								onChange={(e) =>
									setCacheTimeoutMs(Number(e.target.value) || 1000)
								}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"
							/>
						</div>
						<div>
							<label
								htmlFor="speedtest-cache-objects"
								className="block text-xs uppercase font-bold text-text-muted mb-1"
							>
								Cache Object Count
							</label>
							<input
								id="speedtest-cache-objects"
								type="number"
								min={1}
								max={20}
								value={cacheObjectCount}
								onChange={(e) =>
									setCacheObjectCount(Number(e.target.value) || 1)
								}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"
							/>
						</div>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-4 gap-3">
						<label className="bg-black/30 border border-white/10 rounded-xl p-3 flex items-center gap-2 text-sm text-white">
							<input
								type="checkbox"
								checked={runSingle}
								onChange={(e) => setRunSingle(e.target.checked)}
							/>
							Single file throughput suite
						</label>
						<label className="bg-black/30 border border-white/10 rounded-xl p-3 flex items-center gap-2 text-sm text-white">
							<input
								type="checkbox"
								checked={runManySmall}
								onChange={(e) => setRunManySmall(e.target.checked)}
							/>
							Many small files suite
						</label>
						<label className="bg-black/30 border border-white/10 rounded-xl p-3 flex items-center gap-2 text-sm text-white">
							<input
								type="checkbox"
								checked={runConcurrent}
								onChange={(e) => setRunConcurrent(e.target.checked)}
							/>
							Concurrent burst suite
						</label>
						<label className="bg-black/30 border border-white/10 rounded-xl p-3 flex items-center gap-2 text-sm text-white">
							<input
								type="checkbox"
								checked={runCacheHeavy}
								onChange={(e) => setRunCacheHeavy(e.target.checked)}
							/>
							Cache hammer suite (Redis + Disk)
						</label>
					</div>

					{error ? <div className="text-sm text-red-400">{error}</div> : null}

					{result ? (
						<>
							<div className="grid grid-cols-1 md:grid-cols-4 gap-3">
								<StatCard
									label="Total Duration"
									value={`${(result.durationMs / 1000).toFixed(2)} s`}
								/>
								<StatCard
									label="Total Bytes Up"
									value={formatBytes(result.summary.totalBytesUp)}
								/>
								<StatCard
									label="Total Bytes Down"
									value={formatBytes(result.summary.totalBytesDown)}
								/>
								<StatCard
									label="Total Requests"
									value={result.summary.totalRequests.toLocaleString()}
								/>
							</div>

							<div className="grid grid-cols-1 md:grid-cols-4 gap-3">
								<StatCard
									label="Server Benchmark"
									value={`${result.serverBenchmarkMs.toFixed(1)} ms`}
								/>
								<StatCard
									label="API Round Trip"
									value={
										clientApiTiming
											? `${clientApiTiming.roundTripMs.toFixed(1)} ms`
											: "-"
									}
								/>
								<StatCard
									label="Estimated Client↔Server Overhead"
									value={
										clientApiTiming
											? `${clientApiTiming.estimatedOverheadMs.toFixed(1)} ms`
											: "-"
									}
								/>
								<StatCard
									label="Server RTT (Ping Avg)"
									value={serverPing ? `${serverPing.avgMs.toFixed(1)} ms` : "-"}
								/>
							</div>

							{suiteStats.map((stat) => (
								<div
									key={stat.suite.id}
									className="bg-black/30 border border-white/10 rounded-2xl overflow-hidden"
								>
									<div className="px-4 py-3 border-b border-white/10">
										<div className="text-sm font-bold text-white">
											{stat.suite.label}
										</div>
										<div className="text-[11px] text-text-muted mt-1">
											{stat.suite.config.fileCount} file(s) ×{" "}
											{formatBytes(stat.suite.config.fileSizeBytes)} ·{" "}
											{stat.suite.config.iterations} iteration(s) · concurrency{" "}
											{stat.suite.config.concurrency}
										</div>
									</div>

									<div className="p-4 space-y-3">
										<div className="grid grid-cols-1 md:grid-cols-4 gap-3">
											<StatCard
												label="Upload Throughput"
												value={`${stat.upMbps.toFixed(2)} MB/s`}
											/>
											<StatCard
												label="Cold Download"
												value={`${stat.downColdMbps.toFixed(2)} MB/s`}
											/>
											<StatCard
												label="Warm Download"
												value={`${stat.downWarmMbps.toFixed(2)} MB/s`}
											/>
											<StatCard
												label="Cache Boost"
												value={`${stat.cacheBoost.toFixed(1)}%`}
											/>
										</div>

										{stat.suite.cacheDiagnostics ? (
											<>
												<div className="grid grid-cols-1 md:grid-cols-4 gap-3">
													<StatCard
														label="Redis Hits Δ"
														value={stat.suite.cacheDiagnostics.redisHitsDelta.toLocaleString()}
													/>
													<StatCard
														label="Redis Misses Δ"
														value={stat.suite.cacheDiagnostics.redisMissesDelta.toLocaleString()}
													/>
													<StatCard
														label="Disk Entries Δ"
														value={stat.suite.cacheDiagnostics.diskEntriesDelta.toLocaleString()}
													/>
													<StatCard
														label="Disk Size Δ"
														value={formatBytes(
															stat.suite.cacheDiagnostics.diskSizeDeltaBytes,
														)}
													/>
													<StatCard
														label="Demand Entries Δ"
														value={stat.suite.cacheDiagnostics.demandEntriesDelta.toLocaleString()}
													/>
													<StatCard
														label="Stress GET Avg"
														value={`${stat.suite.cacheDiagnostics.stressGetAvgMs.toFixed(1)} ms`}
													/>
													<StatCard
														label="Stress GET P50"
														value={`${stat.suite.cacheDiagnostics.stressGetP50Ms.toFixed(1)} ms`}
													/>
													<StatCard
														label="Stress GET P95"
														value={`${stat.suite.cacheDiagnostics.stressGetP95Ms.toFixed(1)} ms`}
													/>
													<StatCard
														label="Cold Req/s"
														value={stat.suite.cacheDiagnostics.coldRps.toFixed(
															1,
														)}
													/>
													<StatCard
														label="Hot Req/s"
														value={stat.suite.cacheDiagnostics.hotRps.toFixed(
															1,
														)}
													/>
													<StatCard
														label="Cold Success"
														value={`${stat.suite.cacheDiagnostics.coldSuccessRate.toFixed(1)}%`}
													/>
													<StatCard
														label="Hot Success"
														value={`${stat.suite.cacheDiagnostics.hotSuccessRate.toFixed(1)}%`}
													/>
													<StatCard
														label="Hot 429s"
														value={stat.suite.cacheDiagnostics.hotRateLimited.toLocaleString()}
													/>
													<StatCard
														label="Hot Timeouts"
														value={stat.suite.cacheDiagnostics.hotTimeouts.toLocaleString()}
													/>
													<StatCard
														label="Internal Cache Hit Signal"
														value={`${stat.suite.cacheDiagnostics.internalHitRatePercent.toFixed(1)}%`}
													/>
												</div>
												<div className="text-[11px] text-text-muted">
													Note: <span className="font-mono">X-Cache</span> is
													edge/CDN cache and may stay MISS for signed/private
													requests. Internal Redis/disk behavior is reflected by
													Redis/Disk deltas and Internal Cache Hit Signal.
												</div>
											</>
										) : null}

										<div className="grid grid-cols-1 md:grid-cols-4 gap-3">
											<StatCard
												label="Latency Avg"
												value={`${stat.suite.latency.avgMs.toFixed(1)} ms`}
											/>
											<StatCard
												label="Latency P95"
												value={`${stat.suite.latency.p95Ms.toFixed(1)} ms`}
											/>
											<StatCard
												label="Traffic Volume"
												value={`${formatBytes(stat.suite.totals.bytesUp)} up / ${formatBytes(stat.suite.totals.bytesDown)} down`}
											/>
											<StatCard
												label="Cache Hit Rate"
												value={`${stat.cacheHitRate.toFixed(1)}%`}
											/>
										</div>

										<div className="overflow-x-auto rounded-xl border border-white/10">
											<table className="w-full text-left text-xs">
												<thead className="bg-white/5 text-text-muted uppercase tracking-wider">
													<tr>
														<th className="px-4 py-2">#</th>
														<th className="px-4 py-2">Key</th>
														<th className="px-4 py-2">Size</th>
														<th className="px-4 py-2">Upload</th>
														<th className="px-4 py-2">Cold DL</th>
														<th className="px-4 py-2">Warm DL</th>
														<th className="px-4 py-2">X-Cache</th>
													</tr>
												</thead>
												<tbody className="divide-y divide-white/5">
													{stat.suite.iterationsDetail.map((row) => (
														<tr
															key={`${stat.suite.id}-${row.index}`}
															className="hover:bg-white/5"
														>
															<td className="px-4 py-2 text-white">
																{row.index + 1}
															</td>
															<td className="px-4 py-2 font-mono text-text-muted">
																{row.key}
															</td>
															<td className="px-4 py-2 text-white">
																{formatBytes(row.sizeBytes)}
															</td>
															<td className="px-4 py-2 text-white">
																{row.uploadMs.toFixed(1)} ms
															</td>
															<td className="px-4 py-2 text-white">
																{row.downloadColdMs.toFixed(1)} ms
															</td>
															<td className="px-4 py-2 text-white">
																{row.downloadWarmMs.toFixed(1)} ms
															</td>
															<td className="px-4 py-2 text-hc-green">
																{row.warmCacheHeader || "MISS"}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									</div>
								</div>
							))}
						</>
					) : null}
				</div>
			</div>
		</AppShell>
	);
}

function StatCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="bg-black/30 border border-white/10 rounded-xl p-4">
			<div className="text-[11px] uppercase tracking-wider text-text-muted font-bold">
				{label}
			</div>
			<div className="text-white font-mono text-lg mt-1">{value}</div>
		</div>
	);
}
