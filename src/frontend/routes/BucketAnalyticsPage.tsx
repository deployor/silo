import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Pie,
	PieChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import { fetchJson } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type SummaryResponse = {
	bucket: { name: string; ownerId: string; isAdminView: boolean };
	snapshot: {
		requestCount24h: number;
		egressBytes24h: number;
		ingressBytes24h: number;
		errorCount24h: number;
		status42924h: number;
		avgLatencyMs24h: number;
		peakMinuteRequests24h: number;
		peakMinuteAt24h?: string | null;
		hotObjectsJson: string;
		statusBreakdownJson: string;
		methodBreakdownJson: string;
		updatedAt: string;
	} | null;
	topErrors: Array<{ statusCode: number; count: number }>;
};

type TimeseriesPoint = Record<string, unknown>;
type TimeseriesResponse = { series: TimeseriesPoint[] };
type HotObjectsResponse = {
	objects: Array<{
		objectKey: string;
		hitCount: number;
		egressBytes: number;
		errorCount: number;
		lastAccessedAt?: string | null;
	}>;
};
type LiveResponse = {
	summary: SummaryResponse;
	series: TimeseriesPoint[];
	objects: HotObjectsResponse["objects"];
};

const CHART_COLORS = ["#14b8a6", "#3b82f6", "#f59e0b", "#ef4444"];

