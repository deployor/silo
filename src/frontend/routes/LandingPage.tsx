import { useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import type { AppBootstrap } from "../shared/types/app";

type BonusTier = { hours: number; percent: number; enabled: boolean };

export function LandingPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		hideNavLinks?: boolean;
		mainClass?: string;
		yswsQuotaPerHour?: number;
		yswsBonusTiers?: BonusTier[];
	};

	const [hours, setHours] = useState(10);
	const tier = useMemo(() => {
		const tiers = (p.yswsBonusTiers || []).filter(
			(t) => t.enabled && hours >= t.hours,
		);
		tiers.sort((a, b) => b.hours - a.hours);
		return tiers[0]?.percent || 0;
	}, [hours, p.yswsBonusTiers]);

	const rewardGb = useMemo(() => {
		if (!p.yswsQuotaPerHour) return null;
		return (
			(hours * p.yswsQuotaPerHour * (1 + tier / 100)) /
			(1024 * 1024 * 1024)
		).toFixed(1);
	}, [hours, p.yswsQuotaPerHour, tier]);

	return (
		<AppShell
			title={bootstrap.title}
			user={null}
			hideNavLinks={p.hideNavLinks}
			mainClass={p.mainClass}
			config={bootstrap.config}
		>
			<div className="flex flex-col items-center font-sans w-full min-h-[80vh] justify-center">
				<div className="w-full max-w-4xl mx-auto text-center px-6">
					<h1 className="text-6xl md:text-9xl font-bold mb-2 italic tracking-tighter text-white select-none">
						SILO
					</h1>
					<p className="text-2xl md:text-3xl text-gray-400 mb-12 max-w-2xl mx-auto font-light">
						The YSWS object storage thing.
						<br />
						<span className="text-white font-normal">
							Build projects. Get free S3 buckets.
						</span>
					</p>

					<div className="flex flex-col sm:flex-row gap-6 justify-center items-center">
						<a
							href="/auth/login"
							className="text-xl font-bold text-white hover:text-hc-red transition-colors border-b-2 border-transparent hover:border-hc-red pb-1"
						>
							Start Shipping
						</a>
						<span className="text-gray-600 hidden sm:inline">•</span>
						<a
							href="/gallery"
							className="text-xl font-bold text-white hover:text-yellow-500 transition-colors border-b-2 border-transparent hover:border-yellow-500 pb-1"
						>
							Gallery
						</a>
						<span className="text-gray-600 hidden sm:inline">•</span>
						<a
							href="/docs"
							className="text-xl font-bold text-white hover:text-hc-blue transition-colors border-b-2 border-transparent hover:border-hc-blue pb-1"
						>
							Docs
						</a>
						<span className="text-gray-600 hidden sm:inline">•</span>
						<a
							href="https://github.com/hackclub/silo"
							target="_blank"
							rel="noreferrer"
							className="text-xl font-bold text-white hover:text-green-500 transition-colors border-b-2 border-transparent hover:border-green-500 pb-1"
						>
							GitHub
						</a>
					</div>

					<div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-8 text-left max-w-3xl mx-auto opacity-60 hover:opacity-100 transition-opacity duration-500">
						<div>
							<h3 className="font-mono text-hc-red mb-2">01 / COMPATIBLE</h3>
							<p className="text-sm text-gray-400">
								Full S3 API compatibility. Use the AWS SDK, Rclone, or any
								S3-compatible tool.
							</p>
						</div>
						<div>
							<h3 className="font-mono text-hc-blue mb-2">02 / FAST</h3>
							<p className="text-sm text-gray-400">
								Built on Cloudflare R2. Global CDN caching for low-latency asset
								delivery.
							</p>
						</div>
						<div>
							<h3 className="font-mono text-green-500 mb-2">03 / FREE</h3>
							<p className="text-sm text-gray-400">
								Start with free object storage. Ship your projects to unlock
								more quota.
							</p>
						</div>
					</div>

					{p.yswsQuotaPerHour ? (
						<div className="mt-20 border-t border-white/10 pt-16 max-w-3xl mx-auto">
							<h3 className="text-text-muted text-sm font-bold uppercase tracking-wider mb-6 text-center">
								Reward Calculator
							</h3>
							<div className="bg-hc-dark rounded-3xl p-8 border border-white/10 card-shadow">
								<div className="flex flex-col md:flex-row gap-8 items-center">
									<div className="flex-1 w-full">
										<div className="flex justify-between items-end mb-4">
											<label
												htmlFor="landing-hours"
												className="text-sm font-bold text-white"
											>
												Hours Spent Coding
											</label>
											<span className="text-2xl font-bold text-hc-red font-mono">
												{hours}h
											</span>
										</div>
										<input
											id="landing-hours"
											type="range"
											min={1}
											max={100}
											value={hours}
											onChange={(e) => setHours(Number(e.target.value))}
											className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-hc-red"
										/>
									</div>
									<div className="hidden md:block w-px h-24 bg-white/10" />
									<div className="flex-1 w-full text-center md:text-left">
										<p className="text-text-muted text-xs font-bold uppercase tracking-wider mb-2">
											You Earn
										</p>
										<div className="flex items-baseline justify-center md:justify-start gap-2">
											<span className="text-5xl font-bold text-white tracking-tighter">
												{rewardGb}
											</span>
											<span className="text-xl text-white/40 font-bold">
												GB
											</span>
										</div>
										{tier > 0 ? (
											<p className="text-xs text-hc-green font-bold mt-2">
												+{tier}% Bonus Applied!
											</p>
										) : null}
									</div>
								</div>
							</div>
						</div>
					) : null}
				</div>
			</div>
		</AppShell>
	);
}
