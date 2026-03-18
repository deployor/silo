import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";

export function LockedPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		reason?: string;
		hideNavLinks?: boolean;
		mainClass?: string;
		user?: FrontendUser | null;
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			hideNavLinks={p.hideNavLinks}
			mainClass={p.mainClass}
			config={bootstrap.config}
		>
			<div className="flex-1 flex items-center justify-center p-6">
				<div className="max-w-md w-full bg-black/30 rounded-2xl border border-white/10 p-6 text-center">
					<div className="w-16 h-16 bg-hc-red/20 rounded-full flex items-center justify-center mx-auto mb-4">
						<PhIcon className="ph ph-lock-key text-3xl text-hc-red" />
					</div>

					<h1 className="text-2xl font-bold text-white mb-2">
						Your account is locked
					</h1>
					<p className="text-text-muted mb-4">
						Your account has been locked temporarily.
					</p>

					{p.reason ? (
						<div className="bg-white/5 border border-white/10 p-3 rounded-lg mb-4 text-left">
							<p className="text-text-muted text-xs font-mono mb-1">Reason</p>
							<p className="text-white text-sm font-bold">{p.reason}</p>
						</div>
					) : null}

					<p className="text-text-muted text-sm">
						All access (API + dashboard) is suspended for now. If you need
						support, ask in Slack.
					</p>
				</div>
			</div>
		</AppShell>
	);
}
