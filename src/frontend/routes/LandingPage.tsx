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
			<div className="silo-hero flex flex-col items-center font-sans w-full min-h-[80vh] justify-center">
				<div className="w-full max-w-5xl mx-auto text-center px-4 sm:px-6">
					<p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-[11px] uppercase tracking-[0.16em] text-text-muted mb-6">
						<span className="h-1.5 w-1.5 rounded-full bg-hc-red" />
						S3-compatible storage for Hack Club
					</p>
					<h1 className="text-6xl sm:text-7xl md:text-9xl font-bold mb-3 italic tracking-tighter text-white select-none leading-[0.95]">
						SILO
					</h1>
					<h2 className="sr-only">
						Free S3 Compatible Object Storage for YSWS
					</h2>
					<p className="text-xl md:text-3xl text-text-muted mb-10 max-w-3xl mx-auto font-light leading-tight md:leading-tight">
						The YSWS object storage thing.
						<br />
						<span className="text-white font-normal">
							Build projects. Get free S3 buckets.
						</span>
					</p>

					<div className="flex flex-wrap gap-3 justify-center items-center">
						<a
							href="/auth/login"
							className="silo-cta text-white bg-hc-red/85 hover:bg-hc-red border-hc-red/70 shadow-[0_8px_28px_rgba(236,55,80,0.3)]"
						>
							Start Shipping
						</a>
						<a
							href="/gallery"
							className="silo-cta text-white/90 border-white/20 bg-white/5 hover:bg-white/10 hover:text-white"
						>
							Gallery
						</a>
						<a
							href="/docs"
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
								Start with free object storage. Ship projects to unlock more
								quota.
							</p>
						</div>
					</div>

					{p.yswsQuotaPerHour ? (
						<div className="mt-16 border-t border-white/10 pt-12 max-w-3xl mx-auto">
							<h3 className="text-text-muted text-sm font-bold uppercase tracking-wider mb-6 text-center">
								Reward Calculator
							</h3>
							<div className="bg-hc-dark/80 rounded-3xl p-6 md:p-8 border border-white/10 card-shadow backdrop-blur-sm">
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
											className="silo-range w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer"
										/>
										<div className="flex justify-between mt-2 text-xs text-text-muted font-mono">
											<span>1h</span>
											<span>100h</span>
										</div>
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
										<p className="text-xs text-text-muted mt-2">
											Permanent storage added to your account
										</p>
										{tier > 0 ? (
											<p className="text-xs text-red-300 font-bold mt-2">
												+{tier}% Bonus Applied!
											</p>
										) : null}
									</div>
								</div>
							</div>
							<p className="mt-8 text-base md:text-lg text-text-muted max-w-xl mx-auto">
								Ship your project to earn storage quota.
							</p>
						</div>
					) : null}
				</div>
			</div>
		</AppShell>
	);
}
