import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { FiMail } from "react-icons/fi";
import { fetchJson } from "../shared/api/http";
import type { FrontendConfig, FrontendUser } from "../shared/types/app";
import { timeAgo } from "../shared/utils/format";
import { Modal } from "./ui/Modal";

type CollaborationInvite = {
	id: string;
	bucketName: string;
	permissions: string[];
	invitedAt: string;
	inviter: {
		id: string;
		email?: string;
		avatarUrl?: string | null;
	};
};

function stripTags(value: string): string {
	return value.replace(/<[^>]*>/g, "").trim();
}

type Props = {
	title?: string;
	pageTitle?: string;
	user?: FrontendUser | null;
	hideNavLinks?: boolean;
	mainClass?: string;
	breadcrumbs?: string;
	config?: FrontendConfig;
	children: React.ReactNode;
};

export function AppShell({
	title,
	pageTitle,
	user,
	hideNavLinks,
	mainClass,
	breadcrumbs,
	config,
	children,
}: Props) {
	const isImpersonating = useMemo(() => {
		try {
			return document.cookie.includes("silo_impersonating=true");
		} catch {
			return false;
		}
	}, []);
	const [inviteOpen, setInviteOpen] = useState(false);
	const [inviteCount, setInviteCount] = useState(
		user?.pendingCollaborationInvites || 0,
	);
	const [inviteLoading, setInviteLoading] = useState(false);
	const [inviteBusyId, setInviteBusyId] = useState<string | null>(null);
	const [inviteError, setInviteError] = useState<string | null>(null);
	const [invites, setInvites] = useState<CollaborationInvite[]>([]);

	useEffect(() => {
		setInviteCount(user?.pendingCollaborationInvites || 0);
	}, [user?.pendingCollaborationInvites]);

	const loadInvites = async () => {
		if (!user) return;
		setInviteLoading(true);
		setInviteError(null);
		try {
			const data = await fetchJson<{
				count: number;
				invites: CollaborationInvite[];
			}>("/api/dashboard/collaboration/invites");
			setInviteCount(data.count || 0);
			setInvites(data.invites || []);
		} catch (error) {
			setInviteError(
				error instanceof Error ? error.message : "Failed to load invites",
			);
		} finally {
			setInviteLoading(false);
		}
	};

	const respondToInvite = async (
		inviteId: string,
		action: "accept" | "decline",
	) => {
		setInviteBusyId(inviteId);
		setInviteError(null);
		try {
			await fetchJson(`/api/dashboard/collaboration/invites/${inviteId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action }),
			});
			await loadInvites();
		} catch (error) {
			setInviteError(
				error instanceof Error ? error.message : "Failed to update invite",
			);
		} finally {
			setInviteBusyId(null);
		}
	};

	return (
		<div className="min-h-screen selection:bg-hc-red selection:text-white flex flex-col font-sans">
			<nav className="w-full bg-hc-darker border-b border-white/10 px-6 py-4 sticky top-0 z-50 flex justify-between items-center">
				<div className="flex items-center gap-4 min-w-0">
					<a
						href="/"
						className="font-bold text-2xl tracking-tighter italic text-white hover:text-hc-red transition-colors"
					>
						SILO
					</a>
					{pageTitle ? (
						<span className="bg-hc-red/20 text-hc-red px-2 py-0.5 rounded text-sm font-mono border border-hc-red/30">
							{pageTitle}
						</span>
					) : null}
					{breadcrumbs ? (
						<span className="text-sm text-text-muted">
							{stripTags(breadcrumbs)}
						</span>
					) : null}
					{config?.git?.shortSha ? (
						<div className="hidden md:flex flex-col justify-center text-[10px] leading-none text-white/20 font-mono ml-4 cursor-default select-none gap-[1px]">
							<div className="flex items-center gap-[3px] whitespace-nowrap">
								<span className="uppercase tracking-wider font-bold">
									{config.env}
								</span>
								<span className="opacity-30 text-[8px]">|</span>
								<span title={config.git.sha}>{config.git.shortSha}</span>
								{config.git.message ? (
									<>
										<span className="opacity-30 text-[8px]">|</span>
										<span
											className="max-w-[150px] truncate"
											title={config.git.message}
										>
											{config.git.message}
										</span>
									</>
								) : null}
							</div>
							<div className="flex items-center gap-[3px] whitespace-nowrap opacity-70">
								{config.git.date ? (
									<span>{timeAgo(config.git.date)}</span>
								) : null}
								{config.git.date && config.git.buildDate ? (
									<>
										<span className="opacity-30 text-[8px]">|</span>
										<span>
											took{" "}
											{Math.max(
												0,
												Math.floor(
													(new Date(config.git.buildDate).getTime() -
														new Date(config.git.date).getTime()) /
														1000,
												),
											)}
											s
										</span>
									</>
								) : null}
							</div>
						</div>
					) : null}
				</div>
				<div className="flex items-center gap-6 font-bold text-sm">
					{!hideNavLinks ? (
						user ? (
							<>
								{inviteCount > 0 ? (
									<button
										type="button"
										onClick={() => {
											setInviteOpen(true);
											void loadInvites();
										}}
										className="relative text-text-muted hover:text-white transition-colors"
										aria-label="Open collaboration invites"
									>
										<span className="inline-flex items-center justify-center h-9 w-9 rounded-xl border border-white/10 bg-white/5">
											<FiMail className="text-base" />
										</span>
										<span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-yellow-400 text-black text-[10px] font-black flex items-center justify-center">
											{inviteCount}
										</span>
									</button>
								) : null}
								<a
									href="/ysws"
									className="text-white hover:text-hc-green transition-colors font-bold border border-white/20 rounded px-3 py-1 bg-white/5 hover:bg-white/10"
								>
									YSWS
								</a>
								<a
									href="/docs"
									className="text-text-muted hover:text-white transition-colors"
								>
									Docs
								</a>
								<div className="flex items-center gap-2 min-w-0">
									{user.avatarUrl ? (
										<img
											src={user.avatarUrl}
											alt="User Avatar"
											className="w-6 h-6 rounded-full"
										/>
									) : null}
									<div className="flex items-center gap-2">
										<span className="text-text-muted font-mono truncate max-w-[14rem]">
											{user.id}
										</span>
										{user.isImmortal ? (
											<i
												className="ph ph-crown text-amber-400 text-lg"
												title="You are immortal. Your account won't be deleted, and your storage and bandwidth are unlimited."
											/>
										) : null}
									</div>
								</div>
								{user.isAdmin ? (
									<a
										href="/admin/users"
										className="text-text-muted hover:text-white transition-colors"
									>
										Admin
									</a>
								) : user.isReviewer ? (
									<a
										href="/admin/ysws"
										className="text-text-muted hover:text-white transition-colors"
									>
										Admin
									</a>
								) : null}
								<a
									href="/auth/logout"
									className="text-hc-red hover:text-white transition-colors"
								>
									{isImpersonating ? "Stop impersonating" : "Logout"}
								</a>
							</>
						) : (
							<a
								href="/auth/login"
								className="text-hc-red hover:text-white transition-colors"
							>
								Login
							</a>
						)
					) : null}
				</div>
			</nav>
			<main className={`max-w-7xl mx-auto w-full px-6 py-8 ${mainClass || ""}`}>
				{title ? <h1 className="sr-only">{title}</h1> : null}
				{children}
			</main>
			<Modal
				open={inviteOpen}
				onClose={() => setInviteOpen(false)}
				title="Collaboration Invites"
				className="max-w-2xl p-8"
			>
				<div className="space-y-4">
					<p className="text-sm text-text-muted">
						Accept or decline pending bucket collaboration invites.
					</p>
					{inviteError ? (
						<p className="text-sm text-red-400">{inviteError}</p>
					) : null}
					<div className="space-y-3 max-h-[60vh] overflow-auto">
						{inviteLoading ? (
							<p className="text-text-muted text-sm">Loading invites…</p>
						) : invites.length === 0 ? (
							<p className="text-text-muted text-sm">No pending invites.</p>
						) : (
							invites.map((invite) => (
								<div
									key={invite.id}
									className="rounded-2xl border border-white/10 bg-black/20 p-4"
								>
									<div className="flex items-start justify-between gap-4">
										<div className="min-w-0">
											<p className="text-white font-bold font-mono break-all">
												{invite.bucketName}
											</p>
											<div className="mt-2 flex items-center gap-2 text-xs text-text-muted">
												{invite.inviter.avatarUrl ? (
													<img
														src={invite.inviter.avatarUrl}
														alt={invite.inviter.id}
														className="w-5 h-5 rounded-full"
													/>
												) : null}
												<span>Invited by {invite.inviter.id}</span>
											</div>
											<div className="mt-3 flex flex-wrap gap-2">
												{invite.permissions.map((permission) => (
													<span
														key={permission}
														className="rounded-full border border-yellow-400/30 bg-yellow-400/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-yellow-200"
													>
														{permission.replace(/_/g, " ")}
													</span>
												))}
											</div>
										</div>
										<div className="flex items-center gap-2 shrink-0">
											<button
												type="button"
												onClick={() =>
													void respondToInvite(invite.id, "decline")
												}
												disabled={inviteBusyId === invite.id}
												className="px-3 py-2 rounded-xl text-sm font-bold text-text-muted hover:text-white bg-white/5 hover:bg-white/10 disabled:opacity-50"
											>
												Decline
											</button>
											<button
												type="button"
												onClick={() =>
													void respondToInvite(invite.id, "accept")
												}
												disabled={inviteBusyId === invite.id}
												className="px-4 py-2 rounded-xl text-sm font-bold text-black bg-yellow-400 hover:bg-yellow-300 disabled:opacity-50"
											>
												{inviteBusyId === invite.id ? "Working..." : "Accept"}
											</button>
										</div>
									</div>
								</div>
							))
						)}
					</div>
				</div>
			</Modal>
		</div>
	);
}
