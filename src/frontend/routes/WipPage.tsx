import { AppShell } from "../components/AppShell";
import type { AppBootstrap } from "../shared/types/app";

export function WipPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		error?: string;
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={null}
			hideNavLinks
			mainClass="flex-1 flex items-center justify-center p-6"
			config={bootstrap.config}
		>
			<div className="max-w-md w-full bg-black/30 rounded-2xl border border-white/10 p-6 text-center">
				<h1 className="text-2xl font-bold text-white mb-3">
					You shall not pass
				</h1>

				<p className="text-text-muted mb-6">
					Ask Deployor for a key. Silo is WIP.
				</p>

				{p.error ? (
					<div className="bg-red-500/10 border border-red-500/20 p-3 rounded-lg mb-4 text-left">
						<p className="text-red-400 text-sm font-bold">{p.error}</p>
					</div>
				) : null}

				<form action="/auth/wip" method="POST" className="space-y-4">
					<div>
						<label htmlFor="wip-code" className="sr-only">
							Access code
						</label>
						<input
							id="wip-code"
							type="password"
							name="code"
							placeholder="Enter access code"
							className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-text-muted"
							required
						/>
					</div>
					<button
						type="submit"
						className="w-full bg-hc-red hover:bg-hc-red/90 text-white font-bold py-3 px-4 rounded-lg transition-colors"
					>
						Frfr we coolio?
					</button>
				</form>
			</div>
		</AppShell>
	);
}
