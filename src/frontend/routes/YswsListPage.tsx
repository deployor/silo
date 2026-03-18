import { useState } from "react";
import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatDate } from "../shared/utils/format";

type Submission = {
	projectName: string;
	shortDescription?: string;
	screenshotUrl?: string;
	status: "pending" | "approved" | "rejected";
	hoursSpent?: number;
	tierBonusPercent?: number;
	adminBonusPercent?: number;
	createdAt?: string;
	repoUrl?: string;
	demoUrl?: string;
};

type GalleryProject = {
	projectName: string;
	shortDescription?: string;
	screenshotUrl?: string;
	hoursSpent?: number;
	demoUrl: string;
	repoUrl?: string;
	reviewedAt?: string;
};

export function YswsListPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		submissions?: Submission[];
		galleryProjects?: GalleryProject[];
		success?: boolean;
		activeTab?: "my-ships" | "gallery";
	};

	const [activeTab, setActiveTab] = useState<"my-ships" | "gallery">(
		p.activeTab ||
			(new URLSearchParams(window.location.search).get("tab") as
				| "my-ships"
				| "gallery") ||
			"my-ships",
	);

	const setTab = (tab: "my-ships" | "gallery") => {
		setActiveTab(tab);
		const url = new URL(window.location.href);
		url.searchParams.set("tab", tab);
		window.history.replaceState({}, "", url.toString());
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<div className="max-w-7xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
				<div className="flex flex-col md:flex-row justify-between items-end mb-8 gap-6 border-b border-white/10 pb-6">
					<div>
						<h1 className="text-4xl font-extrabold tracking-tight mb-2 text-white">
							YSWS Dashboard
						</h1>
						<p className="text-xl text-text-muted">Manage your projects.</p>
					</div>
					<a
						href="/ysws/submit"
						className="bg-hc-red hover:bg-red-600 text-white font-bold py-2.5 px-6 rounded-lg transition-colors shadow-lg shadow-hc-red/20 flex items-center gap-2"
					>
						<PhIcon className="ph-bold ph-plus" /> New Submission
					</a>
				</div>

				<div className="flex justify-start mb-8">
					<div className="bg-white/5 p-1 rounded-lg inline-flex border border-white/10">
						<button
							type="button"
							onClick={() => setTab("my-ships")}
							className={`px-6 py-2 rounded-md font-bold transition-all text-sm flex items-center gap-2 ${
								activeTab === "my-ships"
									? "bg-hc-blue text-white shadow-sm"
									: "text-white/60 hover:text-white hover:bg-white/5"
							}`}
						>
							<PhIcon className="ph-bold ph-rocket-launch" /> My Ships
						</button>
						<button
							type="button"
							onClick={() => setTab("gallery")}
							className={`px-6 py-2 rounded-md font-bold transition-all text-sm flex items-center gap-2 ${
								activeTab === "gallery"
									? "bg-hc-green text-white shadow-sm"
									: "text-white/60 hover:text-white hover:bg-white/5"
							}`}
						>
							<PhIcon className="ph-bold ph-images" /> Gallery
						</button>
					</div>
				</div>

				{p.success && activeTab === "my-ships" ? (
					<div className="mb-8 bg-green-500/10 border border-green-500/20 rounded-xl p-4 flex items-center gap-4">
						<div className="bg-green-500/20 p-2 rounded-full">
							<PhIcon className="ph-bold ph-check text-green-400" />
						</div>
						<div>
							<h3 className="font-bold text-green-400">Submission Received!</h3>
							<p className="text-green-300/80 text-sm">
								Your project is in the queue.
							</p>
						</div>
					</div>
				) : null}

				{activeTab === "my-ships" ? (
					<MyShips submissions={p.submissions || []} />
				) : (
					<GalleryTab projects={p.galleryProjects || []} />
				)}
			</div>
		</AppShell>
	);
}

