import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
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

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			pageTitle={p.pageTitle || "ADMIN"}
			config={bootstrap.config}
		>
			<AdminSubnav active="cache" />

			<div className="flex items-center justify-between mb-6">
				<h2 className="text-2xl font-bold text-white">
					<i className="ph ph-database mr-2" />
					Cache Statistics
				</h2>
				<div className="flex items-center gap-3">
					<span className="text-xs text-white/40">
						{updated ? `Updated ${updated}` : ""}
					</span>
					<button
						type="button"
						onClick={load}
						className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-3 py-2 rounded-lg text-sm font-bold transition-colors"
					>
						<i className="ph ph-arrows-clockwise mr-1" /> Refresh
					</button>
				</div>
			</div>

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
					<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
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
								["Threshold", String(stats.disk?.admissionThreshold ?? "-")],
							]}
							extra={
								<div className="mt-4">
									<div className="w-full bg-white/10 rounded-full h-2">
										<div
											className="bg-hc-primary rounded-full h-2 transition-all duration-500"
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
								["Connections", stats.redis?.connectedClients || "-"],
							]}
						/>
					</div>

					<div className="bg-black/30 p-6 rounded-xl border border-white/10 mb-6">
						<h3 className="text-white font-semibold mb-4">
							<i className="ph ph-key mr-1" /> Redis Key Breakdown
						</h3>
						<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
							{(stats.redis?.keyBreakdown || []).map((prefix) => (
								<div key={prefix.name} className="bg-white/5 p-3 rounded-lg">
									<div className="text-white/60 text-xs font-mono">
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
						<h3 className="text-white font-semibold mb-4">
							<i className="ph ph-fire mr-1" /> Top Hot Objects
						</h3>
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="text-white/40 text-left border-b border-white/10">
										<th className="pb-2 font-medium">Bucket</th>
										<th className="pb-2 font-medium">Key</th>
										<th className="pb-2 font-medium">Hits</th>
										<th className="pb-2 font-medium">Size</th>
									</tr>
								</thead>
								<tbody>
									{topHot.map((obj) => (
										<tr
											key={`${obj.bucket}:${obj.key}`}
											className="border-b border-white/5 text-white/80"
										>
											<td className="py-2 font-mono text-xs">{obj.bucket}</td>
											<td className="py-2 font-mono text-xs max-w-[300px] truncate">
												{obj.key}
											</td>
											<td className="py-2">
												<span className="px-2 py-0.5 bg-hc-primary/20 text-hc-primary rounded text-xs font-mono">
													{obj.hits}
												</span>
											</td>
											<td className="py-2 font-mono text-xs">
												{obj.sizeMB} MB
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				</>
			) : null}
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
	extra?: React.ReactNode;
}) {
	return (
		<div className="bg-black/30 p-6 rounded-xl border border-white/10">
			<div className="flex items-center gap-2 mb-4">
				<i className={`ph ${icon} text-hc-primary text-xl`} />
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
