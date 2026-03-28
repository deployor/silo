import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/ui/Modal";
import { PhIcon } from "../components/ui/PhIcon";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";

type PlanRow = {
	localName: string;
	targetName: string;
	status: "AVAILABLE" | "EXISTS" | "TAKEN";
	selected: boolean;
};
type LogRow = {
	id: string;
	time: string;
	msg: string;
	type: "info" | "success" | "error";
};

type ExportCommandState = {
	command: string;
	endpoint: string;
	expiresAt: string;
	secretKey: string;
	accessKey: string;
	bucketNames: string[];
	buckets: Array<{
		name: string;
		totalBytes: number;
		objectCount: number;
	}>;
};

type ExportSpeedMode = "safe" | "balanced" | "fast";

function formatBytes(value: number) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = value;
	let unitIndex = 0;
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex += 1;
	}
	return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function OffboardingPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		daysRemaining?: number;
		totalStorageBytes?: number;
		totalStorageFormatted?: string;
		gracePeriodEndsAt?: string;
		showSuccess?: boolean;
	};

	const [step, setStep] = useState(1);
	const [provider, setProvider] = useState<
		"r2" | "aws" | "backblaze" | "digitalocean" | "custom" | null
	>(null);
	const [r2GuideSeen, setR2GuideSeen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [endpoint, setEndpoint] = useState("");
	const [accessKeyId, setAccessKeyId] = useState("");
	const [secretAccessKey, setSecretAccessKey] = useState("");
	const [plan, setPlan] = useState<PlanRow[]>([]);
	const [logs, setLogs] = useState<LogRow[]>([]);
	const [downloadModalOpen, setDownloadModalOpen] = useState(false);
	const [downloadBusy, setDownloadBusy] = useState(false);
	const [downloadError, setDownloadError] = useState<string | null>(null);
	const [exportCommand, setExportCommand] =
		useState<ExportCommandState | null>(null);
	const [exportSpeedMode, setExportSpeedMode] =
		useState<ExportSpeedMode>("balanced");
	const [selectedExportBuckets, setSelectedExportBuckets] = useState<string[]>([]);

	const isLargeDownload = (p.totalStorageBytes || 0) > 5 * 1024 * 1024 * 1024;

	const renderedExportCommand = useMemo(() => {
		if (!exportCommand) return "";

		const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
		const destinationPath = "./silo-export";
		const s3Flags = [
			"--s3-provider Other",
			`--s3-access-key-id ${shellQuote(exportCommand.accessKey)}`,
			`--s3-secret-access-key ${shellQuote(exportCommand.secretKey)}`,
			`--s3-endpoint ${shellQuote(exportCommand.endpoint)}`,
			"--s3-region auto",
			"--s3-force-path-style",
			"--s3-no-check-bucket",
		].join(" ");

		const modeFlags =
			exportSpeedMode === "safe"
				? "--fast-list --transfers 8 --checkers 16 --multi-thread-streams 2 --multi-thread-cutoff 128M --progress"
				: exportSpeedMode === "fast"
					? "--fast-list --transfers 64 --checkers 128 --multi-thread-streams 16 --multi-thread-cutoff 32M --progress"
					: "--fast-list --transfers 32 --checkers 64 --multi-thread-streams 8 --multi-thread-cutoff 64M --progress";

		const bucketCommands = selectedExportBuckets
			.map(
				(bucketName) =>
					`echo "Downloading ${bucketName}" && rclone copy ${shellQuote(`:s3:${bucketName}/`)} "$DEST/${bucketName}" ${s3Flags} ${modeFlags}`,
			)
			.join(" \\\n  && ");

		return [
			`DEST=${shellQuote(destinationPath)}`,
			'mkdir -p "$DEST"',
			bucketCommands || 'echo "No buckets selected"',
		].join(" \\\n&& ");
	}, [exportCommand, exportSpeedMode, selectedExportBuckets]);

	const providerName = useMemo(() => {
		const map = {
			r2: "Cloudflare R2",
			aws: "Amazon S3",
			backblaze: "Backblaze B2",
			digitalocean: "DigitalOcean Spaces",
			custom: "Compatible Storage",
		} as const;
		return provider ? map[provider] : "Storage";
	}, [provider]);

	const addLog = (msg: string, type: LogRow["type"] = "info") => {
		setLogs((prev) => [
			...prev,
			{
				id: `${Date.now()}-${Math.random()}`,
				time: new Date().toLocaleTimeString(),
				msg,
				type,
			},
		]);
	};

	const selectProvider = (pvd: NonNullable<typeof provider>) => {
		setProvider(pvd);
		setStep(3);
		setR2GuideSeen(pvd !== "r2");
		setEndpoint("");
		setAccessKeyId("");
		setSecretAccessKey("");
		if (pvd === "aws") setEndpoint("https://s3.us-east-1.amazonaws.com");
		if (pvd === "backblaze")
			setEndpoint("https://s3.us-west-000.backblazeb2.com");
		if (pvd === "digitalocean")
			setEndpoint("https://nyc3.digitaloceanspaces.com");
	};

	const analyze = async () => {
		setLoading(true);
		try {
			const res = await fetch("/dashboard/offboarding/analyze", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ endpoint, accessKeyId, secretAccessKey }),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || "Analyze failed");
			setPlan(
				(data.plan || []).map((r: Omit<PlanRow, "selected">) => ({
					...r,
					selected: true,
				})),
			);
			setStep(4);
		} catch (e) {
			window.alert(e instanceof Error ? e.message : "Analyze failed");
		} finally {
			setLoading(false);
		}
	};

	const startMigration = async () => {
		if (!window.confirm("This will freeze your account. Continue?")) return;
		setStep(5);
		setLogs([]);
		addLog("Initializing migration agent...");

		const bucketMapping = Object.fromEntries(
			plan
				.filter((p2) => p2.selected)
				.map((p2) => [p2.localName, p2.targetName]),
		);

		try {
			const response = await fetch("/dashboard/offboarding/migrate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					endpoint,
					accessKeyId,
					secretAccessKey,
					bucketMapping,
				}),
			});

			const reader = response.body?.getReader();
			if (!reader) throw new Error("No response stream");
			const decoder = new TextDecoder();
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				const chunk = decoder.decode(value);
				const lines = chunk.split("\n");
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						try {
							const msg = JSON.parse(line.slice(6));
							addLog(msg.text, msg.type);
						} catch {
							// noop
						}
					}
				}
			}
		} catch (e) {
			addLog(
				`Critical error: ${e instanceof Error ? e.message : "unknown"}`,
				"error",
			);
		}
	};

	const copyLogs = async () => {
		const text = logs
			.map((l) => `[${l.time}] ${l.type.toUpperCase()}: ${l.msg}`)
			.join("\n");
		await navigator.clipboard.writeText(text);
		window.alert("Logs copied to clipboard");
	};

	const createRcloneExport = async () => {
		setDownloadBusy(true);
		setDownloadError(null);
		try {
			const res = await fetch("/dashboard/offboarding/rclone-export", {
				method: "POST",
			});
			const data = await res.json();
			if (!res.ok) {
				throw new Error(data.error || "Failed to create export command");
			}
			setExportCommand(data);
			setSelectedExportBuckets(data.bucketNames || []);
		} catch (error) {
			setDownloadError(
				error instanceof Error ? error.message : "Failed to create export command",
			);
		} finally {
			setDownloadBusy(false);
		}
	};

	const startBrowserDownload = async () => {
		if (!window.confirm("Download archive and freeze account?")) return;
		const form = document.createElement("form");
		form.method = "POST";
		form.action = "/dashboard/offboarding/download";
		document.body.appendChild(form);
		form.submit();
		form.remove();
	};

	const handleDownloadArchive = async () => {
		if (!isLargeDownload) {
			await startBrowserDownload();
			return;
		}
		setDownloadModalOpen(true);
		if (!exportCommand && !downloadBusy) {
			await createRcloneExport();
		}
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
			hideNavLinks
		>
			<div className="flex-1 flex flex-col items-center justify-center p-6 w-full max-w-5xl mx-auto">
				<AnimatePresence mode="wait">
					<motion.div
						key={`offboarding-step-${step}-${provider ?? "none"}-${r2GuideSeen ? "guide-seen" : "guide-hidden"}`}
						initial={{ opacity: 0, y: 20, scale: 0.99 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: -16, scale: 0.99 }}
						transition={{ duration: 0.25, ease: "easeOut" }}
						className="w-full"
					>
						{step === 1 ? (
							<div className="w-full max-w-4xl mx-auto text-center">
								<div className="mb-8 flex justify-center">
									<PhIcon className="ph-duotone ph-hand-waving text-8xl text-hc-red transform scale-x-[-1]" />
								</div>
								{p.user?.dataExported ? (
									<>
										<h1 className="text-6xl md:text-8xl font-black text-white mb-8 tracking-tighter italic">
											It was amazing having you.
										</h1>
										<p className="text-text-muted text-2xl max-w-3xl mx-auto font-medium mb-12 leading-relaxed">
											Your data has been successfully migrated. Your account is
											now frozen.
										</p>
									</>
								) : (
									<>
										<h1 className="text-6xl md:text-8xl font-black text-white mb-8 tracking-tighter italic">
											It's time to say goodbye.
										</h1>
										<p className="text-text-muted text-2xl max-w-3xl mx-auto font-medium mb-12 leading-relaxed">
											You've turned 18, so you've aged out of Silo. You have{" "}
											<span className="text-white font-bold">
												{p.daysRemaining} days
											</span>{" "}
											to export your{" "}
											<span className="text-white font-bold">
												{p.totalStorageFormatted}
											</span>{" "}
											of data.
										</p>
									</>
								)}

								<div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
									<div className="bg-hc-dark border border-white/10 rounded-3xl p-8 card-shadow flex flex-col items-center text-center">
										<div className={`h-20 w-20 rounded-full flex items-center justify-center mb-6 text-4xl ${isLargeDownload ? "bg-blue-500/10 text-blue-400" : "bg-white/10 text-white"}`}>
											<PhIcon
												className={`text-5xl ${isLargeDownload ? "ph-duotone ph-download" : "ph-duotone ph-file-zip"}`}
											/>
										</div>
										<h3 className="text-2xl font-bold text-white mb-2">
											{isLargeDownload ? "Download on device" : "Download ZIP"}
										</h3>
										<p className="text-text-muted mb-8 flex-1 text-lg">
											{isLargeDownload
												? "Download all your buckets and folders directly onto this device with a much more reliable local transfer flow."
												: "Get one archive containing all bucket files and metadata."}
										</p>
										{p.showSuccess ? (
											<div className="bg-green-500/20 text-green-400 p-4 rounded-xl font-bold w-full">
												<PhIcon className="ph-bold ph-check-circle mr-2" />{" "}
												Archive Created
											</div>
										) : (
											<div className="w-full">
												<button
													type="button"
													onClick={() => void handleDownloadArchive()}
													className="w-full bg-white/10 hover:bg-white/20 text-white font-bold py-4 rounded-xl transition-all"
												>
													{isLargeDownload ? "Download on this device" : "Download Archive"}
												</button>
												{isLargeDownload ? (
													<p className="mt-3 text-xs text-text-muted">
														Download everything to this device.
													</p>
												) : null}
											</div>
										)}
									</div>

									<div className="bg-hc-dark border border-white/10 rounded-3xl p-8 card-shadow flex flex-col items-center text-center relative overflow-hidden">
										{!p.user?.dataExported ? (
											<div className="absolute top-0 right-0 bg-hc-red text-white text-xs font-bold px-3 py-1 rounded-bl-xl">
												RECOMMENDED
											</div>
										) : null}
										<div className="h-20 w-20 bg-blue-500/10 rounded-full flex items-center justify-center mb-6 text-4xl text-blue-400">
											<PhIcon className="ph-duotone ph-rocket-launch" />
										</div>
										<h3 className="text-2xl font-bold text-white mb-2">
											Migration Assistant
										</h3>
										<p className="text-text-muted mb-8 flex-1 text-lg">
											Transfer files directly to Cloudflare R2, AWS, or any S3
											provider.
										</p>
										<button
											type="button"
											onClick={() => setStep(2)}
											className="w-full bg-hc-red text-white hover:bg-red-600 font-bold py-4 rounded-xl transition-all"
										>
											Start Migration
										</button>
									</div>
								</div>
							</div>
						) : null}

						{step === 2 ? (
							<div className="w-full max-w-5xl mx-auto text-center">
								<h2 className="text-4xl md:text-6xl font-black text-white mb-4 tracking-tighter italic">
									Choose your new home
								</h2>
								<p className="text-text-muted text-2xl font-medium mb-8">
									Where should we move your files?
								</p>
								<div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left mb-12">
									<ProviderCard
										onClick={() => selectProvider("r2")}
										title="Cloudflare R2"
										subtitle="Zero egress fees. S3-compatible."
										icon="/assets/images/cloudflare.png"
										recommended
									/>
									<ProviderCard
										onClick={() => selectProvider("aws")}
										title="Amazon S3"
										subtitle="The industry standard."
										icon="/assets/images/aws.png"
									/>
									<ProviderCard
										onClick={() => selectProvider("backblaze")}
										title="Backblaze B2"
										subtitle="Affordable object storage."
										icon="/assets/images/backblaze.png"
									/>
									<ProviderCard
										onClick={() => selectProvider("digitalocean")}
										title="DigitalOcean"
										subtitle="Simple Spaces object storage."
										icon="/assets/images/digitalocean.png"
									/>
									<button
										type="button"
										onClick={() => selectProvider("custom")}
										className="group bg-hc-dark hover:bg-white/5 border border-white/10 hover:border-white/50 rounded-2xl p-6 transition-all flex items-center gap-6 col-span-1 md:col-span-2"
									>
										<div className="h-16 w-16 shrink-0 rounded-xl bg-white/10 flex items-center justify-center p-3 text-3xl text-white">
											<PhIcon className="ph-bold ph-globe" />
										</div>
										<div className="flex-1">
											<h4 className="text-white font-bold text-xl mb-1">
												Other / S3 Compatible
											</h4>
											<p className="text-text-muted text-sm">
												MinIO, Wasabi, etc.
											</p>
										</div>
									</button>
								</div>
								{/* back button is rendered by shared footer controls below */}
							</div>
						) : null}

						{step === 3 ? (
							<div
								className={`w-full mx-auto ${!r2GuideSeen && provider === "r2" ? "max-w-5xl" : "max-w-2xl"}`}
							>
								{!r2GuideSeen && provider === "r2" ? (
									<div className="text-center">
										<h2 className="text-4xl md:text-6xl font-black text-white mb-4 tracking-tighter italic">
											Setting up Cloudflare R2
										</h2>
										<p className="text-text-muted text-2xl font-medium mb-8">
											Follow the dashboard screenshots, then continue.
										</p>
										<div className="grid grid-cols-1 gap-8 mb-8">
											{[1, 2, 3, 4, 5, 6].map((n) => (
												<div
													key={n}
													className="bg-hc-dark border border-white/10 rounded-2xl overflow-hidden"
												>
													<div className="p-4 border-b border-white/5 font-bold text-white">
														Step {n}
													</div>
													<div className="bg-black/50 p-4">
														<img
															src={`/assets/images/r2-guide/Step${n}${n === 1 ? "HeadtoR2Section" : n === 2 ? "SubtoR2" : n === 3 ? "GoToManageKeys" : n === 4 ? "CreateNewAccountToken" : n === 5 ? "MakeToken" : "CopyCredentials"}.png`}
															alt={`R2 step ${n}`}
															className="rounded-lg shadow-2xl border border-white/10 w-full"
														/>
													</div>
												</div>
											))}
										</div>
										<button
											type="button"
											onClick={() => setR2GuideSeen(true)}
											className="bg-[#F38020] text-white hover:bg-[#d66e16] font-bold text-xl py-4 px-12 rounded-xl transition-all"
										>
											I have my credentials
										</button>
									</div>
								) : (
									<div>
										<div className="text-center mb-8">
											<h2 className="text-4xl md:text-6xl font-black text-white mb-4 tracking-tighter italic">
												Connect {providerName}
											</h2>
											<p className="text-text-muted text-2xl font-medium">
												Enter your credentials.
											</p>
										</div>
										<form
											onSubmit={(e) => {
												e.preventDefault();
												analyze();
											}}
											className="space-y-6 text-left"
										>
											<div>
												<label
													htmlFor="offboarding-endpoint"
													className="block text-sm font-bold text-text-muted uppercase tracking-wider mb-2"
												>
													Endpoint URL
												</label>
												<input
													id="offboarding-endpoint"
													value={endpoint}
													onChange={(e) => setEndpoint(e.target.value)}
													required
													placeholder={
														provider === "r2"
															? "https://<account_id>.r2.cloudflarestorage.com"
															: "https://..."
													}
													className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-4 text-white font-mono focus:border-hc-red focus:outline-none transition-colors"
												/>
											</div>
											<div>
												<label
													htmlFor="offboarding-access-key"
													className="block text-sm font-bold text-text-muted uppercase tracking-wider mb-2"
												>
													Access Key ID
												</label>
												<input
													id="offboarding-access-key"
													value={accessKeyId}
													onChange={(e) => setAccessKeyId(e.target.value)}
													required
													className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-4 text-white font-mono focus:border-hc-red focus:outline-none transition-colors"
												/>
											</div>
											<div>
												<label
													htmlFor="offboarding-secret-key"
													className="block text-sm font-bold text-text-muted uppercase tracking-wider mb-2"
												>
													Secret Access Key
												</label>
												<input
													id="offboarding-secret-key"
													type="password"
													value={secretAccessKey}
													onChange={(e) => setSecretAccessKey(e.target.value)}
													required
													className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-4 text-white font-mono focus:border-hc-red focus:outline-none transition-colors"
												/>
											</div>
											<button
												type="submit"
												disabled={loading}
												className="w-full bg-hc-red text-white hover:bg-red-600 font-bold text-lg py-4 rounded-xl transition-all disabled:opacity-50"
											>
												{loading ? "Connecting..." : "Connect & Analyze"}
											</button>
										</form>
									</div>
								)}
							</div>
						) : null}

						{step === 4 ? (
							<div className="w-full max-w-4xl mx-auto">
								<div className="text-center mb-8">
									<h2 className="text-4xl md:text-6xl font-black text-white mb-4 tracking-tighter italic">
										Migration Plan
									</h2>
									<p className="text-text-muted text-2xl font-medium">
										Review where your buckets will go.
									</p>
								</div>

								<div className="bg-hc-dark border border-white/10 rounded-2xl overflow-hidden mb-8">
									<table className="w-full text-left">
										<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
											<tr>
												<th className="p-4 w-12 text-center">
													<input
														type="checkbox"
														checked={plan.every((r) => r.selected)}
														onChange={(e) =>
															setPlan((prev) =>
																prev.map((r) => ({
																	...r,
																	selected: e.target.checked,
																})),
															)
														}
														className="rounded bg-white/10 border-white/20 text-hc-red focus:ring-0"
													/>
												</th>
												<th className="p-4">Local Bucket</th>
												<th className="p-4">Target Bucket</th>
												<th className="p-4 text-right">Status</th>
											</tr>
										</thead>
										<tbody className="divide-y divide-white/5 text-white">
											{plan.map((bucket) => (
												<tr key={`${bucket.localName}:${bucket.targetName}`}>
													<td className="p-4 text-center">
														<input
															type="checkbox"
															checked={bucket.selected}
															onChange={(e) =>
																setPlan((prev) =>
																	prev.map((r) =>
																		r.localName === bucket.localName
																			? { ...r, selected: e.target.checked }
																			: r,
																	),
																)
															}
															className="rounded bg-white/10 border-white/20 text-hc-red focus:ring-0"
														/>
													</td>
													<td className="p-4 font-mono text-white/70">
														{bucket.localName}
													</td>
													<td className="p-4">
														<input
															value={bucket.targetName}
															onChange={(e) =>
																setPlan((prev) =>
																	prev.map((r) =>
																		r.localName === bucket.localName
																			? { ...r, targetName: e.target.value }
																			: r,
																	),
																)
															}
															className="bg-black/20 border border-white/10 rounded px-3 py-2 w-full font-mono text-sm focus:border-hc-red outline-none"
														/>
													</td>
													<td className="p-4 text-right">
														{bucket.status === "AVAILABLE" ? (
															<span className="text-blue-400 text-xs font-bold uppercase">
																Create
															</span>
														) : null}
														{bucket.status === "EXISTS" ? (
															<span className="text-green-400 text-xs font-bold uppercase">
																Exists
															</span>
														) : null}
														{bucket.status === "TAKEN" ? (
															<span className="text-red-400 text-xs font-bold uppercase">
																Taken
															</span>
														) : null}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>

								<button
									type="button"
									onClick={startMigration}
									className="w-full bg-hc-red text-white hover:bg-red-600 font-bold text-lg py-4 rounded-xl transition-all"
								>
									Start Migration
								</button>
							</div>
						) : null}

						{step === 5 ? (
							<div className="w-full max-w-4xl mx-auto">
								<div className="text-center mb-8">
									<h2 className="text-4xl md:text-6xl font-black text-white mb-4 tracking-tighter italic">
										Migrating...
									</h2>
									<p className="text-text-muted text-2xl font-medium">
										Don't close this tab.
									</p>
								</div>
								<div className="flex justify-end mb-2">
									<button
										type="button"
										onClick={copyLogs}
										className="text-xs text-text-muted hover:text-white"
									>
										Copy Logs
									</button>
								</div>
								<div className="bg-black rounded-xl border border-white/10 p-4 h-96 font-mono text-sm overflow-y-auto text-left">
									{logs.map((log) => (
										<div
											key={log.id}
											className={`py-0.5 border-b border-white/5 last:border-0 ${log.type === "error" ? "text-red-400 font-bold bg-red-900/10" : log.type === "success" ? "text-green-400 font-bold" : "text-white/60"}`}
										>
											<span className="opacity-30 mr-2">{log.time}</span>
											<span>{log.msg}</span>
										</div>
									))}
								</div>
							</div>
						) : null}
					</motion.div>
				</AnimatePresence>

				{step > 1 && step < 5 ? (
					<div className="flex items-center justify-center mt-8">
						<button
							type="button"
							onClick={() => {
								if (step === 2) setStep(1);
								if (step === 3)
									setStep(provider === "r2" && r2GuideSeen ? 3 : 2);
								if (step === 4) setStep(3);
							}}
							className="text-text-muted hover:text-white px-6 py-3 font-bold text-lg transition-colors"
						>
							Back
						</button>
					</div>
				) : null}
			</div>

			<Modal
				open={downloadModalOpen}
				onClose={() => setDownloadModalOpen(false)}
				title="Large export download"
				className="max-w-7xl p-8"
			>
				<div className="space-y-6">
					<div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
						Your export is currently <span className="font-bold text-white">{p.totalStorageFormatted}</span>. Downloads this large can fail or be painfully slow in the browser. We strongly recommend using the terminal command below so every object downloads directly and reliably.
					</div>

					<div className="grid gap-4 md:grid-cols-2">
						<div className="rounded-2xl border border-white/10 bg-black/20 p-4">
							<div className="text-xs uppercase tracking-wider text-text-muted mb-2">Export size</div>
							<div className="text-lg font-bold text-white">{p.totalStorageFormatted}</div>
						</div>
						<div className="rounded-2xl border border-white/10 bg-black/20 p-4">
							<div className="text-xs uppercase tracking-wider text-text-muted mb-2">Save destination</div>
							<div className="text-sm text-white font-mono break-all">./silo-export</div>
						</div>
					</div>

					<div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_340px]">
						<div>
							{exportCommand ? (
								<div className="mb-4 rounded-2xl border border-white/10 bg-black/20 p-4">
									<div className="mb-3 flex items-center justify-between gap-4">
										<h4 className="text-sm font-bold text-white">Speed</h4>
										<div className="text-xs text-text-muted">
											{exportSpeedMode === "safe"
												? "safer"
												: exportSpeedMode === "fast"
													? "max speed"
													: "balanced"}
										</div>
									</div>
									<input
										type="range"
										min={0}
										max={2}
										step={1}
										value={
											exportSpeedMode === "safe"
												? 0
												: exportSpeedMode === "balanced"
													? 1
													: 2
										}
										onChange={(event) => {
											const value = Number(event.target.value);
											setExportSpeedMode(
												value === 0 ? "safe" : value === 2 ? "fast" : "balanced",
											);
										}}
										className="w-full"
									/>
									<div className="mt-2 flex justify-between text-xs text-text-muted">
										<span>Safer</span>
										<span>Balanced</span>
										<span>Max speed</span>
									</div>
								</div>
							) : null}

							<div className="flex items-center justify-between gap-3 mb-2">
								<h3 className="text-lg font-bold text-white">Recommended terminal command</h3>
								<button
									type="button"
									onClick={() => void createRcloneExport()}
									disabled={downloadBusy}
									className="text-sm text-text-muted hover:text-white disabled:opacity-50"
								>
									{downloadBusy ? "Generating..." : exportCommand ? "Refresh" : "Generate"}
								</button>
							</div>
							{downloadError ? (
								<div className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
									{downloadError}
								</div>
							) : null}
							{exportCommand ? (
								<>
									<textarea
										readOnly
										value={renderedExportCommand}
										className="min-h-40 w-full rounded-2xl border border-white/10 bg-black/30 p-4 font-mono text-sm text-white focus:outline-none"
									/>
									<p className="mt-2 text-xs text-text-muted">
										Valid until {new Date(exportCommand.expiresAt).toLocaleString()}. Change the final path from <span className="font-mono text-white">./silo-export</span> to anywhere you want on your machine before you run it.
									</p>
								</>
							) : (
								<div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-text-muted">
									Generate the export command, then paste it into your terminal. It will download all buckets and folders directly.
								</div>
							)}
						</div>

						<div>
							{exportCommand ? (
								<div className="rounded-2xl border border-white/10 bg-black/20 p-4">
									<div className="mb-3 flex items-center justify-between gap-4">
										<h4 className="text-sm font-bold text-white">Buckets to download</h4>
										<button
											type="button"
											onClick={() =>
												setSelectedExportBuckets((prev) =>
													prev.length === exportCommand.bucketNames.length
														? []
														: exportCommand.bucketNames,
												)
											}
											className="text-xs text-text-muted hover:text-white"
										>
											{selectedExportBuckets.length === exportCommand.bucketNames.length
												? "Clear all"
												: "Select all"}
										</button>
									</div>
									<div className="space-y-2 max-h-[420px] overflow-auto pr-1">
										{exportCommand.buckets.map((bucket) => (
											<label
												key={bucket.name}
												className="block rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white"
											>
												<div className="flex items-start gap-3">
													<input
														type="checkbox"
														checked={selectedExportBuckets.includes(bucket.name)}
														onChange={(event) => {
															setSelectedExportBuckets((prev) =>
																event.target.checked
																	? [...prev, bucket.name]
																	: prev.filter((item) => item !== bucket.name),
															);
														}}
														className="mt-1"
													/>
													<div className="min-w-0 flex-1">
														<div className="font-mono break-all text-white">{bucket.name}</div>
														<div className="mt-1 text-xs text-text-muted">
															{bucket.objectCount.toLocaleString()} objects • {formatBytes(bucket.totalBytes)}
														</div>
													</div>
												</div>
											</label>
										))}
									</div>
								</div>
							) : null}
						</div>
					</div>

					<div className="flex flex-wrap justify-end gap-3">
						{exportCommand ? (
							<button
								type="button"
								onClick={() => void navigator.clipboard.writeText(renderedExportCommand)}
								className="rounded-xl bg-hc-red px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-red-600"
							>
								Copy command
							</button>
						) : null}
						<button
							type="button"
							onClick={() => void startBrowserDownload()}
							className="rounded-xl bg-white/10 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-white/20"
						>
							Try browser download anyway
						</button>
					</div>
				</div>
			</Modal>
		</AppShell>
	);
}

function ProviderCard({
	title,
	subtitle,
	icon,
	recommended,
	onClick,
}: {
	title: string;
	subtitle: string;
	icon: string;
	recommended?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="group bg-hc-dark hover:bg-white/5 border border-white/10 rounded-2xl p-6 transition-all flex items-center gap-6 text-left"
		>
			<div className="h-16 w-16 shrink-0 rounded-xl bg-white flex items-center justify-center p-3">
				<img src={icon} className="w-full h-full object-contain" alt={title} />
			</div>
			<div className="flex-1">
				<div className="flex items-center gap-3 mb-1">
					<h4 className="text-white font-bold text-xl">{title}</h4>
					{recommended ? (
						<span className="bg-hc-red/20 text-hc-red text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">
							Recommended
						</span>
					) : null}
				</div>
				<p className="text-text-muted text-sm">{subtitle}</p>
			</div>
		</button>
	);
}
