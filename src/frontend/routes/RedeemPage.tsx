import { useEffect } from "react";
import { AppShell } from "../components/AppShell";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

export function RedeemPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		success?: boolean;
		credits?: number;
		programName?: string;
		code?: string;
		error?: string;
	};

	useEffect(() => {
		if (!p.success) return;
		try {
			// lightweight celebration without extra dependency
			document.body.animate(
				[
					{ filter: "brightness(1)" },
					{ filter: "brightness(1.08)" },
					{ filter: "brightness(1)" },
				],
				{ duration: 900, iterations: 2 },
			);
		} catch {}
	}, [p.success]);

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<div className="max-w-xl mx-auto py-12 px-4">
				<div className="bg-hc-dark border border-white/10 rounded-3xl p-8 card-shadow relative overflow-hidden">
					<div className="text-center mb-8 relative z-10">
						<h1 className="text-4xl font-bold italic tracking-tighter text-white mb-2">
							REDEEM CODE
						</h1>
						<p className="text-text-muted">
							Enter your code below to claim your rewards!
						</p>
					</div>

					{p.success ? (
						<>
							<div className="mb-8 p-6 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl text-emerald-400 text-center relative z-10">
								<h3 className="text-2xl font-bold mb-2">YAY! 🎉</h3>
								<p className="font-medium text-lg">Successfully redeemed!</p>
								<p className="text-sm mt-2 opacity-80 font-mono">
									{formatBytes(p.credits || 0)} have been added to your account
									from {p.programName}.
								</p>
							</div>
							<div className="text-center relative z-10">
								<a
									href="/"
									className="inline-block px-8 py-4 bg-hc-blue text-white font-bold rounded-xl hover:scale-105 transition-transform card-shadow"
								>
									Go to Dashboard
								</a>
							</div>
						</>
					) : (
						<form
							method="POST"
							action="/redeem"
							className="space-y-6 relative z-10"
						>
							<div>
								<label htmlFor="code" className="sr-only">
									Redemption Code
								</label>
								<input
									type="text"
									name="code"
									id="code"
									required
									defaultValue={p.code || ""}
									className="block w-full text-center py-4 px-4 bg-black/30 border border-white/10 rounded-xl text-white placeholder-white/20 focus:outline-none focus:border-hc-red focus:ring-1 focus:ring-hc-red text-2xl font-mono uppercase tracking-widest transition-colors"
									placeholder="CODE-HERE"
								/>
							</div>

							{p.error ? (
								<div className="p-3 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-sm text-center">
									{p.error}
								</div>
							) : null}

							<button
								type="submit"
								className="w-full flex justify-center py-4 px-4 rounded-xl text-lg font-bold text-white bg-hc-red hover:bg-red-600 transition-all transform hover:scale-[1.02] card-shadow"
							>
								Redeem Code
							</button>
						</form>
					)}

					<div className="mt-8 text-center">
						<p className="text-xs text-text-muted">
							Having trouble? Msg us on slack.
						</p>
					</div>
				</div>
			</div>
		</AppShell>
	);
}
