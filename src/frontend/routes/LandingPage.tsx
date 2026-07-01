import { AppShell } from "../components/AppShell";
import type { AppBootstrap } from "../shared/types/app";

export function LandingPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		hideNavLinks?: boolean;
		mainClass?: string;
	};
	const dashboardHref = bootstrap.config?.dashboardUrl || "";

	return (
		<AppShell
			title={bootstrap.title}
			user={null}
			hideNavLinks={p.hideNavLinks}
			mainClass={p.mainClass}
			config={bootstrap.config}
		>
			<div className="silo-hero flex flex-col items-center font-sans w-full min-h-[80vh] justify-center">
				<div className="w-full max-w-5xl mx-auto text-center px-4 sm:px-6">
					<h1 className="text-6xl sm:text-7xl md:text-9xl font-bold mb-3 italic tracking-tighter text-white select-none leading-[0.95]">
						SILO
					</h1>
					<h2 className="sr-only">Free S3 Compatible Object Storage</h2>
					<p className="text-xl md:text-3xl text-text-muted mb-10 max-w-3xl mx-auto font-light leading-tight md:leading-tight">
						Free S3 storage for Hack Clubbers.
						<br />
						<span className="text-white font-normal">
							Every Hack Clubber gets 5GB for free.
						</span>
						<span className="mt-3 block text-sm md:text-base text-text-muted">
							Need more? Get more storage with no limit from programs.
						</span>
					</p>

					<div className="flex flex-wrap gap-3 justify-center items-center">
						<a
							href={`${dashboardHref}/auth/login`}
							className="silo-cta text-white bg-hc-red/85 hover:bg-hc-red border-hc-red/70"
						>
							Login
						</a>
						<a
							href={`${dashboardHref}/docs`}
							className="silo-cta text-white/90 border-white/20 bg-white/5 hover:bg-white/10 hover:text-white"
						>
							Docs
						</a>
						<a
							href="https://github.com/hackclub/silo"
							target="_blank"
							rel="noreferrer"
							className="silo-cta text-white/90 border-white/20 bg-white/5 hover:bg-white/10 hover:text-white"
						>
							GitHub
						</a>
					</div>
				</div>
			</div>
		</AppShell>
	);
}