function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function minuteLabel(value: string) {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? value
		: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function BucketAnalyticsPage({
	bootstrap,
}: {
	bootstrap: AppBootstrap;
}) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		bucketName: string;
		breadcrumbs?: string;
	};
	const bucketName = p.bucketName;
	const [summary, setSummary] = useState<SummaryResponse | null>(null);
	const [series, setSeries] = useState<TimeseriesPoint[]>([]);
	const [objects, setObjects] = useState<HotObjectsResponse["objects"]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [summaryData, seriesData, objectsData] = await Promise.all([
				fetchJson<SummaryResponse>(
					`/api/dashboard/buckets/${bucketName}/analytics/summary`,
				),
				fetchJson<TimeseriesResponse>(
					`/api/dashboard/buckets/${bucketName}/analytics/timeseries?range=24h`,
				),
				fetchJson<HotObjectsResponse>(
					`/api/dashboard/buckets/${bucketName}/analytics/objects`,
				),
			]);
			setSummary(summaryData);
			setSeries(seriesData.series || []);
			setObjects(objectsData.objects || []);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Failed to load analytics",
			);
		} finally {
			setLoading(false);
		}
	}, [bucketName]);

	useEffect(() => {
		void load();
		const timer = window.setInterval(async () => {
			try {
				const live = await fetchJson<LiveResponse>(
					`/api/dashboard/buckets/${bucketName}/analytics/live`,
				);
				setSummary(live.summary);
				setSeries(live.series || []);
				setObjects(live.objects || []);
			} catch {}
		}, 15000);
		return () => window.clearInterval(timer);
	}, [bucketName, load]);

	const chartPoints = useMemo(
		() =>
			series.map((point, index) => {
				const requestCount = Number(
					point.requestCount || point.request_count || 0,
				);
				const latencyTotalMs = Number(
					point.latencyTotalMs || point.latency_total_ms || 0,
				);
				const key = String(
					point.minuteStart || point.minute_start || `point-${index}`,
				);
				return {
					key,
					label: minuteLabel(key),
					requests: requestCount,
					egressBytes: Number(point.egressBytes || point.egress_bytes || 0),
					errorCount: Number(point.errorCount || point.error_count || 0),
					latencyMs: requestCount > 0 ? latencyTotalMs / requestCount : 0,
				};
			}),
		[series],
	);

	const methodData = useMemo(() => {
		const parsed = parseJson<Record<string, number>>(
			summary?.snapshot?.methodBreakdownJson,
			{},
		);
		return Object.entries(parsed).map(([name, value]) => ({
			name: name.toUpperCase(),
			value,
		}));
	}, [summary?.snapshot?.methodBreakdownJson]);

	const statusData = useMemo(() => {
		const parsed = parseJson<Record<string, number>>(
			summary?.snapshot?.statusBreakdownJson,
			{},
		);
		return Object.entries(parsed).map(([name, value]) => ({ name, value }));
	}, [summary?.snapshot?.statusBreakdownJson]);

	const hotObjects = useMemo(() => objects.slice(0, 12), [objects]);

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
			breadcrumbs={p.breadcrumbs}
		>
			<div className="space-y-6">
				<div className="bg-hc-dark rounded-3xl border border-white/10 p-8 card-shadow">
					<div className="flex items-center justify-between gap-4 flex-wrap">
						<div>
							<h1 className="text-3xl font-black italic text-white tracking-tight">
								Bucket Analytics
							</h1>
							<p className="text-text-muted mt-2 max-w-3xl">
								Live, privacy-safe traffic intelligence for{" "}
								<span className="font-mono text-white">{bucketName}</span>.
							</p>
						</div>
						<a
							href={`/dashboard/buckets/${bucketName}`}
							className="bg-white/10 hover:bg-white/20 border border-white/10 text-white px-4 py-3 rounded-xl text-sm font-bold"
						>
							Back to files
						</a>
					</div>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
					{[
						[
							"Requests",
							String(summary?.snapshot?.requestCount24h || 0),
							"ph-lightning",
						],
						[
							"Egress",
							formatBytes(summary?.snapshot?.egressBytes24h || 0),
							"ph-file-video",
						],
						[
							"Ingress",
							formatBytes(summary?.snapshot?.ingressBytes24h || 0),
							"ph-cloud-arrow-up",
						],
						[
							"Errors",
							String(summary?.snapshot?.errorCount24h || 0),
							"ph-warning",
						],
						[
							"Avg latency",
							`${(summary?.snapshot?.avgLatencyMs24h || 0).toFixed(1)} ms`,
							"ph-heartbeat",
						],
					].map(([label, value, icon]) => (
						<div
							key={String(label)}
							className="bg-hc-dark rounded-2xl border border-white/10 p-5"
						>
							<div className="flex items-center gap-3 text-text-muted text-sm">
								<PhIcon className={`ph ${icon} text-hc-blue text-lg`} />
								<span>{label}</span>
							</div>
							<div className="text-white text-2xl font-bold mt-3">{value}</div>
						</div>
					))}
				</div>

				<div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
					<div className="bg-hc-dark rounded-3xl border border-white/10 p-6 card-shadow">
						<h2 className="text-xl font-bold text-white mb-4">
							Requests over time
						</h2>
						<div className="h-72">
							<ResponsiveContainer width="100%" height="100%">
								<AreaChart data={chartPoints}>
									<CartesianGrid
										stroke="rgba(255,255,255,0.08)"
										vertical={false}
									/>
									<XAxis dataKey="label" stroke="rgba(255,255,255,0.35)" />
									<YAxis stroke="rgba(255,255,255,0.35)" />
									<Tooltip />
									<Area
										type="monotone"
										dataKey="requests"
										stroke="#3b82f6"
										fill="#3b82f633"
									/>
								</AreaChart>
							</ResponsiveContainer>
						</div>
					</div>

					<div className="bg-hc-dark rounded-3xl border border-white/10 p-6 card-shadow">
						<h2 className="text-xl font-bold text-white mb-4">
							Bandwidth burn
						</h2>
						<div className="h-72">
							<ResponsiveContainer width="100%" height="100%">
								<BarChart data={chartPoints}>
									<CartesianGrid
										stroke="rgba(255,255,255,0.08)"
										vertical={false}
									/>
									<XAxis dataKey="label" stroke="rgba(255,255,255,0.35)" />
									<YAxis stroke="rgba(255,255,255,0.35)" />
									<Tooltip
										formatter={(value: number) => formatBytes(value || 0)}
									/>
									<Bar
										dataKey="egressBytes"
										fill="#14b8a6"
										radius={[6, 6, 0, 0]}
									/>
								</BarChart>
							</ResponsiveContainer>
						</div>
					</div>
				</div>

				<div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
					<div className="bg-hc-dark rounded-3xl border border-white/10 p-6 card-shadow">
						<h2 className="text-xl font-bold text-white mb-4">Method mix</h2>
						<div className="h-64">
							<ResponsiveContainer width="100%" height="100%">
								<PieChart>
									<Pie
										data={methodData}
										dataKey="value"
										nameKey="name"
										innerRadius={55}
										outerRadius={85}
										paddingAngle={3}
									>
										{methodData.map((entry, index) => (
											<Cell
												key={entry.name}
												fill={CHART_COLORS[index % CHART_COLORS.length]}
											/>
										))}
									</Pie>
									<Tooltip />
								</PieChart>
							</ResponsiveContainer>
						</div>
					</div>

					<div className="bg-hc-dark rounded-3xl border border-white/10 p-6 card-shadow">
						<h2 className="text-xl font-bold text-white mb-4">Status mix</h2>
						<div className="h-64">
							<ResponsiveContainer width="100%" height="100%">
								<PieChart>
									<Pie
										data={statusData}
										dataKey="value"
										nameKey="name"
										innerRadius={55}
										outerRadius={85}
										paddingAngle={3}
									>
										{statusData.map((entry, index) => (
											<Cell
												key={entry.name}
												fill={CHART_COLORS[index % CHART_COLORS.length]}
											/>
										))}
									</Pie>
									<Tooltip />
								</PieChart>
							</ResponsiveContainer>
						</div>
					</div>

					<div className="bg-hc-dark rounded-3xl border border-white/10 p-6 card-shadow">
						<h2 className="text-xl font-bold text-white mb-4">Diagnostics</h2>
						<div className="space-y-4 text-sm">
							<div className="rounded-xl bg-black/20 border border-white/10 p-4">
								<p className="text-text-muted">Peak minute</p>
								<p className="text-white text-2xl font-bold mt-2">
									{summary?.snapshot?.peakMinuteRequests24h || 0} req/min
								</p>
							</div>
							<div className="rounded-xl bg-black/20 border border-white/10 p-4">
								<p className="text-text-muted">Rate limited</p>
								<p className="text-white text-2xl font-bold mt-2">
									{summary?.snapshot?.status42924h || 0}
								</p>
							</div>
							<div className="rounded-xl bg-black/20 border border-white/10 p-4">
								<p className="text-text-muted">Owner</p>
								<p className="text-white text-lg font-bold mt-2 break-all">
									{summary?.bucket?.ownerId || "-"}
								</p>
							</div>
							{error ? <p className="text-red-400 text-sm">{error}</p> : null}
						</div>
					</div>
				</div>

				<div className="bg-hc-dark rounded-3xl border border-white/10 p-6 card-shadow">
					<h2 className="text-xl font-bold text-white mb-4">Hottest objects</h2>
					<div className="space-y-3 max-h-[32rem] overflow-auto">
						{hotObjects.length === 0 && !loading ? (
							<p className="text-text-muted text-sm">
								No object analytics yet.
							</p>
						) : (
							hotObjects.map((object) => (
								<div
									key={object.objectKey}
									className="rounded-xl bg-black/20 border border-white/10 p-4"
								>
									<p className="font-mono text-white text-sm break-all">
										{object.objectKey}
									</p>
									<div className="mt-2 flex flex-wrap gap-3 text-xs text-text-muted">
										<span>{object.hitCount} hits</span>
										<span>{formatBytes(object.egressBytes || 0)} egress</span>
										<span>{object.errorCount} errors</span>
									</div>
								</div>
							))
						)}
					</div>
				</div>
			</div>
		</AppShell>
	);
}
