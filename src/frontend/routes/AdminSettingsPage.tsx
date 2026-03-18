import { useCallback, useEffect, useState } from "react";
import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
import { fetchJson, fetchText } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";

type BonusTier = {
	hours: number;
	percent: number;
	enabled: boolean;
};

type BonusTierRow = BonusTier & { id: string };

type SettingsPayload = {
	defaultStorageLimitBytes: number;
	egressMultiplier: number;
	minEgressBytes: number;
	defaultMaxBucketsPerUser: number;
	defaultMaxKeysPerBucket: number;
	yswsQuotaPerHourBytes: number;
	yswsBonusTiers?: BonusTier[];
	cdnForceSlackUpload?: boolean;
};

const UNITS = [
	{ label: "Bytes", value: 1 },
	{ label: "KB", value: 1024 },
	{ label: "MB", value: 1024 ** 2 },
	{ label: "GB", value: 1024 ** 3 },
	{ label: "TB", value: 1024 ** 4 },
	{ label: "PB", value: 1024 ** 5 },
];

function toAmountUnit(bytes: number): { amount: number; unit: number } {
	if (!Number.isFinite(bytes) || bytes <= 0) return { amount: 0, unit: 1 };
	const idx = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		UNITS.length - 1,
	);
	const unit = UNITS[idx]?.value || 1;
	return { amount: Number((bytes / unit).toFixed(2)), unit };
}

function toBytes(amount: number, unit: number): number {
	if (!Number.isFinite(amount) || !Number.isFinite(unit)) return 0;
	return Math.floor(Math.max(0, amount) * unit);
}

