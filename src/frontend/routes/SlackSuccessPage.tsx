import { AppShell } from "../components/AppShell";
import type { AppBootstrap } from "../shared/types/app";

export function SlackSuccessPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		defaultStorageLimitHuman?: string;
		pendingGrantTotalHuman?: string | null;
		pendingGrants?: Array<{
			id?: string;
			amountHuman: string;
			programName: string;
		}>;
	};
	const pendingGrants = p.pendingGrants || [];

	return (
		<AppShell
			title={bootstrap.title}
			user={null}
			hideNavLinks
			mainClass="flex-1 flex flex-col items-center justify-center p-6 w-full max-w-4xl mx-auto"
			config={bootstrap.config}
		>
			<div className="text-center">
				<h1 className="text-6xl md:text-9xl font-black text-white mb-8 tracking-tighter italic">
					You're all set!
				</h1>

				<p className="text-text-muted text-2xl max-w-3xl mx-auto font-medium mb-12 leading-relaxed">
					Your account is linked and your default storage quota is{" "}
					<span className="text-white font-bold">
						{p.defaultStorageLimitHuman || "configured"}
					</span>
					.
					<br />
					<br />
					You can now head back to Slack for bucket management, or open your
					dashboard to manage buckets on the web.
				</p>

				{pendingGrants.length ? (
					<div className="mb-12 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-5 text-left">
						<p className="text-sm font-bold uppercase tracking-wider text-emerald-300">
							Storage credited
						</p>
						<p className="mt-2 text-lg font-bold text-white">
							{p.pendingGrantTotalHuman} added to your Silo account.
						</p>
						<div className="mt-4 divide-y divide-white/10">
							{pendingGrants.map((grant) => (
								<div
									key={grant.id || `${grant.programName}-${grant.amountHuman}`}
									className="flex items-center justify-between gap-4 py-3 text-sm"
								>
									<span className="text-text-muted">{grant.programName}</span>
									<span className="font-mono font-bold text-white">
										{grant.amountHuman}
									</span>
								</div>
							))}
						</div>
					</div>
				) : null}

				<div className="flex items-center justify-center gap-6 text-sm font-bold uppercase tracking-wider">
					<a
						href="/"
						className="text-text-muted hover:text-white transition-colors border-b border-transparent hover:border-white pb-0.5"
					>
						Go to Dashboard
					</a>
				</div>
			</div>
		</AppShell>
	);
}
