import { useCallback, useEffect, useState } from "react";
import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/ui/Modal";
import { PhIcon } from "../components/ui/PhIcon";
import { fetchJson } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type LogItem = {
	id: string;
	method: string;
	path: string;
	statusCode: number;
	latencyMs?: number | null;
	createdAt: string;
	bucketName?: string | null;
	ownerEmail?: string | null;
	ipAddress?: string | null;
	ingressBytes: number;
	egressBytes: number;
	userAgent?: string | null;
	requesterId?: string | null;
	requestId?: string | null;
};

type LogsResponse = {
	logs: LogItem[];
	total: number;
	limit: number;
	offset: number;
};

export function AdminLogsPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		pageTitle?: string;
	};

	const [logs, setLogs] = useState<LogItem[]>([]);
	const [total, setTotal] = useState(0);
	const [offset, setOffset] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [search, setSearch] = useState("");
	const [bucket, setBucket] = useState("");
	const [method, setMethod] = useState("");
	const [status, setStatus] = useState("");
	const [ip, setIp] = useState("");
	const [showFilters, setShowFilters] = useState(false);

	const [sortBy, setSortBy] = useState("createdAt");
	const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

	const [selected, setSelected] = useState<LogItem | null>(null);

	const limit = 50;

	const methodColor = (m: string) => {
		if (m === "GET") return "text-hc-red";
		if (m === "PUT") return "text-yellow-400";
		if (m === "DELETE") return "text-red-400";
		return "text-white";
	};

	const statusColor = (s: number) => {
		if (s >= 500) return "text-red-400";
		if (s >= 400) return "text-yellow-400";
		return "text-emerald-400";
	};

	const loadLogs = useCallback(
		async (reset = false) => {
			if (loading) return;
			setLoading(true);
			setError(null);

			const nextOffset = reset ? 0 : offset;
			const q = new URLSearchParams({
				limit: String(limit),
				offset: String(nextOffset),
				search,
				sortBy,
				sortOrder,
			});
			if (bucket) q.set("bucket", bucket);
			if (method) q.set("method", method);
			if (status) q.set("status", status);
			if (ip) q.set("ip", ip);

			try {
				const data = await fetchJson<LogsResponse>(
					`/api/admin/logs?${q.toString()}`,
				);
				setTotal(data.total || 0);
				if (reset) {
					setLogs(data.logs || []);
					setOffset((data.logs || []).length);
				} else {
					setLogs((prev: LogItem[]) => [...prev, ...(data.logs || [])]);
					setOffset(nextOffset + (data.logs || []).length);
				}
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to load logs");
			} finally {
				setLoading(false);
			}
		},
		[bucket, ip, loading, method, offset, search, sortBy, sortOrder, status],
	);

	const onSort = (field: string) => {
		if (sortBy === field) {
			setSortOrder((prev: "asc" | "desc") =>
				prev === "desc" ? "asc" : "desc",
			);
		} else {
			setSortBy(field);
			setSortOrder("desc");
		}
		window.setTimeout(() => loadLogs(true), 0);
	};

	const clearFilters = () => {
		setBucket("");
		setMethod("");
		setStatus("");
		setIp("");
		setSearch("");
		window.setTimeout(() => loadLogs(true), 0);
	};

	useEffect(() => {
		if (!logs.length && !loading && !error) {
			loadLogs(true);
		}
	}, [error, loadLogs, loading, logs.length]);

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			pageTitle={p.pageTitle || "ADMIN"}
			config={bootstrap.config}
		>
			<AdminSubnav active="logs" />

			<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow mb-8">
				<div className="p-6 border-b border-white/10 flex justify-between items-center">
					<div>
						<h2 className="text-xl font-bold text-white">Request Logs</h2>
						<p className="text-text-muted text-sm mt-1">
							View all request logs across all buckets.
						</p>
					</div>
					<div className="flex flex-col gap-4 items-end">
						<div className="flex items-center gap-4">
							<div className="text-xs text-text-muted font-mono">
								Showing {offset} of {total} logs
							</div>
							<input
								type="text"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && loadLogs(true)}
								placeholder="Search logs..."
								className="bg-black/30 border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-hc-red focus:ring-1 focus:ring-hc-red font-mono placeholder-white/20 transition-colors text-sm w-64"
							/>
							<button
								type="button"
								onClick={() => loadLogs(true)}
								className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-3 py-2 rounded-lg text-sm font-bold transition-colors"
							>
								Search
							</button>
							<button
								type="button"
								onClick={() => setShowFilters((v) => !v)}
								className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-3 py-2 rounded-lg text-sm font-bold transition-colors flex items-center gap-2"
							>
								<PhIcon className="ph ph-funnel" /> Filters
							</button>
						</div>

						{showFilters ? (
							<div className="flex flex-wrap gap-2 items-center bg-black/20 p-3 rounded-xl border border-white/5 w-full justify-end">
								<input
									value={bucket}
									onChange={(e) => setBucket(e.target.value)}
									type="text"
									placeholder="Bucket Name"
									className="bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-hc-red w-32"
								/>
								<select
									value={method}
									onChange={(e) => setMethod(e.target.value)}
									className="bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-hc-red cursor-pointer"
								>
									<option value="">All Methods</option>
									<option value="GET">GET</option>
									<option value="PUT">PUT</option>
									<option value="DELETE">DELETE</option>
									<option value="HEAD">HEAD</option>
									<option value="POST">POST</option>
								</select>
								<input
									value={status}
									onChange={(e) => setStatus(e.target.value)}
									type="number"
									placeholder="Status Code"
									className="bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-hc-red w-24"
								/>
								<input
									value={ip}
									onChange={(e) => setIp(e.target.value)}
									type="text"
									placeholder="IP Address"
									className="bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-hc-red w-32"
								/>
								<button
									type="button"
									onClick={() => loadLogs(true)}
									className="bg-hc-red hover:bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition-colors"
								>
									Apply
								</button>
								<button
									type="button"
									onClick={clearFilters}
									className="text-text-muted hover:text-white text-xs underline ml-2"
								>
									Clear
								</button>
							</div>
						) : null}
					</div>
				</div>

				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
							<tr>
								<th
									className="px-6 py-4 cursor-pointer hover:text-white transition-colors"
									onClick={() => onSort("createdAt")}
								>
									Time
								</th>
								<th className="px-6 py-4">Method</th>
								<th
									className="px-6 py-4 cursor-pointer hover:text-white transition-colors"
									onClick={() => onSort("statusCode")}
								>
									Status
								</th>
								<th className="px-6 py-4">Path</th>
								<th className="px-6 py-4">Bucket</th>
								<th className="px-6 py-4">User</th>
								<th className="px-6 py-4">IP</th>
								<th className="px-6 py-4">User Agent</th>
								<th
									className="px-6 py-4 cursor-pointer hover:text-white transition-colors"
									onClick={() => onSort("ingressBytes")}
								>
									Ingress
								</th>
								<th
									className="px-6 py-4 cursor-pointer hover:text-white transition-colors"
									onClick={() => onSort("egressBytes")}
								>
									Egress
								</th>
								<th
									className="px-6 py-4 text-right cursor-pointer hover:text-white transition-colors"
									onClick={() => onSort("latencyMs")}
								>
									Latency
								</th>
								<th className="px-6 py-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/5">
							{logs.map((log) => (
								<tr key={log.id} className="hover:bg-white/5 transition-colors">
									<td className="px-6 py-4 font-mono text-xs text-text-muted whitespace-nowrap">
										{new Date(log.createdAt).toLocaleString()}
									</td>
									<td
										className={`px-6 py-4 font-bold text-xs ${methodColor(log.method)}`}
									>
										{log.method}
									</td>
									<td
										className={`px-6 py-4 font-bold text-xs ${statusColor(log.statusCode)}`}
									>
										{log.statusCode}
									</td>
									<td
										className="px-6 py-4 font-mono text-xs text-white truncate max-w-xs"
										title={log.path}
									>
										{log.path}
									</td>
									<td className="px-6 py-4 font-mono text-xs text-text-muted">
										{log.bucketName || "-"}
									</td>
									<td
										className="px-6 py-4 font-mono text-xs text-text-muted truncate max-w-[150px]"
										title={log.ownerEmail || ""}
									>
										{log.ownerEmail || "-"}
									</td>
									<td className="px-6 py-4 font-mono text-xs text-text-muted">
										{log.ipAddress || "-"}
									</td>
									<td
										className="px-6 py-4 font-mono text-xs text-text-muted truncate max-w-[150px]"
										title={log.userAgent || ""}
									>
										{log.userAgent
											? `${log.userAgent.slice(0, 20)}${log.userAgent.length > 20 ? "..." : ""}`
											: "-"}
									</td>
									<td className="px-6 py-4 font-mono text-xs text-text-muted">
										{formatBytes(log.ingressBytes)}
									</td>
									<td className="px-6 py-4 font-mono text-xs text-text-muted">
										{formatBytes(log.egressBytes)}
									</td>
									<td className="px-6 py-4 text-right font-mono text-xs text-text-muted">
										{log.latencyMs ? `${log.latencyMs}ms` : "-"}
									</td>
									<td className="px-6 py-4 text-right">
										<button
											type="button"
											onClick={() => setSelected(log)}
											className="text-hc-red hover:text-hc-red text-xs font-bold uppercase tracking-wider"
										>
											View
										</button>
									</td>
								</tr>
							))}

							{!loading && logs.length === 0 ? (
								<tr>
									<td
										colSpan={12}
										className="px-6 py-8 text-center text-text-muted italic"
									>
										No logs found.
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
							onClick={() => loadLogs(false)}
							className="text-text-muted hover:text-white text-sm font-bold transition-colors"
						>
							Load More
						</button>
					) : null}
					{loading ? (
						<span className="text-text-muted text-sm">Loading...</span>
					) : null}
				</div>
			</div>

			<Modal
				open={!!selected}
				onClose={() => setSelected(null)}
				title="Log Details"
				className="max-w-3xl p-0"
			>
				{selected ? (
					<div className="p-6">
						<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
							<Card title="Method" value={selected.method} />
							<Card title="Status Code" value={String(selected.statusCode)} />
						</div>
						<div className="bg-black/30 p-4 rounded-xl border border-white/10 mb-4">
							<div className="text-xs text-text-muted uppercase font-bold mb-1">
								Path
							</div>
							<div className="text-white font-mono break-all text-sm">
								{selected.path}
							</div>
						</div>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
							<Card title="Bucket" value={selected.bucketName || "-"} />
							<Card title="Owner" value={selected.ownerEmail || "-"} />
						</div>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
							<Card
								title="Ingress"
								value={formatBytes(selected.ingressBytes)}
							/>
							<Card title="Egress" value={formatBytes(selected.egressBytes)} />
						</div>
						<div className="bg-black/30 p-4 rounded-xl border border-white/10 mb-4">
							<div className="text-xs text-text-muted uppercase font-bold mb-1">
								User Agent
							</div>
							<div className="text-white font-mono text-xs break-all max-h-32 overflow-y-auto">
								{selected.userAgent || "-"}
							</div>
						</div>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
							<Card title="IP Address" value={selected.ipAddress || "-"} />
							<Card
								title="Latency"
								value={selected.latencyMs ? `${selected.latencyMs}ms` : "-"}
							/>
						</div>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
							<Card title="Requester ID" value={selected.requesterId || "-"} />
							<Card
								title="Timestamp"
								value={new Date(selected.createdAt).toLocaleString()}
							/>
						</div>
						<div className="mt-4 bg-black/30 p-4 rounded-xl border border-white/10">
							<div className="text-xs text-text-muted uppercase font-bold mb-1">
								Request ID
							</div>
							<div className="text-white font-mono text-xs break-all">
								{selected.requestId || selected.id}
							</div>
						</div>
					</div>
				) : null}
			</Modal>
		</AppShell>
	);
}

function Card({ title, value }: { title: string; value: string }) {
	return (
		<div className="bg-black/30 p-4 rounded-xl border border-white/10">
			<div className="text-xs text-text-muted uppercase font-bold mb-1">
				{title}
			</div>
			<div className="text-white font-mono text-lg break-all">{value}</div>
		</div>
	);
}
