import type React from "react";
import { useState } from "react";
import { AppShell } from "../components/AppShell";
import type { AppBootstrap } from "../shared/types/app";

export function OnboardingPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		hideNavLinks?: boolean;
		mainClass?: string;
		yswsQuotaPerHourHuman?: string;
	};
	const [step, setStep] = useState(1);

	return (
		<AppShell
			title={bootstrap.title}
			user={null}
			hideNavLinks={p.hideNavLinks}
			mainClass={p.mainClass}
			config={bootstrap.config}
		>
			<div className="flex-1 flex flex-col items-center justify-center p-6 w-full max-w-4xl mx-auto">
				{step === 1 && (
					<Panel
						icon="ph-hand-waving text-hc-red"
						title="Welcome to Cargo!"
						content="Cargo is an S3 Gateway and the new Hack Club CDN."
						right={
							<button
								type="button"
								onClick={() => setStep(2)}
								className="group bg-hc-red text-white px-8 py-4 rounded-xl font-bold text-lg transition-all flex items-center gap-3 shadow-lg shadow-hc-red/20"
							>
								<span>Next: Your Storage</span>
								<i className="ph-bold ph-arrow-right group-hover:translate-x-1 transition-transform" />
							</button>
						}
					/>
				)}

				{step === 2 && (
					<Panel
						icon="ph-rocket-launch text-blue-500"
						title="Ship Projects."
						subtitle="Get Paid in Storage."
						content={`Every YSWS project you ship unlocks more permanent cloud storage. Earn ${p.yswsQuotaPerHourHuman || "quota"} for every hour.`}
						left={
							<button
								type="button"
								onClick={() => setStep(1)}
								className="text-text-muted hover:text-white px-6 py-3 font-bold text-lg"
							>
								Back
							</button>
						}
						right={
							<button
								type="button"
								onClick={() => setStep(3)}
								className="group bg-hc-red text-white px-8 py-4 rounded-xl font-bold text-lg flex items-center gap-3 shadow-lg shadow-hc-red/20"
							>
								Next: Privacy & Logs <i className="ph-bold ph-arrow-right" />
							</button>
						}
					/>
				)}

				{step === 3 && (
					<Panel
						icon="ph-shield-check text-yellow-500"
						title="We Log Requests"
						content="To keep Cargo safe and fast, we log request metadata (user agent, path, status, timing). We do NOT log file contents."
						left={
							<button
								type="button"
								onClick={() => setStep(2)}
								className="text-text-muted hover:text-white px-6 py-3 font-bold text-lg"
							>
								Back
							</button>
						}
						right={
							<button
								type="button"
								onClick={() => setStep(4)}
								className="group bg-hc-red text-white px-8 py-4 rounded-xl font-bold text-lg flex items-center gap-3 shadow-lg shadow-hc-red/20"
							>
								Next: How it Works <i className="ph-bold ph-arrow-right" />
							</button>
						}
					/>
				)}

				{step === 4 && (
					<Panel
						icon="ph-cloud-check text-green-500"
						title="It's Just S3"
						content="Use standard S3 tools and SDKs. Behind the scenes, Cargo handles routing, auth and quotas so your experience feels like a normal bucket workflow."
						left={
							<button
								type="button"
								onClick={() => setStep(3)}
								className="text-text-muted hover:text-white px-6 py-3 font-bold text-lg"
							>
								Back
							</button>
						}
						right={
							<form action="/api/onboarding/complete" method="POST">
								<button
									type="submit"
									className="group bg-hc-red text-white px-8 py-4 rounded-xl font-bold text-lg flex items-center gap-3 shadow-lg shadow-hc-red/20"
								>
									Get Started <i className="ph-bold ph-rocket-launch" />
								</button>
							</form>
						}
					/>
				)}
			</div>
		</AppShell>
	);
}

function Panel({
	icon,
	title,
	subtitle,
	content,
	left,
	right,
}: {
	icon: string;
	title: string;
	subtitle?: string;
	content: string;
	left?: React.ReactNode;
	right?: React.ReactNode;
}) {
	return (
		<div className="text-center max-w-3xl mx-auto w-full">
			<div className="mb-8 flex justify-center">
				<i className={`ph-duotone ${icon} text-8xl`} />
			</div>
			<h1 className="text-6xl md:text-8xl font-black text-white mb-4 tracking-tighter italic">
				{title}
			</h1>
			{subtitle ? (
				<p className="text-4xl md:text-6xl text-white/50 font-black tracking-tighter mb-6 italic">
					{subtitle}
				</p>
			) : null}
			<p className="text-text-muted text-2xl max-w-3xl mx-auto font-medium mb-12 leading-relaxed">
				{content}
			</p>
			<div className="flex items-center justify-between w-full max-w-md mx-auto">
				<div>{left}</div>
				<div>{right}</div>
			</div>
		</div>
	);
}
