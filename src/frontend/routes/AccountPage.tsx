import { useCallback, useEffect, useState } from "react";
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
};

type DeleteState = {
	open: boolean;
	busy: boolean;
	stage: string;
	error: string | null;
	confirmText: string;
	confirmDelayRemaining: number;
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
		confirmDelayRemaining: 10,
	});

	useEffect(() => {
		if (!deleteState.open || deleteState.busy) return;
		setDeleteState((prev) => ({ ...prev, confirmDelayRemaining: 10 }));
		const timer = window.setInterval(() => {
			setDeleteState((prev) => {
				if (!prev.open || prev.busy) return prev;
				if (prev.confirmDelayRemaining <= 1) {
					window.clearInterval(timer);
					return { ...prev, confirmDelayRemaining: 0 };
				}
				return {
					...prev,
					confirmDelayRemaining: prev.confirmDelayRemaining - 1,
				};
			});
		}, 1000);
		return () => window.clearInterval(timer);
	}, [deleteState.open, deleteState.busy]);

	const loadSessions = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await fetchJson<{ sessions: SessionItem[] }>(
				"/api/dashboard/account/sessions",
			);
			setSessions(result.sessions || []);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Failed to load sessions",
			);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadSessions();
	}, [loadSessions]);

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
			setError(
				cause instanceof Error ? cause.message : "Failed to sign out session",
			);
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
			setError(
				cause instanceof Error
					? cause.message
					: "Failed to sign out everywhere",
			);
			setBusy(null);
		}
	};

	const deleteAccount = async () => {
		if (deleteState.confirmDelayRemaining > 0) return;
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
			stage: "Deleting buckets and account data…",
			error: null,
		}));
		try {
			await fetchJson("/api/dashboard/account/delete", { method: "POST" });
			setDeleteState((prev) => ({
				...prev,
				stage: "Finishing account deletion…",
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
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<div className="silo-account">
				<header className="silo-account-page-header">
					<h1>Account</h1>
				</header>

				<section className="silo-account-sessions">
					<header className="silo-account-section-header">
						<div className="flex items-baseline gap-3">
							<h2>Sessions</h2>
							{!loading && sessions.length > 0 ? (
								<span>{sessions.length} active</span>
							) : null}
						</div>
						<button
							type="button"
							onClick={() => void signOutEverywhere()}
							disabled={busy === "everywhere"}
							className="silo-account-action"
						>
							{busy === "everywhere" ? "Signing out…" : "Sign out all"}
						</button>
					</header>

					{error ? (
						<p className="silo-account-state is-error" role="alert">
							{error}
						</p>
					) : null}

					<div className="silo-session-list">
						{loading ? (
							<p className="silo-account-state" aria-live="polite">
								Loading sessions…
							</p>
						) : sessions.length === 0 ? (
							<p className="silo-account-state">No active sessions.</p>
						) : (
							sessions.map((session) => (
								<article key={session.id} className="silo-session-row">
									<div className="silo-session-identity">
										<div className="silo-session-title-line">
											<h3 title={session.userAgent}>{session.userAgent}</h3>
											{session.isCurrent ? <span>Current</span> : null}
										</div>
										<div className="silo-session-facts">
											<span>{session.ipAddress || "Unknown IP"}</span>
											<span>
												Signed in {new Date(session.createdAt).toLocaleString()}
											</span>
											<span>
												Expires {new Date(session.expiresAt).toLocaleString()}
											</span>
										</div>
									</div>
									<button
										type="button"
										onClick={() => void signOutSession(session.id)}
										disabled={busy === session.id}
										aria-label={
											session.isCurrent
												? "Sign out current session"
												: `Sign out session from ${session.ipAddress || "unknown IP"}, signed in ${new Date(session.createdAt).toLocaleString()}`
										}
										className="silo-account-action is-compact"
									>
										{busy === session.id ? "Signing out…" : "Sign out"}
									</button>
								</article>
							))
						)}
					</div>
				</section>

				<section className="silo-account-danger">
					<div>
						<h2>Delete account</h2>
						<p>
							Permanently deletes your buckets, files, sessions, and account.
						</p>
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
								confirmDelayRemaining: 10,
							})
						}
						className="silo-account-danger-action"
					>
						Delete account
					</button>
				</section>

				<Modal
					open={deleteState.open}
					onClose={
						deleteState.busy
							? undefined
							: () => setDeleteState((prev) => ({ ...prev, open: false }))
					}
					title="Delete account"
					className="max-w-lg p-8"
				>
					<div className="silo-account-delete-modal">
						<p className="silo-account-delete-warning">
							This permanently deletes every bucket, file, session, and account
							record. It cannot be undone.
						</p>
						<label className="silo-account-delete-field">
							<span>Type DELETE to confirm</span>
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
								disabled={deleteState.busy}
								placeholder="DELETE"
								autoComplete="off"
								spellCheck={false}
							/>
						</label>
						{deleteState.stage ? (
							<p className="silo-account-modal-state" role="status">
								{deleteState.stage}
							</p>
						) : null}
						{!deleteState.busy && deleteState.confirmDelayRemaining > 0 ? (
							<p className="silo-account-modal-state">
								Available in {deleteState.confirmDelayRemaining}s
							</p>
						) : null}
						{deleteState.error ? (
							<p className="silo-account-modal-error" role="alert">
								{deleteState.error}
							</p>
						) : null}
						<footer className="silo-account-modal-footer">
							<button
								type="button"
								onClick={() =>
									setDeleteState((prev) => ({ ...prev, open: false }))
								}
								disabled={deleteState.busy}
								className="silo-account-modal-cancel"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => void deleteAccount()}
								disabled={
									deleteState.busy || deleteState.confirmDelayRemaining > 0
								}
								className="silo-account-danger-action is-solid"
							>
								{deleteState.busy
									? "Deleting…"
									: deleteState.confirmDelayRemaining > 0
										? `Delete account (${deleteState.confirmDelayRemaining}s)`
										: "Delete account"}
							</button>
						</footer>
					</div>
				</Modal>
			</div>
		</AppShell>
	);
}
