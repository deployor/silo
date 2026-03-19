import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import { fetchJson } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";

type CacheStats = {
	redis?: {
		keyCount?: number;
		memoryUsed?: string;
		hitRate?: string;
		uptime?: string;
		connectedClients?: string;
		keyBreakdown?: Array<{ name: string; count: number }>;
	};
	disk?: {
		fileCount?: number;
		currentSize?: string;
		capacityPercent?: string;
		capacityPercentNum?: number;
		admissionThreshold?: number;
		topHotObjects?: Array<{
			bucket: string;
			key: string;
			hits: number;
			sizeMB: number;
		}>;
	};
	system?: {
		circuitState?: string;
		circuitFailures?: number;
		uptime?: string;
	};
};

export function AdminCachePage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		pageTitle?: string;
	};
	const [stats, setStats] = useState<CacheStats | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [updated, setUpdated] = useState<string>("");

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await fetchJson<CacheStats>("/api/admin/cache-stats");
			setStats(data);
			setUpdated(new Date().toLocaleTimeString());
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load cache stats");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
		const id = window.setInterval(load, 10000);
		return () => window.clearInterval(id);
	}, [load]);

	const topHot = useMemo(() => stats?.disk?.topHotObjects || [], [stats]);
	const circuitState = String(
		stats?.system?.circuitState || "unknown",
	).toLowerCase();
	const circuitTone =
		circuitState === "closed"
			? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
			: circuitState === "half-open"
				? "text-yellow-400 border-yellow-500/30 bg-yellow-500/10"
				: "text-red-400 border-red-500/30 bg-red-500/10";

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			pageTitle={p.pageTitle || "ADMIN"}
			config={bootstrap.config}
		>
			<AdminSubnav active="cache" />

			<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow mb-8">
				<div className="p-6 border-b border-white/10 flex justify-between items-start gap-4 flex-wrap">
					<div>
						<h2 className="text-xl font-bold text-white flex items-center gap-2">
							<PhIcon className="ph ph-database text-hc-blue" />
							Cache Observability
						</h2>
						<p className="text-text-muted text-sm mt-1">
							Realtime L1/L2 cache health, hot object pressure, and upstream
							stability.
						</p>
					</div>
					<div className="flex items-center gap-3 flex-wrap">
						<span className="text-xs text-text-muted font-mono">
							{updated ? `Updated ${updated}` : "Never updated"}
						</span>
						<span
							className={`text-[11px] px-2 py-1 rounded border font-bold uppercase ${circuitTone}`}
						>
							Circuit: {stats?.system?.circuitState || "unknown"}
						</span>
						<button
							type="button"
							onClick={load}
							className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-3 py-2 rounded-lg text-sm font-bold transition-colors"
						>
							<PhIcon className="ph ph-arrows-clockwise mr-1" /> Refresh
						</button>
					</div>
				</div>

				<div className="p-6">
					{loading && !stats ? (
						<p className="text-white/50">Loading cache stats...</p>
					) : null}
					{error ? (
						<div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">
							{error}
						</div>
					) : null}

					{stats ? (
						<>
							<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
								<StatCard
									title="Redis L1 Cache"
									icon="ph-lightning"
									rows={[
										["Keys", String(stats.redis?.keyCount ?? 0)],
										["Memory", stats.redis?.memoryUsed || "-"],
										["Hit Rate", stats.redis?.hitRate || "-"],
										["Uptime", stats.redis?.uptime || "-"],
									]}
								/>
								<StatCard
									title="Disk L2 Cache"
									icon="ph-hard-drives"
									rows={[
										["Files", String(stats.disk?.fileCount ?? 0)],
										["Size", stats.disk?.currentSize || "-"],
										["Capacity", stats.disk?.capacityPercent || "-"],
										[
											"Admission Threshold",
											String(stats.disk?.admissionThreshold ?? "-"),
										],
									]}
									extra={
										<div className="mt-4">
											<div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
												<div
													className="bg-hc-blue rounded-full h-2 transition-all duration-500"
													style={{
														width: `${stats.disk?.capacityPercentNum || 0}%`,
													}}
												/>
											</div>
										</div>
									}
								/>
								<StatCard
									title="System"
									icon="ph-heartbeat"
									rows={[
										["S3 Circuit", stats.system?.circuitState || "-"],
										["S3 Failures", String(stats.system?.circuitFailures ?? 0)],
										["Uptime", stats.system?.uptime || "-"],
										["Redis Connections", stats.redis?.connectedClients || "-"],
									]}
								/>
							</div>

							<div className="bg-black/30 p-6 rounded-xl border border-white/10 mb-6">
								<h3 className="text-white font-bold mb-4 flex items-center gap-2">
									<PhIcon className="ph ph-key text-hc-blue" />
									Redis Key Breakdown
								</h3>
								<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
									{(stats.redis?.keyBreakdown || []).map((prefix) => (
										<div
											key={prefix.name}
											className="bg-white/5 p-3 rounded-lg border border-white/10"
										>
											<div className="text-text-muted text-xs font-mono">
												{prefix.name}
											</div>
											<div className="text-white text-lg font-bold mt-1">
												{prefix.count}
											</div>
										</div>
									))}
								</div>
							</div>

							<div className="bg-black/30 p-6 rounded-xl border border-white/10">
								<h3 className="text-white font-bold mb-4 flex items-center gap-2">
									<PhIcon className="ph ph-fire text-hc-red" />
									Top Hot Objects
								</h3>
								<div className="overflow-x-auto">
									<table className="w-full text-sm">
										<thead className="text-text-muted text-left border-b border-white/10 uppercase tracking-wider text-xs">
											<tr>
												<th className="pb-2 font-bold">Bucket</th>
												<th className="pb-2 font-bold">Key</th>
												<th className="pb-2 font-bold">Hits</th>
												<th className="pb-2 font-bold">Size</th>
											</tr>
										</thead>
										<tbody>
											{topHot.map((obj) => (
												<tr
													key={`${obj.bucket}:${obj.key}`}
													className="border-b border-white/5 text-white/80"
												>
													<td className="py-2 font-mono text-xs">
														{obj.bucket}
													</td>
													<td className="py-2 font-mono text-xs max-w-[300px] truncate">
														{obj.key}
													</td>
													<td className="py-2">
														<span className="px-2 py-0.5 bg-hc-blue/20 text-hc-blue rounded text-xs font-mono">
															{obj.hits}
														</span>
													</td>
													<td className="py-2 font-mono text-xs">
														{obj.sizeMB} MB
													</td>
												</tr>
											))}
											{topHot.length === 0 ? (
												<tr>
													<td
														className="py-4 text-text-muted italic"
														colSpan={4}
													>
														No hot objects yet.
													</td>
												</tr>
											) : null}
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

function StatCard({
	title,
	icon,
	rows,
	extra,
}: {
	title: string;
	icon: string;
	rows: Array<[string, string]>;
	extra?: ReactNode;
}) {
	return (
		<div className="bg-black/30 p-6 rounded-xl border border-white/10">
			<div className="flex items-center gap-2 mb-4">
				<PhIcon className={`ph ${icon} text-hc-blue text-xl`} />
				<h3 className="text-white font-semibold">{title}</h3>
			</div>
			<div className="space-y-3">
				{rows.map(([k, v]) => (
					<div key={k} className="flex justify-between">
						<span className="text-white/60 text-sm">{k}</span>
						<span className="text-white font-mono text-sm">{v}</span>
					</div>
				))}
			</div>
			{extra}
		</div>
	);
}
