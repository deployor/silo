import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
import { fetchJson, fetchText } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type BucketRow = {
	id: string;
	name: string;
	userId: string | null;
	ownerEmail: string | null;
	ownerSlackId: string | null;
	isPaused: boolean;
	pauseReason: string | null;
	totalBytes: number;
	totalRequests: number;
	getRequests: number;
	putRequests: number;
	deleteRequests: number;
	headRequests: number;
	egressBytes: number;
	ingressBytes: number;
	updatedAt: string | null;
	createdAt: string | null;
};

type BucketsResponse = {
	buckets: BucketRow[];
	total: number;
	limit: number;
	offset: number;
};

const SORT_OPTIONS = [
	{ value: "totalRequests", label: "Most Active" },
	{ value: "getRequests", label: "Most GETs" },
	{ value: "putRequests", label: "Most PUTs" },
	{ value: "egressBytes", label: "Highest Egress" },
	{ value: "totalBytes", label: "Highest Storage" },
	{ value: "name", label: "Bucket Name" },
	{ value: "updatedAt", label: "Recently Updated" },
] as const;

export function AdminBucketsPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		pageTitle?: string;
	};

	const [rows, setRows] = useState<BucketRow[]>([]);
	const [search, setSearch] = useState("");
	const [pausedOnly, setPausedOnly] = useState(false);
	const [offset, setOffset] = useState(0);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [sortBy, setSortBy] = useState<string>("totalRequests");
	const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
	const [error, setError] = useState<string | null>(null);

	const limit = 50;

	const loadBuckets = useCallback(
		async (reset = true) => {
			if (loading) return;
			setLoading(true);
			setError(null);
			const nextOffset = reset ? 0 : offset;
			const q = new URLSearchParams({
				limit: String(limit),
				offset: String(nextOffset),
				search,
				pausedOnly: String(pausedOnly),
				sortBy,
				sortOrder,
			});

			try {
				const data = await fetchJson<BucketsResponse>(
					`/api/admin/buckets?${q.toString()}`,
				);
				setTotal(data.total || 0);
				if (reset) {
					setRows(data.buckets || []);
					setOffset((data.buckets || []).length);
				} else {
					setRows((prev) => [...prev, ...(data.buckets || [])]);
					setOffset(nextOffset + (data.buckets || []).length);
				}
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to load buckets");
			} finally {
				setLoading(false);
			}
		},
		[loading, offset, pausedOnly, search, sortBy, sortOrder],
	);

	useEffect(() => {
		if (!rows.length && !loading && !error) {
			void loadBuckets(true);
		}
	}, [error, loadBuckets, loading, rows.length]);

	const togglePause = async (row: BucketRow) => {
		const next = !row.isPaused;
		let reason: string | null = null;
		if (next) {
			reason =
				window.prompt("Enter reason for pausing bucket (optional):") || null;
		}
		setActionLoading(row.id);
		try {
			await fetchText(`/api/admin/buckets/${row.name}/pause`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ isPaused: next, pauseReason: reason }),
			});
			setRows((prev) =>
				prev.map((item) =>
					item.id === row.id
						? {
								...item,
								isPaused: next,
								pauseReason: next ? reason : null,
							}
						: item,
				),
			);
		} catch (e) {
			window.alert(
				e instanceof Error ? e.message : "Failed to update bucket status",
			);
		} finally {
			setActionLoading(null);
		}
	};

	const topHot = useMemo(() => {
		if (!rows.length) return null;
		const sorted = [...rows].sort((a, b) => b.totalRequests - a.totalRequests);
		return sorted[0] || null;
	}, [rows]);

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			pageTitle={p.pageTitle || "ADMIN"}
			config={bootstrap.config}
		>
			<AdminSubnav active="buckets" />

			<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow mb-8">
				<div className="p-6 border-b border-white/10 flex justify-between items-center gap-4 flex-wrap">
					<div>
						<h2 className="text-xl font-bold text-white">Buckets</h2>
						<p className="text-text-muted text-sm mt-1">
							Monitor bucket owners, usage, request activity, and moderation
							state.
						</p>
						{topHot ? (
							<p className="mt-2 text-xs text-hc-red/90">
								Most active:{" "}
								<span className="font-mono text-white">{topHot.name}</span> with{" "}
								<span className="font-bold text-white">
									{topHot.totalRequests.toLocaleString()} requests
								</span>
							</p>
						) : null}
					</div>

					<div className="flex items-center gap-3 flex-wrap">
						<div className="text-xs text-text-muted font-mono">
							Showing {offset} of {total} buckets
						</div>
						<input
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && void loadBuckets(true)}
							placeholder="Search bucket / owner / user id"
							className="bg-black/30 border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-hc-red text-sm w-72"
						/>
						<select
							value={sortBy}
							onChange={(e) => setSortBy(e.target.value)}
							className="bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"
						>
							{SORT_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
						<button
							type="button"
							onClick={() =>
								setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"))
							}
							className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-3 py-2 rounded-lg text-sm font-bold"
						>
							{sortOrder === "desc" ? "↓ Desc" : "↑ Asc"}
						</button>
						<label className="inline-flex items-center cursor-pointer">
							<input
								type="checkbox"
								checked={pausedOnly}
								onChange={(e) => setPausedOnly(e.target.checked)}
								className="sr-only peer"
							/>
							<div className="relative w-9 h-5 bg-white/10 rounded-full peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-hc-red peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:start-0.5 after:bg-white after:border after:border-gray-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-hc-red" />
							<span className="ms-2 text-xs font-medium text-text-muted peer-checked:text-white">
								Paused only
							</span>
						</label>
						<button
							type="button"
							onClick={() => void loadBuckets(true)}
							className="bg-hc-red hover:bg-red-600 text-white px-3 py-2 rounded-lg text-sm font-bold"
						>
							Search
						</button>
					</div>
				</div>

				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
							<tr>
								<th className="px-6 py-4">Bucket</th>
								<th className="px-6 py-4">Owner</th>
								<th className="px-6 py-4">Storage</th>
								<th className="px-6 py-4">Egress</th>
								<th className="px-6 py-4">Requests</th>
								<th className="px-6 py-4">Method Mix</th>
								<th className="px-6 py-4">Status</th>
								<th className="px-6 py-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/5">
							{rows.map((row) => (
								<tr key={row.id} className="hover:bg-white/5 transition-colors">
									<td className="px-6 py-4">
									<div className="font-mono text-white flex items-center gap-2">
										{row.name}
									</div>
										<div className="text-[11px] text-text-muted font-mono">
											{row.id}
										</div>
									</td>
									<td className="px-6 py-4">
										<a
											href={`/admin/users?search=${encodeURIComponent(row.userId || "")}`}
											className="inline-flex items-center gap-3 hover:opacity-90"
										>
											{row.ownerSlackId ? (
												<img
													src={`https://cachet.dunkirk.sh/users/${row.ownerSlackId}/r`}
													className="w-8 h-8 rounded-full bg-white/10"
													alt=""
												/>
											) : (
												<div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-xs text-text-muted">
													?
												</div>
											)}
											<div>
												<div className="text-white text-sm">
													{row.ownerEmail || "Unknown owner"}
												</div>
												<div className="text-[11px] text-text-muted font-mono">
													{row.userId || "-"}
												</div>
											</div>
										</a>
									</td>
									<td className="px-6 py-4 font-mono text-xs text-white">
										{formatBytes(row.totalBytes || 0)}
									</td>
									<td className="px-6 py-4 font-mono text-xs text-white">
										{formatBytes(row.egressBytes || 0)}
									</td>
									<td className="px-6 py-4 font-mono text-xs text-white">
										{(row.totalRequests || 0).toLocaleString()}
									</td>
									<td className="px-6 py-4 font-mono text-[11px] text-text-muted">
										<div>GET: {row.getRequests.toLocaleString()}</div>
										<div>PUT: {row.putRequests.toLocaleString()}</div>
										<div>DELETE: {row.deleteRequests.toLocaleString()}</div>
									</td>
									<td className="px-6 py-4">
										{row.isPaused ? (
											<div className="flex flex-col items-start">
												<span className="text-red-400 text-xs font-bold">
													PAUSED
												</span>
												{row.pauseReason ? (
													<span
														className="text-[10px] text-red-300 max-w-[180px] truncate"
														title={row.pauseReason}
													>
														{row.pauseReason}
													</span>
												) : null}
											</div>
										) : (
											<span className="text-emerald-400 text-xs font-bold">
												ACTIVE
											</span>
										)}
									</td>
									<td className="px-6 py-4 text-right">
										<div className="flex items-center justify-end gap-3">
											<a
												href={`/admin/buckets/${row.name}/analytics`}
												className="text-emerald-300 hover:text-emerald-200 text-xs font-bold uppercase tracking-wider"
											>
												Analytics
											</a>
											<button
												type="button"
												onClick={() => void togglePause(row)}
												disabled={actionLoading === row.id}
												className={`text-xs font-bold uppercase tracking-wider ${
													row.isPaused
														? "text-emerald-400 hover:text-emerald-300"
														: "text-yellow-400 hover:text-yellow-300"
												}`}
											>
												{actionLoading === row.id
													? "Updating..."
													: row.isPaused
														? "Resume"
														: "Pause"}
											</button>
										</div>
									</td>
								</tr>
							))}
							{!loading && rows.length === 0 ? (
								<tr>
									<td
										colSpan={8}
										className="px-6 py-8 text-center text-text-muted italic"
									>
										No buckets found.
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>

				<div className="p-4 border-t border-white/10 flex justify-center">
					{error ? <span className="text-red-400 text-sm">{error}</span> : null}
					{!loading && offset < total ? (
						<button
							type="button"
							onClick={() => void loadBuckets(false)}
							className="text-text-muted hover:text-white text-sm font-bold"
						>
							Load More
						</button>
					) : null}
					{loading ? (
						<span className="text-text-muted text-sm">Loading...</span>
					) : null}
				</div>
			</div>
		</AppShell>
	);
}
