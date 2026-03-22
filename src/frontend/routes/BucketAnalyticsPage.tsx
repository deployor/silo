import { useCallback, useEffect, useMemo, useState } from "react";
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

type TimeseriesResponse = { series: Array<Record<string, unknown>> };
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
	series: Array<Record<string, unknown>>;
	objects: HotObjectsResponse["objects"];
};

export function BucketAnalyticsPage({
	bootstrap,
}: {
	bootstrap: AppBootstrap;
}) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		bucketName: string;
		breadcrumbs?: string;
		bucketAccess?: { isCollaborative?: boolean; ownerId?: string };
	};
	const [summary, setSummary] = useState<SummaryResponse | null>(null);
	const [series, setSeries] = useState<TimeseriesResponse["series"]>([]);
	const [objects, setObjects] = useState<HotObjectsResponse["objects"]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const bucketName = p.bucketName;

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
							<p className="text-text-muted mt-2 max-w-2xl">
								Live, privacy-safe traffic and quota diagnostics for
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

				<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
					{[
						[
							"Requests (24h)",
							String(summary?.snapshot?.requestCount24h || 0),
							"ph-lightning",
						],
						[
							"Egress (24h)",
							formatBytes(summary?.snapshot?.egressBytes24h || 0),
							"ph-file-video",
						],
						[
							"Ingress (24h)",
							formatBytes(summary?.snapshot?.ingressBytes24h || 0),
							"ph-cloud-arrow-up",
						],
						[
							"Errors (24h)",
							String(summary?.snapshot?.errorCount24h || 0),
							"ph-warning",
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

				<div className="grid grid-cols-1 xl:grid-cols-[1.3fr_0.9fr] gap-6">
					<div className="bg-hc-dark rounded-3xl border border-white/10 p-6 card-shadow">
						<h2 className="text-xl font-bold text-white mb-4">
							Traffic timeline
						</h2>
						<div className="space-y-3 max-h-[30rem] overflow-auto">
							{series.length === 0 && !loading ? (
								<p className="text-text-muted text-sm">
									No traffic series yet.
								</p>
							) : (
								series.map((point, index) => {
									const pointKey = String(
										point.minuteStart || point.minute_start || `point-${index}`,
									);
									return (
										<div
											key={pointKey}
											className="flex items-center justify-between rounded-xl bg-black/20 border border-white/10 px-4 py-3 text-sm"
										>
											<span className="font-mono text-text-muted">
												{pointKey}
											</span>
											<span className="text-white">
												{String(point.requestCount || 0)} req
											</span>
											<span className="text-white/80">
												{formatBytes(Number(point.egressBytes || 0))}
											</span>
										</div>
									);
								})
							)}
						</div>
					</div>

					<div className="bg-hc-dark rounded-3xl border border-white/10 p-6 card-shadow">
						<h2 className="text-xl font-bold text-white mb-4">Top objects</h2>
						<div className="space-y-3 max-h-[30rem] overflow-auto">
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

				<div className="bg-hc-dark rounded-3xl border border-white/10 p-6 card-shadow">
					<h2 className="text-xl font-bold text-white mb-4">Diagnostics</h2>
					{error ? <p className="text-red-400 text-sm">{error}</p> : null}
					<div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
						<div className="rounded-xl bg-black/20 border border-white/10 p-4">
							<p className="text-text-muted">Average latency (24h)</p>
							<p className="text-white text-xl font-bold mt-2">
								{(summary?.snapshot?.avgLatencyMs24h || 0).toFixed(1)} ms
							</p>
						</div>
						<div className="rounded-xl bg-black/20 border border-white/10 p-4">
							<p className="text-text-muted">Peak minute (24h)</p>
							<p className="text-white text-xl font-bold mt-2">
								{summary?.snapshot?.peakMinuteRequests24h || 0}
							</p>
						</div>
						<div className="rounded-xl bg-black/20 border border-white/10 p-4">
							<p className="text-text-muted">Rate limited (24h)</p>
							<p className="text-white text-xl font-bold mt-2">
								{summary?.snapshot?.status42924h || 0}
							</p>
						</div>
					</div>
				</div>
			</div>
		</AppShell>
	);
}
