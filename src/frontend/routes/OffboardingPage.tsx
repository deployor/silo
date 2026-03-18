import { useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
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

export function OffboardingPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		daysRemaining?: number;
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

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
			hideNavLinks
		>
			<div className="flex-1 flex flex-col items-center justify-center p-6 w-full max-w-5xl mx-auto">
				{step === 1 ? (
					<div className="w-full max-w-4xl mx-auto text-center">
						<div className="mb-8 flex justify-center">
							<i className="ph-duotone ph-hand-waving text-8xl text-hc-red transform scale-x-[-1]" />
						</div>
						{p.user?.dataExported ? (
							<>
								<h1 className="text-6xl md:text-8xl font-black text-white mb-8 tracking-tighter italic">
									It was amazing having you.
								</h1>
								<p className="text-text-muted text-2xl max-w-3xl mx-auto font-medium mb-12 leading-relaxed">
									Your data has been successfully migrated. Your account is now
									frozen.
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
								<div className="h-20 w-20 bg-white/10 rounded-full flex items-center justify-center mb-6 text-4xl text-white">
									<i className="ph-duotone ph-file-zip text-5xl" />
								</div>
								<h3 className="text-2xl font-bold text-white mb-2">
									Download ZIP
								</h3>
								<p className="text-text-muted mb-8 flex-1 text-lg">
									Get one archive containing all bucket files and metadata.
								</p>
								{p.showSuccess ? (
									<div className="bg-green-500/20 text-green-400 p-4 rounded-xl font-bold w-full">
										<i className="ph-bold ph-check-circle mr-2" /> Archive
										Created
									</div>
								) : (
									<form
										action="/dashboard/offboarding/download"
										method="POST"
										className="w-full"
										onSubmit={(e) => {
											if (
												!window.confirm("Download archive and freeze account?")
											)
												e.preventDefault();
										}}
									>
										<button
											type="submit"
											className="w-full bg-white/10 hover:bg-white/20 text-white font-bold py-4 rounded-xl transition-all"
										>
											Download Archive
										</button>
									</form>
								)}
							</div>

							<div className="bg-hc-dark border border-white/10 rounded-3xl p-8 card-shadow flex flex-col items-center text-center relative overflow-hidden">
								{!p.user?.dataExported ? (
									<div className="absolute top-0 right-0 bg-hc-red text-white text-xs font-bold px-3 py-1 rounded-bl-xl">
										RECOMMENDED
									</div>
								) : null}
								<div className="h-20 w-20 bg-blue-500/10 rounded-full flex items-center justify-center mb-6 text-4xl text-blue-400">
									<i className="ph-duotone ph-rocket-launch" />
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
									<i className="ph-bold ph-globe" />
								</div>
								<div className="flex-1">
									<h4 className="text-white font-bold text-xl mb-1">
										Other / S3 Compatible
									</h4>
									<p className="text-text-muted text-sm">MinIO, Wasabi, etc.</p>
								</div>
							</button>
						</div>
						<button
							type="button"
							onClick={() => setStep(1)}
							className="text-text-muted hover:text-white px-6 py-3 font-bold text-lg transition-colors"
						>
							Back
						</button>
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
