import { AnimatePresence, motion } from "motion/react";
import type React from "react";
import { useState } from "react";
import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import type { AppBootstrap } from "../shared/types/app";

export function OnboardingPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		hideNavLinks?: boolean;
		mainClass?: string;
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
				<AnimatePresence mode="wait">
					<motion.div
						key={`onboarding-step-${step}`}
						initial={{ opacity: 0, y: 24, scale: 0.985 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: -20, scale: 0.985 }}
						transition={{ duration: 0.28, ease: "easeOut" }}
						className="w-full"
					>
						{step === 1 && (
						<Panel
							icon="ph-hand-waving text-hc-red"
							title="Welcome to Silo!"
							content="Silo is Hack Club's new S3 provider."
							right={
									<button
										type="button"
										onClick={() => setStep(2)}
										className="group bg-hc-red text-white px-8 py-4 rounded-xl font-bold text-lg transition-all flex items-center gap-3 shadow-lg shadow-hc-red/20"
									>
										<span>Next: Your Storage</span>
										<PhIcon className="ph-bold ph-arrow-right group-hover:translate-x-1 transition-transform" />
									</button>
								}
							/>
						)}

						{step === 2 && (
							<Panel
								icon="ph-rocket-launch text-red-500"
								title="Free Storage."
								content={
									<>
										Use Silo when your project needs S3-compatible storage
										without a credit card or cloud account.
										<br />
										<span className="text-white font-bold">
											Create buckets, generate keys, and start uploading.
										</span>
									</>
								}
								left={
									<button
										type="button"
										onClick={() => setStep(1)}
										className="text-text-muted hover:text-white px-6 py-3 font-bold text-lg transition-colors flex items-center gap-2 group"
									>
										<PhIcon className="ph-bold ph-arrow-left group-hover:-translate-x-1 transition-transform" />
										<span>Back</span>
									</button>
								}
								right={
									<button
										type="button"
										onClick={() => setStep(3)}
										className="group bg-hc-red text-white px-8 py-4 rounded-xl font-bold text-lg flex items-center gap-3 shadow-lg shadow-hc-red/20"
									>
										<span>Next: Privacy & Logs</span>
										<PhIcon className="ph-bold ph-arrow-right group-hover:translate-x-1 transition-transform" />
									</button>
								}
							/>
						)}

						{step === 3 && (
							<Panel
								icon="ph-shield-check text-yellow-500"
								title="We Log Requests"
								content={
									<>
										To keep Silo safe and fast, we log all requests (User
										Agent, Path etc).
										<br />
										<br />
										<span className="text-white font-bold">
											We do NOT log your file contents.
										</span>{" "}
										Your data remains yours. We only track metadata to prevent
										abuse.
									</>
								}
								left={
									<button
										type="button"
										onClick={() => setStep(2)}
										className="text-text-muted hover:text-white px-6 py-3 font-bold text-lg transition-colors flex items-center gap-2 group"
									>
										<PhIcon className="ph-bold ph-arrow-left group-hover:-translate-x-1 transition-transform" />
										<span>Back</span>
									</button>
								}
								right={
									<button
										type="button"
										onClick={() => setStep(4)}
										className="group bg-hc-red text-white px-8 py-4 rounded-xl font-bold text-lg flex items-center gap-3 shadow-lg shadow-hc-red/20"
									>
										<span>Next: How it Works</span>
										<PhIcon className="ph-bold ph-arrow-right group-hover:translate-x-1 transition-transform" />
									</button>
								}
							/>
						)}

						{step === 4 && (
							<Panel
								icon="ph-cloud-check text-hc-red"
								title="It's Just S3"
								content={
									<>
										You can use almost all standard S3 functions. We store
										everyone&apos;s data in one massive bucket, but to you, it
										feels like your own private bucket.
										<br />
										<br />
										There is a proxy, but you&apos;ll never notice. Just create
										buckets and ship!
									</>
								}
								left={
									<button
										type="button"
										onClick={() => setStep(3)}
										className="text-text-muted hover:text-white px-6 py-3 font-bold text-lg transition-colors flex items-center gap-2 group"
									>
										<PhIcon className="ph-bold ph-arrow-left group-hover:-translate-x-1 transition-transform" />
										<span>Back</span>
									</button>
								}
								right={
									<form action="/api/onboarding/complete" method="POST">
										<button
											type="submit"
											className="group bg-hc-red text-white px-8 py-4 rounded-xl font-bold text-lg flex items-center gap-3 shadow-lg shadow-hc-red/20"
										>
											<span>Get Started</span>
											<PhIcon className="ph-bold ph-rocket-launch group-hover:translate-x-1 transition-transform" />
										</button>
									</form>
								}
							/>
						)}
					</motion.div>
				</AnimatePresence>
			</div>
		</AppShell>
	);
}

function Panel({
	icon,
	title,
	subtitle,
	content,
	extra,
	left,
	right,
}: {
	icon: string;
	title: string;
	subtitle?: React.ReactNode;
	content: React.ReactNode;
	extra?: React.ReactNode;
	left?: React.ReactNode;
	right?: React.ReactNode;
}) {
	const isCenteredOnlyRight = !left && !!right;

	return (
		<div className="text-center max-w-3xl mx-auto w-full">
			<div className="mb-8 flex justify-center">
				<PhIcon className={`ph-duotone ${icon} text-8xl`} />
			</div>
			<h1 className="text-6xl md:text-8xl font-black text-white mb-8 tracking-tighter italic">
				{title}
			</h1>
			{subtitle ? (
				<p className="block text-4xl md:text-6xl mt-2 text-white/50 font-black tracking-tighter mb-6 italic">
					{subtitle}
				</p>
			) : null}
			<p className="text-text-muted text-2xl max-w-3xl mx-auto font-medium mb-12 leading-relaxed">
				{content}
			</p>
			{extra}
			<div
				className={`flex items-center w-full max-w-md mx-auto ${isCenteredOnlyRight ? "justify-center gap-6" : "justify-between"}`}
			>
				<div>{left}</div>
				<div>{right}</div>
			</div>
		</div>
	);
}
