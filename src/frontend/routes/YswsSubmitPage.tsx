import { useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type HackatimeProject = {
	id: string;
	name: string;
	hours: number;
};

type BonusTier = {
	hours: number;
	percent: number;
	enabled: boolean;
};

type FormErrors = Record<string, string | string[] | undefined>;

function firstError(value: string | string[] | undefined): string | null {
	if (!value) return null;
	if (Array.isArray(value)) return value[0] || null;
	return value;
}

export function YswsSubmitPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		hackatimeProjects?: HackatimeProject[];
		quotaPerHour?: number;
		yswsBonusTiers?: BonusTier[];
		quotaPerHourFormatted?: string;
		errors?: FormErrors;
		values?: Record<string, unknown>;
		error?: string;
	};

	const values = p.values || {};
	const quotaPerHour = p.quotaPerHour || 0;
	const tiers = p.yswsBonusTiers || [];

	const initialSelected = String(values.hackatimeProject || "")
		.split(",")
		.filter(Boolean);

	const [selectedIds, setSelectedIds] = useState<string[]>(initialSelected);
	const [search, setSearch] = useState("");
	const [aiLevel, setAiLevel] = useState<number>(() => {
		const tool = String(values.aiToolUsage || "none");
		if (tool === "tab-completion") return 1;
		if (tool === "inline") return 2;
		if (tool === "chat" || tool === "command-k") return 3;
		if (tool === "no-code") return 4;
		return 0;
	});
	const [aiPercent, setAiPercent] = useState<number>(
		Number(values.aiPercent || 0),
	);
	const [preview, setPreview] = useState<string>("");

	const filteredProjects = useMemo(() => {
		if (!search.trim()) return p.hackatimeProjects || [];
		return (p.hackatimeProjects || []).filter((item) =>
			item.name.toLowerCase().includes(search.toLowerCase()),
		);
	}, [p.hackatimeProjects, search]);

	const baseRewardBytes = useMemo(() => {
		const selected = (p.hackatimeProjects || []).filter((project) =>
			selectedIds.includes(project.id),
		);
		const hours = selected.reduce((acc, item) => acc + item.hours, 0);
		return hours * quotaPerHour;
	}, [p.hackatimeProjects, quotaPerHour, selectedIds]);

	const activeTierBonus = useMemo(() => {
		const totalHours = (p.hackatimeProjects || [])
			.filter((project) => selectedIds.includes(project.id))
			.reduce((acc, item) => acc + item.hours, 0);
		const valid = tiers
			.filter((tier) => tier.enabled && totalHours >= tier.hours)
			.sort((a, b) => b.hours - a.hours);
		return valid[0]?.percent || 0;
	}, [p.hackatimeProjects, selectedIds, tiers]);

	const totalRewardBytes = Math.floor(
		baseRewardBytes * (1 + activeTierBonus / 100),
	);

	const requiresDetails = aiLevel > 0 && aiLevel < 4;
	const isRejected = aiLevel === 4 || (requiresDetails && aiPercent > 30);

	const aiToolUsage =
		aiLevel === 0
			? "none"
			: aiLevel === 1
				? "tab-completion"
				: aiLevel === 2
					? "inline"
					: aiLevel === 3
						? "chat"
						: "no-code";

	const aiLabel =
		aiLevel === 0
			? "No AI Used"
			: aiLevel === 1
				? "Tab Completion"
				: aiLevel === 2
					? "Inline Generation"
					: aiLevel === 3
						? "Chat Assistant"
						: "Purely AI / No Code";

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<div className="max-w-3xl mx-auto py-12">
				<div className="mb-8 text-center">
					<h1 className="text-4xl font-extrabold tracking-tight mb-2 text-white">
						YSWS
					</h1>
					<p className="text-xl text-white/60">
						Ship your projects, earn more storage. Simple as that.
					</p>
					<p className="mt-4 text-sm text-hc-green bg-hc-green/10 border border-hc-green/20 rounded-full px-4 py-1 inline-block">
						Earn {p.quotaPerHourFormatted || formatBytes(quotaPerHour)} per hour
						tracked on Hackatime
					</p>
				</div>

				<div className="flex justify-center mb-8">
					<a
						href="/ysws"
						className="text-sm text-text-muted hover:text-white transition-colors flex items-center gap-2"
					>
						<PhIcon className="ph ph-arrow-left text-lg" />
						Back to Dashboard
					</a>
				</div>

				<div className="bg-hc-dark border border-white/10 rounded-3xl p-8 card-shadow">
					<form
						action="/ysws/submit"
						method="POST"
						encType="multipart/form-data"
						className="space-y-6"
					>
						<div className="space-y-4">
							<h3 className="text-lg font-bold border-b border-white/10 pb-2 mb-4">
								Project Details
							</h3>

							<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
								<div>
									<label
										htmlFor="project-name"
										className="block text-sm font-bold text-text-muted uppercase tracking-wider mb-2"
									>
										Project Name
									</label>
									<input
										id="project-name"
										type="text"
										name="projectName"
										defaultValue={String(values.projectName || "")}
										required
										className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
										placeholder="My Awesome Project"
									/>
									{firstError(p.errors?.projectName) ? (
										<p className="text-red-400 text-xs mt-1">
											{firstError(p.errors?.projectName)}
										</p>
									) : null}
								</div>

								<div>
									<label
										htmlFor="short-description"
										className="block text-sm font-bold text-text-muted uppercase tracking-wider mb-2"
									>
										Short Description
									</label>
									<input
										id="short-description"
										type="text"
										name="shortDescription"
										defaultValue={String(values.shortDescription || "")}
										required
										className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
										placeholder="A website that does X..."
									/>
									{firstError(p.errors?.shortDescription) ? (
										<p className="text-red-400 text-xs mt-1">
											{firstError(p.errors?.shortDescription)}
										</p>
									) : null}
								</div>
							</div>

							<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
								<div>
									<label
										htmlFor="repo-url"
										className="block text-sm font-bold text-text-muted uppercase tracking-wider mb-2"
									>
										Code URL (Repo)
									</label>
									<input
										id="repo-url"
										type="url"
										name="repoUrl"
										defaultValue={String(values.repoUrl || "")}
										required
										className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm"
										placeholder="https://github.com/..."
									/>
									{firstError(p.errors?.repoUrl) ? (
										<p className="text-red-400 text-xs mt-1">
											{firstError(p.errors?.repoUrl)}
										</p>
									) : null}
								</div>

								<div>
									<label
										htmlFor="demo-url"
										className="block text-sm font-bold text-text-muted uppercase tracking-wider mb-2"
									>
										Demo / Playable URL
									</label>
									<input
										id="demo-url"
										type="url"
										name="demoUrl"
										defaultValue={String(values.demoUrl || "")}
										required
										className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm"
										placeholder="https://my-project.hackclub.app"
									/>
									{firstError(p.errors?.demoUrl) ? (
										<p className="text-red-400 text-xs mt-1">
											{firstError(p.errors?.demoUrl)}
										</p>
									) : null}
								</div>
							</div>

							<div>
								<label
									htmlFor="file-input"
									className="block text-sm font-medium text-text-muted mb-2"
								>
									Project Screenshot
								</label>
								<div className="border-2 border-dashed border-white/20 rounded-xl p-6 transition-colors hover:border-white/40">
									<input
										id="file-input"
										type="file"
										name="screenshotFile"
										accept="image/*"
										onChange={(e) => {
											const file = e.target.files?.[0];
											if (!file) {
												setPreview("");
												return;
											}
											setPreview(URL.createObjectURL(file));
										}}
										className="w-full text-sm text-white/80"
									/>
									{preview ? (
										<img
											src={preview}
											alt="Preview"
											className="mt-4 max-h-48 rounded-lg"
										/>
									) : null}
								</div>

								<div className="mt-4">
									<label
										htmlFor="screenshot-url"
										className="block text-xs font-medium text-text-muted mb-1 uppercase tracking-wider"
									>
										Provide URL
									</label>
									<input
										id="screenshot-url"
										type="url"
										name="screenshotUrl"
										defaultValue={String(values.screenshotUrl || "")}
										className="w-full bg-black/20 border border-white/10 rounded px-3 py-2 text-white text-sm font-mono"
										placeholder="https://..."
									/>
								</div>
								{firstError(p.errors?.screenshotUrl) ? (
									<p className="text-red-400 text-xs mt-1">
										{firstError(p.errors?.screenshotUrl)}
									</p>
								) : null}
							</div>
						</div>

						<div className="space-y-4 pt-4 border-t border-white/10">
							<h3 className="text-lg font-bold text-white mb-2">
								Hackatime Integration
							</h3>
							<label
								htmlFor="hackatime-search"
								className="block text-sm font-bold text-text-muted uppercase tracking-wider mb-2"
							>
								Select Hackatime Project(s)
							</label>
							<input
								id="hackatime-search"
								type="text"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Search projects..."
								className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
							/>
							<input
								type="hidden"
								name="hackatimeProject"
								value={selectedIds.join(",")}
							/>
							<div className="max-h-56 overflow-y-auto rounded-xl border border-white/10 bg-black/20 mt-3">
								{filteredProjects.map((project) => {
									const selected = selectedIds.includes(project.id);
									return (
										<button
											key={project.id}
											type="button"
											onClick={() =>
												setSelectedIds((prev) =>
													selected
														? prev.filter((id) => id !== project.id)
														: [...prev, project.id],
												)
											}
											className="w-full text-left px-4 py-3 hover:bg-white/5 border-b last:border-b-0 border-white/5"
										>
											<div className="flex items-center justify-between gap-3">
												<div>
													<div className="font-bold text-sm text-white">
														{project.name}
													</div>
													<div className="text-xs text-text-muted">
														{project.hours} hours tracked
													</div>
												</div>
												<span
													className={`text-xs rounded px-2 py-1 border ${
														selected
															? "text-hc-green border-hc-green/40 bg-hc-green/10"
															: "text-text-muted border-white/20"
													}`}
												>
													{selected
														? "Selected"
														: formatBytes(project.hours * quotaPerHour)}
												</span>
											</div>
										</button>
									);
								})}
								{!filteredProjects.length ? (
									<div className="px-4 py-3 text-sm text-text-muted text-center italic">
										No projects found
									</div>
								) : null}
							</div>
							<div className="mt-3 p-3 rounded-lg bg-black/20 border border-white/5 space-y-1 text-sm">
								<div className="flex justify-between">
									<span className="text-text-muted">Base Reward:</span>
									<span className="text-white font-bold">
										{formatBytes(baseRewardBytes)}
									</span>
								</div>
								<div className="flex justify-between">
									<span className="text-text-muted">Tier Bonus:</span>
									<span className="text-hc-green font-bold">
										+{activeTierBonus}%
									</span>
								</div>
								<div className="flex justify-between border-t border-white/5 pt-1">
									<span className="text-white font-bold">Total Reward:</span>
									<span className="text-hc-green font-bold">
										{formatBytes(totalRewardBytes)}
									</span>
								</div>
							</div>
							{firstError(p.errors?.hackatimeProject) ? (
								<p className="text-red-400 text-xs mt-1">
									{firstError(p.errors?.hackatimeProject)}
								</p>
							) : null}
						</div>

						<div className="space-y-4 pt-4 border-t border-white/10">
							<h3 className="text-lg font-bold text-white mb-2">
								AI Usage Declaration
							</h3>
							<input type="hidden" name="aiToolUsage" value={aiToolUsage} />
							<input
								type="hidden"
								name="usedAi"
								value={aiLevel > 0 ? "yes" : "no"}
							/>
							<div className="bg-black/30 rounded-xl p-6 border border-white/10">
								<div className="mb-6">
									<label
										htmlFor="ai-level"
										className="block text-sm font-bold text-text-muted uppercase tracking-wider mb-1"
									>
										How much AI did you use?
									</label>
									<p className="text-xs text-text-muted/60 mb-1">
										Only AI-generated code counts as AI usage.
									</p>
								</div>

								<input
									id="ai-level"
									type="range"
									min={0}
									max={4}
									step={1}
									value={aiLevel}
									onChange={(e) => setAiLevel(Number(e.target.value))}
									className="w-full accent-hc-red cursor-pointer"
								/>

								<div
									className={`text-center p-4 rounded-lg border mt-5 ${
										isRejected
											? "border-red-500/50 bg-red-500/10"
											: aiLevel === 0
												? "border-hc-green/30 bg-hc-green/10"
												: "border-white/10 bg-white/5"
									}`}
								>
									<h4 className="font-bold text-lg text-white">{aiLabel}</h4>
									{isRejected ? (
										<p className="text-red-400 text-sm mt-2 font-bold">
											This submission is ineligible until AI usage meets policy.
										</p>
									) : null}
								</div>

								<div className="mt-6 space-y-4">
									<div>
										<div className="flex justify-between items-center mb-2">
											<label
												htmlFor="ai-percent"
												className="block text-sm font-bold text-text-muted uppercase tracking-wider"
											>
												Percentage of AI Generated Code
											</label>
											<span className="text-sm font-mono text-hc-red">
												{aiPercent}%
											</span>
										</div>
										<input
											id="ai-percent"
											type="range"
											name="aiPercent"
											value={aiPercent}
											min={0}
											max={100}
											onChange={(e) => setAiPercent(Number(e.target.value))}
											className="w-full accent-hc-red cursor-pointer"
										/>
									</div>

									<div>
										<label
											htmlFor="ai-usage-description"
											className="block text-sm font-bold text-text-muted uppercase tracking-wider mb-2"
										>
											Description of AI Usage
										</label>
										<textarea
											id="ai-usage-description"
											name="aiUsageDescription"
											rows={3}
											defaultValue={String(values.aiUsageDescription || "")}
											required={requiresDetails}
											className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
											placeholder="I used Copilot for boilerplate and some regex..."
										/>
									</div>
								</div>
								{p.error ? (
									<p className="text-red-400 text-xs mt-1">{p.error}</p>
								) : null}
							</div>
						</div>

						<div className="space-y-4 pt-6 border-t border-white/10">
							<label className="flex items-start gap-4 cursor-pointer p-5 bg-black/30 rounded-xl border border-white/10">
								<input
									type="checkbox"
									name="readmeConfirmed"
									required
									defaultChecked={Boolean(values.readmeConfirmed)}
									className="mt-1 w-5 h-5 rounded border-white/30"
								/>
								<div>
									<div className="font-bold text-white text-base">
										I confirm my project has a great README
									</div>
									<div className="text-sm text-text-muted mt-1">
										Submissions without a descriptive README will be rejected.
									</div>
								</div>
							</label>
							{firstError(p.errors?.readmeConfirmed) ? (
								<p className="text-red-400 text-xs mt-1">
									{firstError(p.errors?.readmeConfirmed)}
								</p>
							) : null}
						</div>

						<button
							type="submit"
							className="w-full bg-hc-red hover:bg-red-600 text-white font-bold py-4 rounded-xl transition-all hover:scale-[1.02] shadow-lg shadow-hc-red/20 text-lg"
						>
							Ship Project
						</button>
					</form>
				</div>
			</div>
		</AppShell>
	);
}