function MyShips({ submissions }: { submissions: Submission[] }) {
	if (!submissions.length) {
		return (
			<div className="text-center py-20 bg-hc-dark border border-white/10 rounded-xl border-dashed">
				<div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
					<PhIcon className="ph ph-package text-3xl text-white/40" />
				</div>
				<h3 className="text-xl font-bold text-white mb-2">No Projects Yet</h3>
				<p className="text-text-muted max-w-sm mx-auto mb-6">
					Ship something awesome and earn storage!
				</p>
				<a
					href="/ysws/submit"
					className="inline-flex items-center gap-2 bg-hc-red hover:bg-red-600 text-white font-bold py-2 px-5 rounded-lg transition-colors"
				>
					Start Shipping
				</a>
			</div>
		);
	}

	const statusPill = (status: Submission["status"]) => {
		if (status === "pending")
			return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20";
		if (status === "approved")
			return "bg-green-500/10 text-green-500 border-green-500/20";
		return "bg-red-500/10 text-red-500 border-red-500/20";
	};

	return (
		<div className="bg-hc-dark border border-white/10 rounded-xl overflow-hidden">
			<table className="w-full text-left border-collapse">
				<thead>
					<tr className="bg-white/5 border-b border-white/10 text-xs uppercase tracking-wider text-text-muted font-bold">
						<th className="p-4 pl-6">Project</th>
						<th className="p-4">Status</th>
						<th className="p-4">Hours</th>
						<th className="p-4">Submitted</th>
						<th className="p-4 text-right pr-6">Links</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-white/5">
					{submissions.map((s) => (
						<tr
							key={`${s.projectName}:${s.createdAt || s.demoUrl || "submission"}`}
							className="group hover:bg-white/[0.02] transition-colors"
						>
							<td className="p-4 pl-6">
								<div className="flex items-center gap-4">
									<div className="w-12 h-8 rounded bg-black/30 border border-white/10 overflow-hidden shrink-0">
										{s.screenshotUrl ? (
											<img
												src={s.screenshotUrl}
												alt={s.projectName}
												className="w-full h-full object-cover"
											/>
										) : (
											<div className="w-full h-full flex items-center justify-center text-white/20">
												<PhIcon className="ph-fill ph-image" />
											</div>
										)}
									</div>
									<div>
										<div className="font-bold text-white group-hover:text-hc-blue transition-colors">
											{s.projectName}
										</div>
										<div className="text-xs text-text-muted max-w-xs truncate">
											{s.shortDescription}
										</div>
									</div>
								</div>
							</td>
							<td className="p-4">
								<span
									className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${statusPill(s.status)}`}
								>
									<span className="w-1.5 h-1.5 rounded-full bg-current" />
									{s.status}
								</span>
							</td>
							<td className="p-4 font-mono text-sm text-white/80">
								<div className="flex flex-col items-start gap-1">
									<span>{s.hoursSpent || 0}h</span>
									<div className="flex flex-wrap gap-1">
										{(s.tierBonusPercent || 0) > 0 ? (
											<div className="inline-flex items-center gap-1 text-[10px] text-hc-green border border-hc-green/30 bg-hc-green/10 px-1.5 py-0.5 rounded">
												+{s.tierBonusPercent}%
											</div>
										) : null}
										{(s.adminBonusPercent || 0) > 0 ? (
											<div className="inline-flex items-center gap-1 text-[10px] text-yellow-500 border border-yellow-500/30 bg-yellow-500/10 px-1.5 py-0.5 rounded">
												+{s.adminBonusPercent}%
											</div>
										) : null}
									</div>
								</div>
							</td>
							<td className="p-4 text-sm text-text-muted">
								{formatDate(s.createdAt)}
							</td>
							<td className="p-4 pr-6 text-right">
								<div className="flex justify-end gap-3 text-white/40">
									{s.repoUrl ? (
										<a
											href={s.repoUrl}
											target="_blank"
											rel="noreferrer"
											className="hover:text-white transition-colors"
										>
											<PhIcon className="ph-fill ph-github-logo text-xl" />
										</a>
									) : null}
									{s.demoUrl ? (
										<a
											href={s.demoUrl}
											target="_blank"
											rel="noreferrer"
											className="hover:text-white transition-colors"
										>
											<PhIcon className="ph-bold ph-arrow-square-out text-xl" />
										</a>
									) : null}
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function GalleryTab({ projects }: { projects: GalleryProject[] }) {
	if (!projects.length) {
		return (
			<div className="text-center py-20 bg-hc-dark border border-white/10 rounded-xl border-dashed">
				<div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
					<PhIcon className="ph ph-images text-3xl text-white/40" />
				</div>
				<h3 className="text-xl font-bold text-white mb-2">Gallery is Empty</h3>
				<p className="text-text-muted max-w-sm mx-auto">
					No approved projects yet.
				</p>
			</div>
		);
	}

	return (
		<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
			{projects.map((item) => (
				<div
					key={`${item.projectName}:${item.demoUrl}`}
					className="bg-hc-dark border border-white/10 rounded-xl overflow-hidden flex flex-col h-full hover:border-white/20 transition-colors"
				>
					<a
						href={item.demoUrl}
						target="_blank"
						rel="noreferrer"
						className="block aspect-video bg-black/20 relative group overflow-hidden border-b border-white/5"
					>
						{item.screenshotUrl ? (
							<img
								src={item.screenshotUrl}
								alt={item.projectName}
								className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
								loading="lazy"
							/>
						) : (
							<div className="w-full h-full flex items-center justify-center text-white/10">
								<PhIcon className="ph ph-image text-4xl" />
							</div>
						)}
						<div className="absolute top-3 right-3 bg-black/80 backdrop-blur-sm border border-white/10 rounded px-2 py-1 text-xs font-mono text-white flex items-center gap-1.5 shadow-sm">
							<PhIcon className="ph-fill ph-check-circle text-hc-green" />
							{item.hoursSpent || 0}h
						</div>
					</a>

					<div className="p-5 flex flex-col flex-1">
						<div className="flex justify-between items-start gap-4 mb-2">
							<a
								href={item.demoUrl}
								target="_blank"
								rel="noreferrer"
								className="text-lg font-bold text-white hover:text-hc-blue transition-colors line-clamp-1"
							>
								{item.projectName}
							</a>
							{item.repoUrl ? (
								<a
									href={item.repoUrl}
									target="_blank"
									rel="noreferrer"
									className="text-white/40 hover:text-white transition-colors shrink-0"
									title="View Code"
								>
									<PhIcon className="ph-fill ph-github-logo text-xl" />
								</a>
							) : null}
						</div>

						<p className="text-text-muted text-sm line-clamp-2 leading-relaxed mb-4 flex-1">
							{item.shortDescription}
						</p>

						<div className="flex items-center gap-2 text-xs text-white/30 font-mono border-t border-white/5 pt-3 mt-auto">
							<PhIcon className="ph ph-calendar-blank" />
							<span>Shipped {formatDate(item.reviewedAt)}</span>
						</div>
					</div>
				</div>
			))}
		</div>
	);
}