export function AdminSettingsPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		pageTitle?: string;
	};

	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState("");

	const [defaultStorageAmount, setDefaultStorageAmount] = useState(0);
	const [defaultStorageUnit, setDefaultStorageUnit] = useState(1024 ** 3);

	const [egressMultiplier, setEgressMultiplier] = useState(3);
	const [minEgressAmount, setMinEgressAmount] = useState(10);
	const [minEgressUnit, setMinEgressUnit] = useState(1024 ** 3);

	const [maxBuckets, setMaxBuckets] = useState(1);
	const [maxKeys, setMaxKeys] = useState(2);

	const [yswsAmount, setYswsAmount] = useState(100);
	const [yswsUnit, setYswsUnit] = useState(1024 ** 2);
	const [cdnForceSlackUpload, setCdnForceSlackUpload] = useState(true);

	const [tiers, setTiers] = useState<BonusTierRow[]>([]);

	const loadSettings = useCallback(async () => {
		setLoading(true);
		setStatus("Loading...");
		try {
			const data = await fetchJson<SettingsPayload>("/api/admin/settings");

			const storage = toAmountUnit(data.defaultStorageLimitBytes);
			setDefaultStorageAmount(storage.amount);
			setDefaultStorageUnit(storage.unit);

			setEgressMultiplier(data.egressMultiplier);

			const minEgress = toAmountUnit(data.minEgressBytes);
			setMinEgressAmount(minEgress.amount);
			setMinEgressUnit(minEgress.unit);

			setMaxBuckets(data.defaultMaxBucketsPerUser);
			setMaxKeys(data.defaultMaxKeysPerBucket);

			const ysws = toAmountUnit(data.yswsQuotaPerHourBytes || 0);
			setYswsAmount(ysws.amount);
			setYswsUnit(ysws.unit);

			setCdnForceSlackUpload(data.cdnForceSlackUpload ?? true);
			setTiers(
				(data.yswsBonusTiers || []).map((tier) => ({
					id: crypto.randomUUID(),
					...tier,
				})),
			);
			setStatus("Loaded");
		} catch (e) {
			setStatus(e instanceof Error ? e.message : "Failed to load settings");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadSettings();
	}, [loadSettings]);

	const save = async () => {
		setSaving(true);
		setStatus("Saving...");
		try {
			const payload: SettingsPayload = {
				defaultStorageLimitBytes: toBytes(
					defaultStorageAmount,
					defaultStorageUnit,
				),
				egressMultiplier,
				minEgressBytes: toBytes(minEgressAmount, minEgressUnit),
				defaultMaxBucketsPerUser: maxBuckets,
				defaultMaxKeysPerBucket: maxKeys,
				yswsQuotaPerHourBytes: toBytes(yswsAmount, yswsUnit),
				yswsBonusTiers: tiers.map(({ id: _id, ...tier }) => tier),
				cdnForceSlackUpload,
			};

			await fetchText("/api/admin/settings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			setStatus("Saved");
		} catch (e) {
			setStatus(e instanceof Error ? e.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			pageTitle={p.pageTitle || "ADMIN"}
			config={bootstrap.config}
		>
			<AdminSubnav active="settings" />

			<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow mb-8">
				<div className="p-6 border-b border-white/10 flex justify-between items-center">
					<div>
						<h2 className="text-xl font-bold text-white">Settings</h2>
						<p className="text-text-muted text-sm mt-1">
							Global defaults used across Dashboard + Slack + backend.
						</p>
					</div>
					<div className="flex items-center gap-3">
						<button
							type="button"
							onClick={loadSettings}
							disabled={loading || saving}
							className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-3 py-2 rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
						>
							Reload
						</button>
						<button
							type="button"
							onClick={save}
							disabled={loading || saving}
							className="bg-hc-blue hover:bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
						>
							{saving ? "Saving..." : "Save"}
						</button>
					</div>
				</div>

				<div className="p-6">
					<div className="text-xs text-text-muted font-mono mb-4">{status}</div>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
						<div className="bg-black/30 p-6 rounded-xl border border-white/10">
							<h4 className="text-white font-bold mb-1">
								Default Storage Quota
							</h4>
							<p className="text-xs text-text-muted mb-4">
								Used when a user does not have an explicit per-user quota.
							</p>
							<div className="flex gap-2 items-center mt-3">
								<input
									type="number"
									min={0}
									step="0.01"
									value={defaultStorageAmount}
									onChange={(e) =>
										setDefaultStorageAmount(Number(e.target.value))
									}
									className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white w-full font-mono"
								/>
								<select
									value={defaultStorageUnit}
									onChange={(e) =>
										setDefaultStorageUnit(Number(e.target.value))
									}
									className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white cursor-pointer font-mono"
								>
									{UNITS.map((u) => (
										<option key={u.value} value={u.value}>
											{u.label}
										</option>
									))}
								</select>
							</div>
							<p className="text-[11px] text-text-muted mt-2">
								Stored as bytes.
							</p>
						</div>

						<div className="bg-black/30 p-6 rounded-xl border border-white/10">
							<h4 className="text-white font-bold mb-1">
								Default Egress Limit (formula)
							</h4>
							<p className="text-xs text-text-muted mb-4">
								When a user has no explicit egress limit, we compute:{" "}
								<span className="font-mono">
									max(minEgress, storage × multiplier)
								</span>
								.
							</p>
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
								<div>
									<div className="text-xs text-text-muted mb-1 font-bold uppercase tracking-wider">
										Multiplier
									</div>
									<input
										type="number"
										value={egressMultiplier}
										onChange={(e) =>
											setEgressMultiplier(Number(e.target.value))
										}
										className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white w-full font-mono"
									/>
								</div>
								<div className="flex gap-2 items-center">
									<div className="w-full">
										<div className="text-xs text-text-muted mb-1 font-bold uppercase tracking-wider">
											Minimum Egress
										</div>
										<div className="flex gap-2 items-center">
											<input
												type="number"
												min={0}
												step="0.01"
												value={minEgressAmount}
												onChange={(e) =>
													setMinEgressAmount(Number(e.target.value))
												}
												className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white w-full font-mono"
											/>
											<select
												value={minEgressUnit}
												onChange={(e) =>
													setMinEgressUnit(Number(e.target.value))
												}
												className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white cursor-pointer font-mono"
											>
												{UNITS.map((u) => (
													<option key={u.value} value={u.value}>
														{u.label}
													</option>
												))}
											</select>
										</div>
									</div>
								</div>
							</div>
							<p className="text-[11px] text-text-muted mt-3">
								Example: if storage is <span className="font-mono">1GB</span>,
								multiplier is <span className="font-mono">3</span>, and minimum
								is <span className="font-mono">10GB</span>, default egress
								becomes <span className="font-mono">10GB</span>.
							</p>
						</div>

						<div className="bg-black/30 p-6 rounded-xl border border-white/10">
							<h4 className="text-white font-bold mb-1">
								Max Buckets per User
							</h4>
							<p className="text-xs text-text-muted mb-4">
								Enforced when creating buckets (Dashboard + Slack + API).
							</p>
							<div className="grid grid-cols-2 gap-3 mt-3">
								<input
									type="number"
									value={maxBuckets}
									onChange={(e) => setMaxBuckets(Number(e.target.value))}
									className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white w-full font-mono"
								/>
								<div className="col-span-2 -mt-1 text-xs text-text-muted font-bold uppercase tracking-wider">
									Max Keys per Bucket
								</div>
								<input
									type="number"
									value={maxKeys}
									onChange={(e) => setMaxKeys(Number(e.target.value))}
									className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white w-full font-mono"
								/>
							</div>
							<p className="text-xs text-text-muted mt-4">
								Max keys is enforced when generating access keys.
							</p>
						</div>

						<div className="bg-black/30 p-6 rounded-xl border border-white/10">
							<h4 className="text-white font-bold mb-1">YSWS + CDN</h4>
							<p className="text-xs text-text-muted mb-4">
								Storage reward per shipped hour and CDN notification behavior.
							</p>
							<div className="flex gap-2 items-center mt-3 mb-3">
								<input
									type="number"
									min={0}
									step="0.01"
									value={yswsAmount}
									onChange={(e) => setYswsAmount(Number(e.target.value))}
									className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white w-full font-mono"
								/>
								<select
									value={yswsUnit}
									onChange={(e) => setYswsUnit(Number(e.target.value))}
									className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white cursor-pointer font-mono"
								>
									{UNITS.slice(0, 5).map((u) => (
										<option key={u.value} value={u.value}>
											{u.label}
										</option>
									))}
								</select>
							</div>
							<label className="inline-flex items-center gap-2 cursor-pointer">
								<input
									type="checkbox"
									checked={cdnForceSlackUpload}
									onChange={(e) => setCdnForceSlackUpload(e.target.checked)}
								/>
								<span className="text-white text-sm">
									Force Slack Upload Notification
								</span>
							</label>
							<p className="text-[11px] text-text-muted mt-2">
								If enabled, all CDN uploads are posted to the configured Slack
								channel.
							</p>
						</div>

						<div className="bg-black/30 p-6 rounded-xl border border-white/10 md:col-span-2">
							<div className="flex justify-between items-center mb-3">
								<h4 className="text-white font-bold">YSWS Bonus Tiers</h4>
								<button
									type="button"
									onClick={() =>
										setTiers((prev) => [
											...prev,
											{
												id: crypto.randomUUID(),
												hours: 50,
												percent: 5,
												enabled: true,
											},
										])
									}
									className="text-xs bg-white/5 hover:bg-white/10 border border-white/10 text-white px-3 py-2 rounded-lg transition-colors"
								>
									+ Add Tier
								</button>
							</div>
							<p className="text-xs text-text-muted mb-4">
								Configure automatic bonuses for high-hour projects.
							</p>
							<div className="grid grid-cols-12 gap-3 mb-2 text-xs text-text-muted uppercase font-bold tracking-wider">
								<div className="col-span-4">Hours &gt;</div>
								<div className="col-span-3">Bonus %</div>
								<div className="col-span-2 text-center">Enabled</div>
								<div className="col-span-3" />
							</div>
							<div className="space-y-2">
								{tiers.map((tier) => (
									<div
										key={tier.id}
										className="grid grid-cols-12 gap-3 items-center bg-white/5 p-3 rounded-lg border border-white/5"
									>
										<input
											type="number"
											value={tier.hours}
											onChange={(e) =>
												setTiers((prev) =>
													prev.map((t) =>
														t.id === tier.id
															? { ...t, hours: Number(e.target.value) }
															: t,
													),
												)
											}
											className="col-span-4 bg-black/50 border border-white/10 rounded px-2 py-1 text-white font-mono text-sm"
										/>
										<input
											type="number"
											value={tier.percent}
											onChange={(e) =>
												setTiers((prev) =>
													prev.map((t) =>
														t.id === tier.id
															? { ...t, percent: Number(e.target.value) }
															: t,
													),
												)
											}
											className="col-span-3 bg-black/50 border border-white/10 rounded px-2 py-1 text-white font-mono text-sm"
										/>
										<input
											type="checkbox"
											checked={tier.enabled}
											onChange={(e) =>
												setTiers((prev) =>
													prev.map((t) =>
														t.id === tier.id
															? { ...t, enabled: e.target.checked }
															: t,
													),
												)
											}
											className="col-span-2"
										/>
										<button
											type="button"
											onClick={() =>
												setTiers((prev) => prev.filter((t) => t.id !== tier.id))
											}
											className="col-span-3 text-red-400 hover:text-red-300 text-xs font-bold px-2 py-1 text-right"
										>
											Delete
										</button>
									</div>
								))}
							</div>
						</div>
					</div>
				</div>
			</div>
		</AppShell>
	);
}
