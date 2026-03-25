import { useEffect, useMemo, useState } from "react";
import { MdDeleteForever, MdDevices, MdLogout, MdSecurity } from "react-icons/md";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/ui/Modal";
import { fetchJson } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";

type SessionItem = {
	id: string;
	createdAt: string;
	expiresAt: string;
	isCurrent: boolean;
	userAgent: string;
	ipAddress: string | null;
	lastActiveLabel: string;
};

type DeleteState = {
	open: boolean;
	busy: boolean;
	stage: string;
	error: string | null;
	confirmText: string;
};

export function AccountPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as { user?: FrontendUser | null };
	const [sessions, setSessions] = useState<SessionItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<null | "everywhere" | string>(null);
	const [deleteState, setDeleteState] = useState<DeleteState>({
		open: false,
		busy: false,
		stage: "",
		error: null,
		confirmText: "",
	});

	const currentSession = useMemo(
		() => sessions.find((session) => session.isCurrent) || null,
		[sessions],
	);

	const loadSessions = async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await fetchJson<{ sessions: SessionItem[] }>(
				"/api/dashboard/account/sessions",
			);
			setSessions(result.sessions || []);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to load sessions");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void loadSessions();
	}, []);

	const signOutSession = async (sessionId: string) => {
		setBusy(sessionId);
		setError(null);
		try {
			const result = await fetchJson<{ signedOutCurrent: boolean }>(
				"/api/dashboard/account/sessions",
				{
					method: "DELETE",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId }),
				},
			);
			if (result.signedOutCurrent) {
				window.location.href = "/auth/logout";
				return;
			}
			await loadSessions();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to sign out session");
		} finally {
			setBusy(null);
		}
	};

	const signOutEverywhere = async () => {
		setBusy("everywhere");
		setError(null);
		try {
			await fetchJson("/api/dashboard/account/sign-out-everywhere", {
				method: "POST",
			});
			window.location.href = "/auth/logout";
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to sign out everywhere");
			setBusy(null);
		}
	};

	const deleteAccount = async () => {
		if (deleteState.confirmText.trim().toUpperCase() !== "DELETE") {
			setDeleteState((prev) => ({
				...prev,
				error: "Type DELETE to confirm account removal",
			}));
			return;
		}
		setDeleteState((prev) => ({
			...prev,
			busy: true,
			stage: "Deleting buckets and account data...",
			error: null,
		}));
		try {
			await fetchJson("/api/dashboard/account/delete", { method: "POST" });
			setDeleteState((prev) => ({
				...prev,
				stage: "Finalizing account removal...",
			}));
			window.location.href = "/account/deleted";
		} catch (cause) {
			setDeleteState((prev) => ({
				...prev,
				busy: false,
				error:
					cause instanceof Error ? cause.message : "Failed to delete account",
			}));
		}
	};

	return (
		<AppShell title={bootstrap.title} user={p.user || null} config={bootstrap.config}>
			<div className="mx-auto max-w-4xl space-y-6">
				<div className="rounded-[28px] border border-white/10 bg-hc-dark p-8 card-shadow">
					<div className="flex items-center gap-3">
						<MdSecurity className="text-2xl text-white" />
						<div>
							<h1 className="text-3xl font-black text-white">Account</h1>
							<p className="mt-1 text-sm text-text-muted">
								Manage sessions and delete your account.
							</p>
						</div>
					</div>
				</div>

				<div className="rounded-[28px] border border-white/10 bg-hc-dark p-8 card-shadow">
					<div className="flex items-center justify-between gap-4">
						<div className="flex items-center gap-3">
							<MdDevices className="text-2xl text-white" />
							<div>
								<h2 className="text-xl font-bold text-white">Active sessions</h2>
								<p className="mt-1 text-sm text-text-muted">
									See where you are signed in and sign out of everywhere.
								</p>
							</div>
						</div>
						<button
							type="button"
							onClick={() => void signOutEverywhere()}
							disabled={busy === "everywhere"}
							className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-white/10 disabled:opacity-50"
						>
							<MdLogout className="text-base" />
							{busy === "everywhere" ? "Signing out..." : "Sign out everywhere"}
						</button>
					</div>

					{error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}

					<div className="mt-5 space-y-3">
						{loading ? (
							<p className="text-sm text-text-muted">Loading sessions...</p>
						) : sessions.length === 0 ? (
							<p className="text-sm text-text-muted">No active sessions found.</p>
						) : (
							sessions.map((session) => (
								<div
									key={session.id}
									className="rounded-2xl border border-white/10 bg-black/20 p-4"
								>
									<div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
										<div className="min-w-0">
											<div className="flex flex-wrap items-center gap-2">
												<p className="text-sm font-bold text-white">
													{session.isCurrent ? "Current session" : "Session"}
												</p>
												{session.isCurrent ? (
													<span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-emerald-300">
														Current
													</span>
												) : null}
											</div>
											<p className="mt-2 break-all text-xs text-text-muted">
												{session.userAgent}
											</p>
											<div className="mt-3 flex flex-wrap gap-4 text-xs text-text-muted">
												<span>Signed in {new Date(session.createdAt).toLocaleString()}</span>
												<span>Expires {new Date(session.expiresAt).toLocaleString()}</span>
												<span>{session.ipAddress || "Unknown IP"}</span>
											</div>
										</div>
										<button
											type="button"
											onClick={() => void signOutSession(session.id)}
											disabled={busy === session.id}
											className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-white/10 disabled:opacity-50"
										>
											<MdLogout className="text-base" />
											{busy === session.id ? "Signing out..." : "Sign out"}
										</button>
									</div>
								</div>
							))
						)}
					</div>
				</div>

				<div className="rounded-[28px] border border-white/10 bg-hc-dark p-8 card-shadow">
					<div className="flex items-center justify-between gap-4">
						<div className="flex items-center gap-3">
							<MdDeleteForever className="text-2xl text-hc-red" />
							<div>
								<h2 className="text-xl font-bold text-white">Delete account</h2>
								<p className="mt-1 text-sm text-text-muted">
									Delete your account, buckets, sessions, and stored data.
								</p>
							</div>
						</div>
						<button
							type="button"
							onClick={() =>
								setDeleteState({
									open: true,
									busy: false,
									stage: "",
									error: null,
									confirmText: "",
								})
							}
							className="inline-flex items-center gap-2 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-300 transition-colors hover:bg-red-500/20"
						>
							<MdDeleteForever className="text-base" />
							Delete account
						</button>
					</div>
				</div>

				<Modal
					open={deleteState.open}
					onClose={deleteState.busy ? undefined : () =>
						setDeleteState((prev) => ({ ...prev, open: false }))
					}
					title="Delete account"
					className="max-w-xl p-8"
				>
					<div className="space-y-5">
						<p className="text-sm text-text-muted">
							This permanently deletes your account, all sessions, all buckets, and all stored files.
						</p>
						<input
							type="text"
							value={deleteState.confirmText}
							onChange={(event) =>
								setDeleteState((prev) => ({
									...prev,
									confirmText: event.target.value,
									error: null,
								}))
							}
							placeholder="Type DELETE to confirm"
							className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white focus:outline-none focus:border-red-400"
						/>
						{deleteState.stage ? (
							<div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white">
								{deleteState.stage}
							</div>
						) : null}
						{deleteState.error ? (
							<p className="text-sm text-red-400">{deleteState.error}</p>
						) : null}
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() =>
									setDeleteState((prev) => ({ ...prev, open: false }))
								}
								disabled={deleteState.busy}
								className="px-4 py-2 text-sm font-bold text-text-muted transition-colors hover:text-white disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => void deleteAccount()}
								disabled={deleteState.busy}
								className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-3 text-sm font-bold text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
							>
								<MdDeleteForever className="text-base" />
								{deleteState.busy ? "Deleting..." : "Delete account"}
							</button>
						</div>
					</div>
				</Modal>
			</div>
		</AppShell>
	);
}
