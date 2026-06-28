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
						Free S3 storage for teens.
						<br />
						<span className="text-white font-normal">
							Get buckets for free and use them from other programs.
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

					<div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-4 text-left max-w-4xl mx-auto">
						<div className="silo-stat-card p-5">
							<h3 className="font-mono text-hc-red mb-2">01 / COMPATIBLE</h3>
							<p className="text-sm text-text-muted">
								Full S3 API compatibility. Use the AWS SDK, Rclone, or any
								S3-compatible thing.
							</p>
						</div>
						<div className="silo-stat-card p-5">
							<h3 className="font-mono text-hc-red mb-2">02 / FAST</h3>
							<p className="text-sm text-text-muted">Built on Cloudflare R2.</p>
						</div>
						<div className="silo-stat-card p-5">
							<h3 className="font-mono text-hc-red mb-2">03 / FREE</h3>
							<p className="text-sm text-text-muted">
								Start with free object storage and keep your projects portable.
							</p>
						</div>
					</div>
				</div>
			</div>
		</AppShell>
	);
}
