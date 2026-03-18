import { useState } from "react";
import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatDate } from "../shared/utils/format";

type Submission = {
	id: string;
	projectName: string;
	shortDescription?: string;
	repoUrl: string;
	demoUrl: string;
	screenshotUrl?: string;
	usedAi: boolean;
	aiPercent?: number;
	aiToolUsage?: string;
	aiUsageDescription?: string;
	userId: string;
	hackatimeProject?: string;
	hoursSpent: number;
	status: "pending" | "approved" | "rejected";
	createdAt?: string;
	reviewedBy?: string;
	reviewedAt?: string;
	tierBonusPercent?: number;
	adminBonusPercent?: number;
	adminNotesPublic?: string;
	adminNotesPrivate?: string;
};

export function AdminYswsReviewPage({
	bootstrap,
}: {
	bootstrap: AppBootstrap;
}) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		submission: Submission;
	};
	const submission = p.submission;
	const [imageError, setImageError] = useState(false);

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<div className="max-w-4xl mx-auto space-y-8">
				<AdminSubnav active="ysws" />

				<div className="flex items-center gap-4">
					<a
						href="/admin/ysws"
						className="text-text-muted hover:text-white transition-colors flex items-center gap-2"
					>
						<i className="ph ph-arrow-left" />
						Back to List
					</a>
					<div className="h-4 w-px bg-white/10" />
					<span className="text-text-muted font-mono text-sm">
						ID: {submission.id}
					</span>
				</div>

				<div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
					<div className="lg:col-span-2 space-y-8">
						<div className="bg-card-bg border border-white/10 rounded-xl p-8 space-y-6">
							<div>
								<h1 className="text-3xl font-bold tracking-tight mb-2">
									{submission.projectName}
								</h1>
								<p className="text-lg text-white/80">
									{submission.shortDescription}
								</p>
							</div>

							<div className="grid grid-cols-2 gap-4">
								<a
									href={submission.repoUrl}
									target="_blank"
									rel="noreferrer"
									className="flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg p-3 transition-colors text-sm font-medium"
								>
									View Code (Repo)
									<i className="ph ph-arrow-up-right opacity-50" />
								</a>
								<a
									href={submission.demoUrl}
									target="_blank"
									rel="noreferrer"
									className="flex items-center justify-center gap-2 bg-hc-red/10 hover:bg-hc-red/20 border border-hc-red/30 text-hc-red rounded-lg p-3 transition-colors text-sm font-medium"
								>
									View Live Demo
									<i className="ph ph-arrow-up-right opacity-50" />
								</a>
							</div>

							{submission.screenshotUrl ? (
								<div>
									<h3 className="text-sm font-bold text-text-muted uppercase tracking-wider mb-2">
										Screenshot
									</h3>
									<div className="relative w-full rounded-lg border border-white/10 overflow-hidden bg-black/20 min-h-[300px]">
										{!imageError ? (
											<img
												src={submission.screenshotUrl}
												alt="Project Screenshot"
												className="w-full h-full object-contain bg-black/50"
												onError={() => setImageError(true)}
											/>
										) : (
											<div className="absolute inset-0 flex items-center justify-center text-white/10 bg-black/50 backdrop-blur-md z-50 border border-white/5 rounded-lg">
												<div className="text-center p-4">
													<i className="ph ph-image-broken text-6xl mx-auto mb-2" />
													<p className="text-xs font-mono uppercase tracking-widest opacity-50">
														Error Loading Image
													</p>
												</div>
											</div>
										)}
									</div>
								</div>
							) : null}

							<div className="pt-6 border-t border-white/10">
								<h3 className="text-sm font-bold text-text-muted uppercase tracking-wider mb-4">
									AI Usage Declaration
								</h3>
								{submission.usedAi ? (
									<div className="bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 p-4 rounded-lg">
										<div className="flex items-center justify-between mb-2">
											<span className="font-bold">
												AI Used ({submission.aiPercent || 0}%)
											</span>
											<span className="text-xs opacity-70">
												{submission.aiToolUsage}
											</span>
										</div>
										<p className="text-sm opacity-90">
											{submission.aiUsageDescription}
										</p>
									</div>
								) : (
									<div className="bg-green-500/10 border border-green-500/20 text-green-400 p-4 rounded-lg flex items-center gap-2">
										<i className="ph ph-check text-lg" />
										<span>No AI used. 100% Human Made.</span>
									</div>
								)}
							</div>
						</div>
					</div>

					<div className="space-y-6">
						<div className="bg-card-bg border border-white/10 rounded-xl p-6 space-y-4">
							<h3 className="font-bold border-b border-white/10 pb-2">
								Submission Stats
							</h3>
							<div className="space-y-3 text-sm">
								<div className="flex justify-between">
									<span className="text-text-muted">User ID</span>
									<span className="font-mono text-white">
										{submission.userId}
									</span>
								</div>
								<div className="flex justify-between">
									<span className="text-text-muted">Hackatime Project</span>
									<span className="text-white">
										{submission.hackatimeProject || "-"}
									</span>
								</div>
								<div className="flex justify-between">
									<span className="text-text-muted">Hours Logged</span>
									<span className="font-bold text-white">
										{submission.hoursSpent}h
									</span>
								</div>
								<div className="flex justify-between">
									<span className="text-text-muted">Submitted</span>
									<span className="text-white">
										{formatDate(submission.createdAt)}
									</span>
								</div>
								<div className="flex justify-between">
									<span className="text-text-muted">Status</span>
									<span
										className={`uppercase font-bold ${
											submission.status === "pending"
												? "text-yellow-400"
												: submission.status === "approved"
													? "text-green-400"
													: "text-red-400"
										}`}
									>
										{submission.status}
									</span>
								</div>
							</div>
						</div>

						{submission.status === "pending" ? (
							<div className="bg-card-bg border border-white/10 rounded-xl p-6">
								<h3 className="font-bold mb-4">Review Action</h3>
								<form
									action={`/admin/ysws/${submission.id}`}
									method="POST"
									className="space-y-4"
								>
									<div>
										<label
											htmlFor="admin-notes-public"
											className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1"
										>
											Public Notes
										</label>
										<textarea
											id="admin-notes-public"
											name="adminNotesPublic"
											rows={2}
											className="w-full bg-black/20 border border-white/10 rounded px-3 py-2 text-sm text-white focus:border-hc-red focus:outline-none transition-colors"
											placeholder="Visible to the user..."
										/>
									</div>

									<div>
										<label
											htmlFor="admin-notes-private"
											className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1"
										>
											Private Notes
										</label>
										<textarea
											id="admin-notes-private"
											name="adminNotesPrivate"
											rows={2}
											className="w-full bg-black/20 border border-white/10 rounded px-3 py-2 text-sm text-white focus:border-hc-red focus:outline-none transition-colors"
											placeholder="Internal team notes..."
										/>
									</div>

									<div>
										<label
											htmlFor="admin-bonus"
											className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1"
										>
											Extra Bonus (%)
										</label>
										<p className="text-[10px] text-text-muted mb-2">
											Discretionary bonus up to 10%.
										</p>
										<input
											id="admin-bonus"
											type="number"
											name="adminBonusPercent"
											min={0}
											max={10}
											defaultValue={0}
											step={0.5}
											className="w-full bg-black/20 border border-white/10 rounded px-3 py-2 text-sm text-white focus:border-hc-red focus:outline-none transition-colors font-mono"
										/>
									</div>

									<div className="grid grid-cols-2 gap-3 pt-2">
										<button
											type="submit"
											name="action"
											value="reject"
											className="w-full bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/20 py-2 rounded text-sm font-bold transition-colors"
										>
											Reject
										</button>
										<button
											type="submit"
											name="action"
											value="approve"
											className="w-full bg-green-500/10 hover:bg-green-500/20 text-green-500 border border-green-500/20 py-2 rounded text-sm font-bold transition-colors"
										>
											Approve
										</button>
									</div>
								</form>
							</div>
						) : (
							<div className="bg-card-bg border border-white/10 rounded-xl p-6 space-y-4 opacity-75">
								<h3 className="font-bold border-b border-white/10 pb-2">
									Review Details
								</h3>
								<div className="space-y-2 text-sm">
									<div className="flex justify-between">
										<span className="text-text-muted">Reviewed By</span>
										<span className="font-mono text-white">
											{submission.reviewedBy}
										</span>
									</div>
									<div className="flex justify-between">
										<span className="text-text-muted">Date</span>
										<span className="text-white">
											{formatDate(submission.reviewedAt)}
										</span>
									</div>
									{(submission.tierBonusPercent || 0) > 0 ? (
										<div className="flex justify-between">
											<span className="text-text-muted">Tier Bonus</span>
											<span className="text-green-400 font-bold font-mono">
												+{submission.tierBonusPercent}%
											</span>
										</div>
									) : null}
									{(submission.adminBonusPercent || 0) > 0 ? (
										<div className="flex justify-between">
											<span className="text-text-muted">Admin Bonus</span>
											<span className="text-green-400 font-bold font-mono">
												+{submission.adminBonusPercent}%
											</span>
										</div>
									) : null}
									{submission.adminNotesPublic ? (
										<div className="pt-2">
											<span className="text-text-muted block text-xs mb-1">
												Public Notes
											</span>
											<p className="text-white/80 bg-black/20 p-2 rounded">
												{submission.adminNotesPublic}
											</p>
										</div>
									) : null}
									{submission.adminNotesPrivate ? (
										<div className="pt-2">
											<span className="text-text-muted block text-xs mb-1">
												Private Notes
											</span>
											<p className="text-white/80 bg-black/20 p-2 rounded">
												{submission.adminNotesPrivate}
											</p>
										</div>
									) : null}
								</div>
							</div>
						)}
					</div>
				</div>
			</div>
		</AppShell>
	);
}
