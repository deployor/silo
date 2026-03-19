import { useEffect, useMemo, useState } from "react";
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

type SpeedtestRunResult = {
	bucketName: string;
	sizeBytes: number;
	iterations: number;
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
	iterationsDetail: Array<{
		index: number;
		key: string;
		uploadMs: number;
		downloadColdMs: number;
		downloadWarmMs: number;
		warmCacheHeader: string | null;
	}>;
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
	const [running, setRunning] = useState(false);
	const [startedAt, setStartedAt] = useState<number | null>(null);
	const [elapsed, setElapsed] = useState(0);
	const [result, setResult] = useState<SpeedtestRunResult | null>(null);
	const [error, setError] = useState<string | null>(null);

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

	const runSpeedtest = async () => {
		if (!bucketName) return;
		setRunning(true);
		setStartedAt(Date.now());
		setElapsed(0);
		setError(null);
		setResult(null);
		try {
			const res = await fetch("/api/admin/speedtest/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ bucketName, sizeMb, iterations }),
			});
			if (!res.ok) {
				throw new Error(await res.text());
			}
			const payload = (await res.json()) as SpeedtestRunResponse;
			setResult(payload.result);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Speed test failed");
		} finally {
			setRunning(false);
		}
	};

	const stat = useMemo(() => {
		if (!result) return null;
		const upMbps =
			result.totals.uploadMs > 0
				? result.totals.bytesUp /
					(1024 * 1024) /
					(result.totals.uploadMs / 1000)
				: 0;
		const downColdMbps =
			result.totals.downloadColdMs > 0
				? result.totals.bytesDown /
					(1024 * 1024) /
					(result.totals.downloadColdMs / 1000)
				: 0;
		const downWarmMbps =
			result.totals.downloadWarmMs > 0
				? result.totals.bytesDown /
					(1024 * 1024) /
					(result.totals.downloadWarmMs / 1000)
				: 0;
		const cacheBoost =
			downColdMbps > 0 ? (downWarmMbps / downColdMbps - 1) * 100 : 0;
		return { upMbps, downColdMbps, downWarmMbps, cacheBoost };
	}, [result]);

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
							Admin-only synthetic performance benchmark for upload, cold
							download, warm/cache download, and latency.
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

					{error ? <div className="text-sm text-red-400">{error}</div> : null}

					{stat && result ? (
						<>
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

							<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
								<StatCard
									label="Latency Avg"
									value={`${result.latency.avgMs.toFixed(1)} ms`}
								/>
								<StatCard
									label="Latency P95"
									value={`${result.latency.p95Ms.toFixed(1)} ms`}
								/>
								<StatCard
									label="Traffic Volume"
									value={`${formatBytes(result.totals.bytesUp)} up / ${formatBytes(result.totals.bytesDown)} down`}
								/>
							</div>

							<div className="bg-black/30 border border-white/10 rounded-2xl overflow-hidden">
								<div className="px-4 py-3 border-b border-white/10 text-sm font-bold text-white">
									Detailed Iterations
								</div>
								<div className="overflow-x-auto">
									<table className="w-full text-left text-xs">
										<thead className="bg-white/5 text-text-muted uppercase tracking-wider">
											<tr>
												<th className="px-4 py-2">#</th>
												<th className="px-4 py-2">Key</th>
												<th className="px-4 py-2">Upload</th>
												<th className="px-4 py-2">Cold DL</th>
												<th className="px-4 py-2">Warm DL</th>
												<th className="px-4 py-2">X-Cache</th>
											</tr>
										</thead>
										<tbody className="divide-y divide-white/5">
											{result.iterationsDetail.map((row) => (
												<tr key={row.key} className="hover:bg-white/5">
													<td className="px-4 py-2 text-white">
														{row.index + 1}
													</td>
													<td className="px-4 py-2 font-mono text-text-muted">
														{row.key}
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
