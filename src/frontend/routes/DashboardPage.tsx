import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/ui/Modal";
import { fetchJson, fetchText } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type BucketKey = { id: string; accessKey: string };
type DashboardBucket = {
	name: string;
	keys: BucketKey[];
	createdAt: string;
	totalBytes: number;
	totalRequests: number;
	isPublic: boolean;
	isPaused?: boolean;
	pauseReason?: string | null;
	corsConfig?: string | null;
	isCdn?: boolean;
};

type DashboardStats = {
	user: {
		id: string;
		storageUsage: number;
		storageLimit: number;
		egressLimit: number | null;
		ingressBytes: number;
		egressBytes: number;
		totalRequests: number;
		isImmortal?: boolean;
		slackId?: string;
	};
	limits: {
		maxBucketsPerUser: number;
		maxKeysPerBucket: number;
	};
	buckets: DashboardBucket[];
};

type ConfirmDialogState = {
	title: string;
	message: string;
	confirmLabel: string;
	confirmClassName?: string;
	onConfirm: () => Promise<void>;
};

export function DashboardPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		latestSubmission?: { status?: string; projectName?: string } | null;
		yswsQuotaPerHourHuman?: string;
	};

	const [stats, setStats] = useState<DashboardStats | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [activeBucket, setActiveBucket] = useState<DashboardBucket | null>(
		null,
	);
	const [corsBucket, setCorsBucket] = useState<DashboardBucket | null>(null);
	const [corsEditor, setCorsEditor] = useState("[]");
	const [corsError, setCorsError] = useState<string | null>(null);
	const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(
		null,
	);
	const [confirmLoading, setConfirmLoading] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setStats(await fetchJson<DashboardStats>("/api/dashboard/stats"));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load dashboard");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const storagePercent = useMemo(() => {
		if (!stats) return 0;
		if (stats.user.isImmortal) return 100;
		const den = stats.user.storageLimit || 1;
		return Math.min(100, (stats.user.storageUsage / den) * 100);
	}, [stats]);

	const egressLimitBytes = useMemo(() => {
		if (!stats) return 0;
		if (stats.user.isImmortal) return Number.POSITIVE_INFINITY;
		if (
			stats.user.egressLimit === null ||
			stats.user.egressLimit === undefined
		) {
			return Math.max(stats.user.storageLimit * 3, 10 * 1024 * 1024 * 1024);
		}
		if (stats.user.egressLimit === -1) return Number.POSITIVE_INFINITY;
		return stats.user.egressLimit;
	}, [stats]);

	const handleCreateBucket = async () => {
		const name = window.prompt(
			"Bucket name (lowercase letters, digits, hyphens)",
		);
		if (!name) return;
		try {
			const res = await fetchJson<{
				accessKey: string;
				secretKey: string;
				publicUrl: string;
			}>("/api/dashboard/buckets", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name }),
			});
			window.alert(
				`Bucket created.\nAccess key: ${res.accessKey}\nSecret key: ${res.secretKey}\nPublic URL: ${res.publicUrl}`,
			);
			await load();
		} catch (e) {
			window.alert(e instanceof Error ? e.message : "Failed to create bucket");
		}
	};

	const togglePublic = async (bucketName: string, isPublic: boolean) => {
		setConfirmDialog({
			title: `Make bucket ${isPublic ? "public" : "private"}`,
			message: isPublic
				? `Anyone with the file URL will be able to access files in ${bucketName}.`
				: `Only authenticated access will be allowed for ${bucketName}.`,
			confirmLabel: isPublic ? "Make Public" : "Make Private",
			confirmClassName: "bg-hc-blue hover:bg-blue-600",
			onConfirm: async () => {
				await fetchText(`/api/dashboard/buckets/${bucketName}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ isPublic }),
				});
				await load();
			},
		});
	};

	const deleteBucket = async (bucketName: string, emptyOnly: boolean) => {
		setConfirmDialog({
			title: emptyOnly ? "Empty bucket" : "Delete bucket",
			message: emptyOnly
				? `This will permanently remove all files in ${bucketName}.`
				: `This will permanently delete ${bucketName} and all of its files.`,
			confirmLabel: emptyOnly ? "Empty Bucket" : "Delete Bucket",
			confirmClassName: "bg-hc-red hover:bg-red-600",
			onConfirm: async () => {
				await fetchText(
					`/api/dashboard/buckets/${bucketName}${emptyOnly ? "?empty=true" : ""}`,
					{ method: "DELETE" },
				);
				await load();
			},
		});
	};

	const generateKey = async (bucketName: string) => {
		try {
			const r = await fetchJson<{
				accessKey: string;
				secretKey: string;
				publicUrl: string;
			}>(`/api/dashboard/buckets/${bucketName}/keys`, { method: "POST" });
			window.alert(
				`New key for ${bucketName}:\n${r.accessKey}\n${r.secretKey}\n${r.publicUrl}`,
			);
			await load();
		} catch (e) {
			window.alert(e instanceof Error ? e.message : "Failed to generate key");
		}
	};

	const deleteKey = async (bucketName: string, keyId: string) => {
		setConfirmDialog({
			title: "Delete access key",
			message:
				"Any applications using this key will immediately lose access to this bucket.",
			confirmLabel: "Delete Key",
			confirmClassName: "bg-hc-red hover:bg-red-600",
			onConfirm: async () => {
				await fetchText(`/api/dashboard/buckets/${bucketName}/keys/${keyId}`, {
					method: "DELETE",
				});
				await load();
			},
		});
	};

	const openCorsModal = (bucket: DashboardBucket) => {
		setCorsBucket(bucket);
		setCorsError(null);
		if (!bucket.corsConfig) {
			setCorsEditor("[]");
			return;
		}

		try {
			const parsed = JSON.parse(bucket.corsConfig);
			setCorsEditor(JSON.stringify(parsed.CORSRules || parsed, null, 2));
		} catch {
			setCorsEditor(bucket.corsConfig);
		}
	};

	const saveCors = async () => {
		if (!corsBucket) return;
		try {
			const rules = JSON.parse(corsEditor);
			if (!Array.isArray(rules)) {
				setCorsError("Configuration must be a JSON array of CORS rules.");
				return;
			}
			for (const rule of rules) {
				if (!rule?.AllowedOrigins || !rule?.AllowedMethods) {
					setCorsError(
						"Each rule must include AllowedOrigins and AllowedMethods.",
					);
					return;
				}
			}

			setCorsError(null);
			await fetchText(`/api/dashboard/buckets/${corsBucket.name}/cors`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rules }),
			});
			await load();
			setCorsBucket(null);
		} catch (e) {
			setCorsError(e instanceof Error ? e.message : "Invalid CORS config");
		}
	};

	const resetCors = async () => {
		if (!corsBucket) return;
		try {
			await fetchText(`/api/dashboard/buckets/${corsBucket.name}/cors`, {
				method: "DELETE",
			});
			await load();
			setCorsEditor("[]");
			setCorsError(null);
		} catch (e) {
			setCorsError(e instanceof Error ? e.message : "Failed to reset CORS");
		}
	};

	const runConfirmDialog = async () => {
		if (!confirmDialog) return;
		setConfirmLoading(true);
		try {
			await confirmDialog.onConfirm();
			setConfirmDialog(null);
		} catch (e) {
			window.alert(e instanceof Error ? e.message : "Action failed");
		} finally {
			setConfirmLoading(false);
		}
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			{p.user?.markedAsOverAge ? (
				<div className="bg-hc-dark border border-white/10 rounded-3xl p-6 mb-8 card-shadow flex flex-col md:flex-row items-center justify-between gap-6">
					<div>
						<h3 className="text-white font-bold text-lg">
							Your account is closing soon.
						</h3>
						<p className="text-text-muted text-sm mt-1 max-w-xl">
							Since you're 18, you've aged out of Silo. Existing data will be
							permanently deleted in 2 months.
						</p>
					</div>
					<a
						href="/dashboard/offboarding"
						className="shrink-0 bg-hc-red hover:bg-red-600 text-white px-6 py-3 rounded-xl text-sm font-bold transition-all card-shadow whitespace-nowrap"
					>
						Start Migration <i className="ph ph-arrow-right" />
					</a>
				</div>
			) : null}

			<div className="mb-10">
				{p.latestSubmission?.status === "pending" ? (
					<div className="bg-hc-dark border border-white/10 rounded-3xl p-8 card-shadow">
						<div className="inline-flex items-center gap-2 bg-yellow-500/10 text-yellow-400 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-4 border border-yellow-500/20">
							<i className="ph-fill ph-clock-countdown animate-pulse" /> Under
							Review
						</div>
						<h2 className="text-3xl font-black text-white italic tracking-tight mb-2">
							“{p.latestSubmission.projectName}” is in the pipeline.
						</h2>
						<p className="text-text-muted text-lg max-w-xl">
							We're reviewing your submission. Once approved, your storage quota
							will be upgraded automatically.
						</p>
					</div>
				) : (
					<div className="bg-hc-dark rounded-3xl card-shadow border border-white/10 p-8">
						<h2 className="text-3xl md:text-4xl font-black text-white italic tracking-tight mb-3">
							Ship projects.{" "}
							<span className="text-hc-red">Get paid in storage.</span>
						</h2>
						<p className="text-text-muted text-lg max-w-xl mb-6">
							Built something cool? Submit it to YSWS. Every shipped project
							unlocks{" "}
							<span className="text-white font-bold">
								{p.yswsQuotaPerHourHuman || "more"} of permanent storage
							</span>
							.
						</p>
						<a
							href="/ysws/submit"
							className="bg-hc-red hover:bg-red-500 text-white px-8 py-4 rounded-xl text-lg font-bold transition-all shadow-lg shadow-hc-red/20 inline-flex items-center gap-3"
						>
							<i className="ph-bold ph-rocket-launch" /> Ship a Project
						</a>
					</div>
				)}
			</div>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
				<div className="bg-hc-dark rounded-3xl p-6 border border-white/10 card-shadow">
					<h3 className="text-text-muted text-sm font-bold uppercase tracking-wider mb-2">
						Storage Usage
					</h3>
					<div className="flex items-baseline gap-2">
						<span className="text-3xl font-bold text-white">
							{formatBytes(stats?.user.storageUsage || 0)}
						</span>
						<span className="text-text-muted text-sm font-mono">
							/
							{stats?.user.isImmortal
								? "∞"
								: ` ${formatBytes(stats?.user.storageLimit || 0)}`}
						</span>
					</div>
					<div className="w-full bg-white/5 rounded-full h-2 mt-4 overflow-hidden">
						<div
							className={`${stats?.user.isImmortal ? "bg-amber-400" : "bg-hc-red"} h-2 rounded-full transition-all duration-500`}
							style={{ width: `${storagePercent}%` }}
						/>
					</div>
				</div>

				<div className="bg-hc-dark rounded-3xl p-6 border border-white/10 card-shadow">
					<h3 className="text-text-muted text-sm font-bold uppercase tracking-wider mb-2">
						Total Traffic
					</h3>
					<div className="flex justify-between text-sm">
						<span className="text-emerald-400">Ingress (In)</span>
						<span className="text-white">
							{formatBytes(stats?.user.ingressBytes || 0)}
						</span>
					</div>
					<div className="flex justify-between text-sm mt-2">
						<span className="text-hc-red">Egress (Out)</span>
						<span className="text-white">
							{formatBytes(stats?.user.egressBytes || 0)}
						</span>
					</div>
					<div className="text-xs text-text-muted mt-1">
						/
						{egressLimitBytes === Number.POSITIVE_INFINITY
							? " ∞"
							: ` ${formatBytes(egressLimitBytes)}`}
					</div>
				</div>

				<div className="bg-hc-dark rounded-3xl p-6 border border-white/10 card-shadow">
					<h3 className="text-text-muted text-sm font-bold uppercase tracking-wider mb-2">
						API Requests
					</h3>
					<div className="flex items-baseline gap-2">
						<span className="text-3xl font-bold text-white">
							{(stats?.user.totalRequests || 0).toLocaleString()}
						</span>
						<span className="text-text-muted text-sm">requests</span>
					</div>
					<p className="text-xs text-text-muted mt-2">
						Lifetime total across all buckets
					</p>
				</div>
			</div>

			<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow">
				<div className="p-6 border-b border-white/10 flex justify-between items-center">
					<div>
						<h2 className="text-xl font-bold text-white">
							Your Storage Inventory
						</h2>
						<p className="text-text-muted text-sm mt-1">
							{stats?.buckets.length || 0} /{" "}
							{stats?.limits.maxBucketsPerUser === -1
								? "∞"
								: stats?.limits.maxBucketsPerUser || 0}{" "}
							buckets utilized
						</p>
					</div>
					<button
						type="button"
						onClick={handleCreateBucket}
						className="bg-white/5 hover:bg-white/10 text-white border border-white/10 px-6 py-3 rounded-xl text-sm font-bold transition-all"
					>
						+ New Bucket
					</button>
				</div>

				{loading ? <p className="px-6 py-4 text-text-muted">Loading…</p> : null}
				{error ? <p className="px-6 py-4 text-red-400">{error}</p> : null}

				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
							<tr>
								<th className="px-6 py-4">Name</th>
								<th className="px-6 py-4">Keys</th>
								<th className="px-6 py-4">Usage</th>
								<th className="px-6 py-4">Visibility</th>
								<th className="px-6 py-4">Created</th>
								<th className="px-6 py-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/5">
							{(stats?.buckets || []).map((bucket) => (
								<tr
									key={bucket.name}
									className="hover:bg-white/5 transition-colors group"
								>
									<td className="px-6 py-4 font-medium text-white font-mono">
										{bucket.name}
										{bucket.isPaused ? (
											<span className="ml-2 bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded text-[10px] font-bold border border-red-500/30">
												PAUSED
											</span>
										) : null}
										{bucket.isCdn ? (
											<span className="ml-2 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded text-[10px] font-bold border border-blue-500/30">
												CDN
											</span>
										) : null}
									</td>
									<td className="px-6 py-4">
										{bucket.isCdn ? (
											<span className="text-text-muted italic">Managed</span>
										) : (
											<button
												type="button"
												onClick={() => setActiveBucket(bucket)}
												className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-3 py-1.5 rounded-lg text-xs font-bold"
											>
												<i className="ph ph-key text-sm mr-1" />{" "}
												{bucket.keys.length} Keys
											</button>
										)}
									</td>
									<td className="px-6 py-4 text-text-main">
										<div className="text-xs font-mono">
											<div>{formatBytes(bucket.totalBytes)}</div>
											<div className="text-text-muted">
												{bucket.totalRequests.toLocaleString()} reqs
											</div>
										</div>
									</td>
									<td className="px-6 py-4">
										<label className="inline-flex items-center cursor-pointer">
											<input
												type="checkbox"
												className="sr-only peer"
												checked={!!bucket.isPublic}
												disabled={!!bucket.isPaused || !!bucket.isCdn}
												onChange={(e) =>
													togglePublic(bucket.name, e.target.checked)
												}
											/>
											<div className="relative w-9 h-5 bg-white/10 rounded-full peer-checked:bg-hc-blue" />
											<span className="ms-2 text-xs font-medium text-text-muted">
												{bucket.isPublic ? "Public" : "Private"}
											</span>
										</label>
									</td>
									<td className="px-6 py-4 text-text-muted text-xs font-mono">
										{new Date(bucket.createdAt).toLocaleDateString()}
									</td>
									<td className="px-6 py-4 text-right flex justify-end items-center gap-2">
										{!bucket.isCdn ? (
											<button
												type="button"
												onClick={() => openCorsModal(bucket)}
												className="bg-white/5 hover:bg-white/10 text-text-muted hover:text-white px-3 py-1.5 rounded-lg text-xs font-bold"
											>
												CORS
											</button>
										) : null}
										<a
											href={`/dashboard/buckets/${bucket.name}`}
											className="bg-hc-blue/10 hover:bg-hc-blue/20 text-hc-blue px-3 py-1.5 rounded-lg text-xs font-bold"
										>
											Files
										</a>
										{!bucket.isCdn ? (
											<button
												type="button"
												onClick={() => deleteBucket(bucket.name, true)}
												className="text-yellow-400 hover:text-yellow-300 text-xs font-bold uppercase tracking-wider"
											>
												Empty
											</button>
										) : (
											<button
												type="button"
												onClick={() => deleteBucket(bucket.name, true)}
												className="text-hc-red hover:text-red-400 text-xs font-bold uppercase tracking-wider"
											>
												Empty
											</button>
										)}
										{!bucket.isCdn ? (
											<button
												type="button"
												onClick={() => deleteBucket(bucket.name, false)}
												className="text-hc-red hover:text-red-400 text-xs font-bold uppercase tracking-wider"
											>
												Delete
											</button>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			<Modal
				open={!!activeBucket}
				onClose={() => setActiveBucket(null)}
				title="Manage Keys"
				className="max-w-3xl p-8"
			>
				{activeBucket ? (
					<>
						<p className="text-text-muted text-sm -mt-3 mb-6 font-mono">
							{activeBucket.name}
						</p>
						<div className="bg-black/30 rounded-xl border border-white/10 overflow-hidden mb-6 max-h-[55vh] overflow-y-auto">
							<table className="w-full text-left text-sm">
								<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider sticky top-0">
									<tr>
										<th className="px-4 py-3">Access Key ID</th>
										<th className="px-4 py-3 text-right">Actions</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-white/5">
									{activeBucket.keys.length ? (
										activeBucket.keys.map((k) => (
											<tr
												key={k.id}
												className="hover:bg-white/5 transition-colors"
											>
												<td className="px-4 py-3 font-mono text-white">
													{k.accessKey}
												</td>
												<td className="px-4 py-3 text-right">
													<button
														type="button"
														onClick={() => deleteKey(activeBucket.name, k.id)}
														className="text-hc-red hover:text-red-400 text-xs font-bold uppercase tracking-wider"
													>
														Delete
													</button>
												</td>
											</tr>
										))
									) : (
										<tr>
											<td
												colSpan={2}
												className="px-4 py-8 text-center text-text-muted italic"
											>
												No keys found for this bucket.
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>

						<div className="flex items-center justify-between">
							<div className="text-xs text-text-muted font-mono">
								{activeBucket.keys.length} /{" "}
								{stats?.user.isImmortal
									? "∞"
									: stats?.limits.maxKeysPerBucket || 0}{" "}
								keys
							</div>
							<button
								type="button"
								onClick={() => generateKey(activeBucket.name)}
								className="bg-hc-blue hover:bg-blue-600 text-white px-6 py-3 rounded-xl text-sm font-bold transition-all"
							>
								+ Generate New Key
							</button>
						</div>
					</>
				) : null}
			</Modal>

			<Modal
				open={!!corsBucket}
				onClose={() => setCorsBucket(null)}
				title="CORS Configuration"
				className="max-w-2xl p-8"
			>
				{corsBucket ? (
					<>
						<p className="text-text-muted text-sm -mt-3 mb-4 font-mono">
							{corsBucket.name}
						</p>
						<p className="text-text-muted text-sm mb-4">
							Configure CORS as a JSON array of rules.
						</p>
						<textarea
							value={corsEditor}
							onChange={(e) => {
								setCorsEditor(e.target.value);
								setCorsError(null);
							}}
							className="w-full h-64 bg-black/30 border border-white/10 rounded-xl p-4 text-white font-mono text-sm focus:outline-none focus:border-hc-blue focus:ring-1 focus:ring-hc-blue resize-none"
						/>
						{corsError ? (
							<p className="text-xs text-red-400 mt-2">{corsError}</p>
						) : null}
						<div className="flex justify-between items-center mt-6">
							<button
								type="button"
								onClick={resetCors}
								className="text-text-muted hover:text-white px-4 py-2 text-sm font-bold transition-colors"
							>
								Reset CORS
							</button>
							<div className="flex items-center gap-3">
								<button
									type="button"
									onClick={() => setCorsBucket(null)}
									className="text-text-muted hover:text-white px-4 py-2 text-sm font-bold transition-colors"
								>
									Cancel
								</button>
								<button
									type="button"
									onClick={saveCors}
									className="bg-hc-blue hover:bg-blue-600 text-white px-6 py-3 rounded-xl text-sm font-bold transition-all"
								>
									Save Configuration
								</button>
							</div>
						</div>
					</>
				) : null}
			</Modal>

			<Modal
				open={!!confirmDialog}
				onClose={confirmLoading ? undefined : () => setConfirmDialog(null)}
				title={confirmDialog?.title}
				className="max-w-md p-8"
			>
				{confirmDialog ? (
					<>
						<p className="text-text-muted text-sm">{confirmDialog.message}</p>
						<div className="mt-6 flex justify-end gap-3">
							<button
								type="button"
								disabled={confirmLoading}
								onClick={() => setConfirmDialog(null)}
								className="text-text-muted hover:text-white px-4 py-2 text-sm font-bold transition-colors disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								type="button"
								disabled={confirmLoading}
								onClick={runConfirmDialog}
								className={`${confirmDialog.confirmClassName || "bg-hc-red hover:bg-red-600"} text-white px-6 py-3 rounded-xl text-sm font-bold transition-all disabled:opacity-50`}
							>
								{confirmLoading ? "Working..." : confirmDialog.confirmLabel}
							</button>
						</div>
					</>
				) : null}
			</Modal>
		</AppShell>
	);
}
