import { AppShell } from "../components/AppShell";
import type { AppBootstrap } from "../shared/types/app";

export function SlackSuccessPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		defaultStorageLimitHuman?: string;
	};

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
					You can now go back to Slack to upload files, or use the{" "}
					<a href="/cdn" className="text-hc-red hover:underline font-bold">
						Web CDN
					</a>
					.
				</p>

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
