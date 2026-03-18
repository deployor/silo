import { useCallback, useEffect, useState } from "react";
import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/ui/Modal";
import { fetchJson, fetchText } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type UserRow = {
	id: string;
	email: string;
	slackId?: string | null;
	storageLimitBytes: number;
	storageUsageBytes: number;
	egressLimitBytes: number | null;
	egressBytes: number;
	isAdmin: boolean;
	isReviewer: boolean;
	isImmortal: boolean;
	isLocked: boolean;
	lockReason?: string | null;
	markedAsOverAge?: boolean;
	dataExported?: boolean;
	filesDeleted?: boolean;
};

type BucketRow = {
	id: string;
	name: string;
	totalBytes: number;
	isPaused?: boolean;
	pauseReason?: string | null;
	isCdn?: boolean;
};

type UsersResponse = {
	users: UserRow[];
	total: number;
};

export function AdminUsersPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		pageTitle?: string;
	};

	const [search, setSearch] = useState("");
	const [adminsOnly, setAdminsOnly] = useState(false);
	const [users, setUsers] = useState<UserRow[]>([]);
	const [offset, setOffset] = useState(0);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);

	const [selected, setSelected] = useState<UserRow | null>(null);
	const [selectedBuckets, setSelectedBuckets] = useState<BucketRow[]>([]);

	const limit = 50;

	const loadUsers = useCallback(
		async (reset = true) => {
			setLoading(true);
			const nextOffset = reset ? 0 : offset;
			const q = new URLSearchParams({
				limit: String(limit),
				offset: String(nextOffset),
				search,
				adminsOnly: String(adminsOnly),
			});
			try {
				const data = await fetchJson<UsersResponse>(
					`/api/admin/users?${q.toString()}`,
				);
				setTotal(data.total || 0);
				if (reset) {
					setUsers(data.users || []);
					setOffset((data.users || []).length);
				} else {
					setUsers((prev) => [...prev, ...(data.users || [])]);
					setOffset(nextOffset + (data.users || []).length);
				}
			} finally {
				setLoading(false);
			}
		},
		[adminsOnly, offset, search],
	);

	useEffect(() => {
		loadUsers(true);
	}, [loadUsers]);

	const openUser = async (u: UserRow) => {
		setSelected(u);
		const buckets = await fetchJson<BucketRow[]>(
			`/api/admin/users/${u.id}/buckets`,
		);
		setSelectedBuckets(buckets || []);
	};

	const patchUser = async (path: string, body: unknown) => {
		if (!selected) return;
		await fetchText(`/api/admin/users/${selected.id}/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		await loadUsers(true);
	};

	const statusBadge = (u: UserRow) => {
		if (u.filesDeleted && u.dataExported) return "MIGRATED";
		if (u.filesDeleted && !u.dataExported) return "TOO LATE";
		if (u.markedAsOverAge && u.dataExported) return "EXPORTED";
		if (u.markedAsOverAge && !u.dataExported) return "NO EXPORT";
		if (u.isLocked) return "LOCKED";
		if (u.isImmortal) return "IMMORTAL";
		if (u.isAdmin) return "ADMIN";
		if (u.isReviewer) return "REVIEWER";
		return "ACTIVE";
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			pageTitle={p.pageTitle || "ADMIN"}
			config={bootstrap.config}
		>
			<AdminSubnav active="users" />

			<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow mb-8">
				<div className="p-6 border-b border-white/10 flex justify-between items-center gap-4 flex-wrap">
					<div>
						<h2 className="text-xl font-bold text-white">Users</h2>
						<p className="text-text-muted text-sm mt-1">
							Manage users, quotas, and access.
						</p>
					</div>
					<div className="flex items-center gap-3 flex-wrap">
						<div className="text-xs text-text-muted font-mono">
							Showing {offset} of {total} users
						</div>
						<input
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && loadUsers(true)}
							placeholder="Search users..."
							className="bg-black/30 border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-hc-red text-sm w-64"
						/>
						<label className="inline-flex items-center cursor-pointer">
							<input
								type="checkbox"
								checked={adminsOnly}
								onChange={(e) => setAdminsOnly(e.target.checked)}
								className="mr-2"
							/>
							<span className="text-xs text-text-muted">Admins Only</span>
						</label>
						<button
							type="button"
							onClick={() => loadUsers(true)}
							className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-3 py-2 rounded-lg text-sm font-bold"
						>
							Search
						</button>
					</div>
				</div>

				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
							<tr>
								<th className="px-6 py-4">User</th>
								<th className="px-6 py-4">Slack ID</th>
								<th className="px-6 py-4">Storage</th>
								<th className="px-6 py-4">Egress</th>
								<th className="px-6 py-4">Status</th>
								<th className="px-6 py-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/5">
							{users.map((u) => (
								<tr
									key={u.id}
									className="hover:bg-white/5 transition-colors cursor-pointer"
									onClick={() => openUser(u)}
								>
									<td className="px-6 py-4 font-medium text-white">
										<div>{u.email}</div>
										<div className="text-xs text-text-muted font-mono">
											{u.id}
										</div>
									</td>
									<td className="px-6 py-4 font-mono text-xs text-text-muted">
										{u.slackId || "-"}
									</td>
									<td className="px-6 py-4">
										<div className="text-xs font-mono">
											<span className="text-white">
												{formatBytes(u.storageUsageBytes)}
											</span>
											<span className="text-text-muted">
												{" "}
												/ {formatBytes(u.storageLimitBytes)}
											</span>
										</div>
									</td>
									<td className="px-6 py-4">
										<div className="text-xs font-mono">
											<span className="text-white">
												{formatBytes(u.egressBytes)}
											</span>
											<span className="text-text-muted">
												{" "}
												/{" "}
												{u.egressLimitBytes === -1
													? "Unlimited"
													: u.egressLimitBytes === null
														? "Default"
														: formatBytes(u.egressLimitBytes)}
											</span>
										</div>
									</td>
									<td className="px-6 py-4">
										<span className="bg-white/10 text-white px-2 py-0.5 rounded text-xs font-bold border border-white/20">
											{statusBadge(u)}
										</span>
									</td>
									<td className="px-6 py-4 text-right">
										<button
											type="button"
											className="text-hc-blue text-xs font-bold uppercase"
										>
											Manage
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>

				<div className="p-4 border-t border-white/10 flex justify-center">
					{!loading && offset < total ? (
						<button
							type="button"
							onClick={() => loadUsers(false)}
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

			<Modal
				open={!!selected}
				onClose={() => setSelected(null)}
				title={selected?.id || "User Details"}
				className="max-w-4xl p-8"
			>
				{selected ? (
					<div className="space-y-6">
						<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
							<div className="bg-black/30 p-6 rounded-xl border border-white/10">
								<h4 className="text-white font-bold mb-4">Storage Quota</h4>
								<button
									type="button"
									onClick={async () => {
										const gb = window.prompt(
											"New storage limit in GB",
											String(
												Math.round(selected.storageLimitBytes / 1024 ** 3),
											),
										);
										if (!gb) return;
										await patchUser("quota", {
											storageLimitBytes: Math.floor(Number(gb) * 1024 ** 3),
										});
									}}
									className="bg-hc-blue hover:bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-bold"
								>
									Update Storage
								</button>
							</div>

							<div className="bg-black/30 p-6 rounded-xl border border-white/10">
								<h4 className="text-white font-bold mb-4">Egress Limit</h4>
								<button
									type="button"
									onClick={async () => {
										const mode = window.prompt(
											"Set egress: default | unlimited | gb",
											"default",
										);
										if (!mode) return;
										if (mode === "default")
											await patchUser("quota", { egressLimitBytes: null });
										else if (mode === "unlimited")
											await patchUser("quota", { egressLimitBytes: -1 });
										else
											await patchUser("quota", {
												egressLimitBytes: Math.floor(Number(mode) * 1024 ** 3),
											});
									}}
									className="bg-hc-blue hover:bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-bold"
								>
									Update Egress
								</button>
							</div>

							<div className="bg-black/30 p-6 rounded-xl border border-white/10">
								<h4 className="text-white font-bold mb-4">Account Status</h4>
								<div className="flex flex-col gap-2">
									<button
										type="button"
										onClick={() =>
											patchUser("lock", {
												isLocked: !selected.isLocked,
												lockReason: !selected.isLocked
													? window.prompt("Lock reason")
													: null,
											})
										}
										className="bg-white/5 hover:bg-white/10 text-white px-4 py-2 rounded-lg text-sm font-bold"
									>
										{selected.isLocked ? "Unlock" : "Lock"}
									</button>
									<button
										type="button"
										onClick={() =>
											patchUser("reviewer", {
												isReviewer: !selected.isReviewer,
											})
										}
										className="bg-white/5 hover:bg-white/10 text-white px-4 py-2 rounded-lg text-sm font-bold"
									>
										{selected.isReviewer ? "Remove Reviewer" : "Make Reviewer"}
									</button>
									<button
										type="button"
										onClick={() =>
											patchUser("immortal", {
												isImmortal: !selected.isImmortal,
											})
										}
										className="bg-white/5 hover:bg-white/10 text-white px-4 py-2 rounded-lg text-sm font-bold"
									>
										{selected.isImmortal ? "Remove Immortal" : "Make Immortal"}
									</button>
								</div>
							</div>

							<div className="bg-red-500/10 p-6 rounded-xl border border-red-500/20">
								<h4 className="text-red-400 font-bold mb-4">Danger Zone</h4>
								<button
									type="button"
									onClick={async () => {
										if (!window.confirm("Mark as over-age?")) return;
										await fetchText(`/api/admin/users/${selected.id}/age-out`, {
											method: "POST",
										});
										await loadUsers(true);
										setSelected(null);
									}}
									className="bg-red-500/20 hover:bg-red-500/30 text-red-300 px-4 py-2 rounded-lg text-sm font-bold w-full"
								>
									Mark as Over-Age
								</button>
							</div>
						</div>

						<h4 className="text-white font-bold mb-2 text-lg">Buckets</h4>
						<div className="bg-black/30 rounded-xl border border-white/10 overflow-hidden">
							<table className="w-full text-left text-sm">
								<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
									<tr>
										<th className="px-4 py-3">Name</th>
										<th className="px-4 py-3">Usage</th>
										<th className="px-4 py-3">Status</th>
										<th className="px-4 py-3 text-right">Open</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-white/5">
									{selectedBuckets.map((b) => (
										<tr key={b.id} className="hover:bg-white/5">
											<td className="px-4 py-3 font-mono text-white">
												{b.name}
											</td>
											<td className="px-4 py-3 font-mono text-xs text-text-muted">
												{formatBytes(b.totalBytes)}
											</td>
											<td className="px-4 py-3 text-xs text-text-muted">
												{b.isPaused
													? `Paused${b.pauseReason ? `: ${b.pauseReason}` : ""}`
													: "Active"}
											</td>
											<td className="px-4 py-3 text-right">
												<a
													href={`/dashboard/buckets/${b.name}`}
													className="text-hc-blue hover:text-blue-400 text-xs font-bold uppercase tracking-wider"
												>
													Files
												</a>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				) : null}
			</Modal>
		</AppShell>
	);
}
