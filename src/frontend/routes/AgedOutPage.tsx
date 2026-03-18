import type { AppBootstrap, FrontendUser } from "../shared/types/app";

export function AgedOutPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as { user?: FrontendUser | null };

	return (
		<div className="bg-hc-dark text-text-main min-h-screen flex flex-col items-center justify-center p-6">
			<div className="max-w-xl w-full text-center">
				<div className="mb-12">
					<h1 className="text-5xl font-bold text-white mb-6 tracking-tight">
						Account Closed
					</h1>
					<p className="text-xl text-text-muted leading-relaxed">
						Your Silo account has been permanently closed because you've aged
						out.
					</p>
				</div>

				{p.user?.dataExported ? (
					<div className="bg-white/5 border border-white/10 rounded-3xl p-8 mb-8">
						<h3 className="text-white font-bold text-xl mb-2">
							You're all set
						</h3>
						<p className="text-text-muted text-lg">
							You downloaded your data before the deadline. <br />
							We've deleted your files from our servers to save space.
						</p>
					</div>
				) : (
					<div className="bg-white/5 border border-white/10 rounded-3xl p-8 mb-8">
						<h3 className="text-white font-bold text-xl mb-2">Data Deleted</h3>
						<p className="text-text-muted text-lg">
							You didn't download your data before the deadline, so we've had to
							delete it to make room for new hackers.
						</p>
					</div>
				)}

				<p className="text-text-muted mb-8 text-sm">
					Thanks for building with Silo during your time at Hack Club!
				</p>
				<a
					href="https://hackclub.com"
					className="text-white font-bold hover:text-text-muted transition-colors"
				>
					Return to Hack Club <i className="ph ph-arrow-right" />
				</a>

				<div className="mt-12 pt-8 border-t border-white/10 text-xs text-text-muted font-mono opacity-40">
					User ID: {p.user?.id}
				</div>
			</div>
		</div>
	);
}
