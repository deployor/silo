import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

function normalizeTypedCode(value: string) {
	const trimmed = value.trim();

	try {
		const parsed = new URL(trimmed);
		const code = parsed.searchParams.get("code");
		if (code) return normalizeTypedCode(code);
	} catch {
		// Normal code input, not a URL.
	}

	return value
		.toUpperCase()
		.replace(/[_\s]+/g, "-")
		.replace(/[^A-Z0-9-]/g, "")
		.replace(/-+/g, "-");
}

function RedeemStyles() {
	return (
		<style>{`
			@keyframes redeem-caret {
				0%, 45% { opacity: 1; }
				46%, 100% { opacity: 0; }
			}

			@keyframes redeem-paper-in {
				from {
					opacity: 0;
					transform: translateY(10px) rotate(-0.35deg);
				}
				to {
					opacity: 1;
					transform: translateY(0) rotate(-0.35deg);
				}
			}

			@keyframes redeem-line-scan {
				0% { transform: translateX(-105%); }
				100% { transform: translateX(105%); }
			}

			@keyframes redeem-stamp {
				0% {
					opacity: 0;
					transform: translate(-50%, -50%) scale(1.65) rotate(-10deg);
					filter: blur(2px);
				}
				52% {
					opacity: 1;
					transform: translate(-50%, -50%) scale(0.92) rotate(-10deg);
					filter: blur(0);
				}
				68% {
					transform: translate(-50%, -50%) scale(1.03) rotate(-10deg);
				}
				100% {
					opacity: 1;
					transform: translate(-50%, -50%) scale(1) rotate(-10deg);
				}
			}

			@keyframes redeem-pop {
				0% { transform: scaleX(0); opacity: 0; }
				100% { transform: scaleX(1); opacity: 1; }
			}

			.redeem-sheet {
				animation: redeem-paper-in 420ms cubic-bezier(.2,.8,.2,1) both;
			}

			.redeem-input-wrap::after {
				content: "";
				position: absolute;
				left: 0;
				right: 0;
				bottom: -1px;
				height: 2px;
				background: #ec3750;
				transform: scaleX(var(--redeem-progress, 0));
				transform-origin: left center;
				transition: transform 180ms ease;
			}

			.redeem-input-wrap[data-active="true"]::before {
				content: "";
				position: absolute;
				inset: 0;
				background: linear-gradient(90deg, transparent, rgba(236,55,80,.08), transparent);
				animation: redeem-line-scan 1.2s ease infinite;
				pointer-events: none;
			}

			.redeem-caret {
				animation: redeem-caret 1s steps(1) infinite;
			}

			.redeem-stamp {
				animation: redeem-stamp 720ms cubic-bezier(.18,.92,.18,1.18) 130ms both;
			}

			.redeem-pop {
				animation: redeem-pop 420ms cubic-bezier(.2,.8,.2,1) 520ms both;
				transform-origin: left center;
			}
		`}</style>
	);
}

export function RedeemPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		success?: boolean;
		credits?: number;
		programName?: string;
		code?: string;
		error?: string;
	};
	const [code, setCode] = useState(() => normalizeTypedCode(p.code || ""));
	const trimmedCode = code.replace(/^-|-$/g, "");
	const progress = useMemo(
		() => Math.min(1, trimmedCode.replace(/-/g, "").length / 20),
		[trimmedCode],
	);
	const codeParts = useMemo(
		() =>
			trimmedCode
				.split("-")
				.filter(Boolean)
				.reduce<Array<{ id: string; value: string }>>((parts, value) => {
					const previous = parts.at(-1)?.id;
					parts.push({
						id: previous ? `${previous}-${value}` : value,
						value,
					});
					return parts;
				}, []),
		[trimmedCode],
	);

	useEffect(() => {
		if (!p.success) return;
		try {
			document.documentElement.animate(
				[
					{ transform: "translateY(0)" },
					{ transform: "translateY(-2px)" },
					{ transform: "translateY(0)" },
				],
				{ duration: 360, easing: "cubic-bezier(.2,.8,.2,1)" },
			);
		} catch {}
	}, [p.success]);

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<RedeemStyles />
			<main className="min-h-[calc(100vh-96px)] bg-[#f7f4ed] text-[#151515]">
				<div className="mx-auto flex min-h-[calc(100vh-96px)] w-full max-w-3xl items-center px-4 py-10">
					<section className="redeem-sheet relative w-full border border-[#151515] bg-[#fbfaf5] px-5 py-6 shadow-[8px_8px_0_#151515] sm:px-8 sm:py-8">
						<div className="mb-7 flex items-start justify-between gap-4 border-b border-[#151515] pb-4">
							<div>
								<p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#6f6a60]">
									Silo
								</p>
								<h1 className="mt-1 text-3xl font-black leading-none tracking-normal sm:text-5xl">
									Redeem storage
								</h1>
							</div>
							<div className="border border-[#151515] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em]">
								YSWS
							</div>
						</div>

						{p.success ? (
							<div className="relative min-h-[300px] overflow-hidden border border-[#151515] bg-white px-5 py-6 sm:px-7">
								<div className="grid gap-6 sm:grid-cols-[1fr_auto] sm:items-end">
									<div>
										<p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#6f6a60]">
											Storage added
										</p>
										<p className="mt-3 text-5xl font-black leading-none sm:text-7xl">
											{formatBytes(p.credits || 0)}
										</p>
										<p className="mt-3 max-w-md text-sm leading-6 text-[#5e594f]">
											{p.programName
												? `From ${p.programName}.`
												: "Code accepted."}
										</p>
									</div>
									<a
										href="/"
										className="inline-flex h-12 items-center justify-center border border-[#151515] bg-[#151515] px-5 font-mono text-xs font-bold uppercase tracking-[0.16em] text-white transition-transform hover:-translate-y-0.5"
									>
										Open Silo
									</a>
								</div>

								<div className="redeem-pop mt-8 h-1 w-full bg-[#151515]" />
								<div className="redeem-stamp pointer-events-none absolute left-1/2 top-1/2 border-[6px] border-[#ec3750] px-6 py-3 font-mono text-2xl font-black uppercase tracking-[0.22em] text-[#ec3750] sm:text-4xl">
									Redeemed
								</div>
							</div>
						) : (
							<form method="POST" action="/redeem" className="space-y-5">
								<label htmlFor="code" className="block">
									<span className="mb-2 block font-mono text-[11px] uppercase tracking-[0.22em] text-[#6f6a60]">
										Code
									</span>
									<div
										className="redeem-input-wrap relative overflow-hidden border border-[#151515] bg-white"
										data-active={trimmedCode ? "true" : "false"}
										style={
											{
												"--redeem-progress": String(progress),
											} as CSSProperties
										}
									>
										<input
											type="text"
											name="code"
											id="code"
											required
											value={code}
											onChange={(event) =>
												setCode(normalizeTypedCode(event.currentTarget.value))
											}
											autoComplete="one-time-code"
											inputMode="text"
											spellCheck={false}
											className="relative z-10 block h-20 w-full bg-transparent px-4 text-center font-mono text-xl font-black uppercase tracking-[0.18em] text-[#151515] outline-none placeholder:text-[#bab3a7] sm:text-2xl"
											placeholder="PROGRAM-0000-0000"
										/>
									</div>
								</label>

								<div className="min-h-9 border-y border-[#151515] py-2 font-mono text-xs uppercase tracking-[0.14em] text-[#6f6a60]">
									{codeParts.length ? (
										<div className="flex flex-wrap items-center gap-2">
											{codeParts.map((part) => (
												<span
													key={part.id}
													className="border border-[#d8d1c5] bg-[#fbfaf5] px-2 py-1 text-[#151515]"
												>
													{part.value}
												</span>
											))}
											<span className="redeem-caret text-[#ec3750]">_</span>
										</div>
									) : (
										<span>Waiting for code</span>
									)}
								</div>

								{p.error ? (
									<div className="border border-[#ec3750] bg-[#fff7f7] px-4 py-3 font-mono text-sm text-[#b62336]">
										{p.error}
									</div>
								) : null}

								<button
									type="submit"
									className="flex h-14 w-full items-center justify-center border border-[#151515] bg-[#151515] px-5 font-mono text-sm font-black uppercase tracking-[0.18em] text-white transition-transform hover:-translate-y-0.5 active:translate-y-0"
								>
									Redeem
								</button>
							</form>
						)}

						<div className="mt-6 flex flex-wrap items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.16em] text-[#6f6a60]">
							<span>Signed in as {p.user?.id || "user"}</span>
							<span>Storage credit</span>
						</div>
					</section>
				</div>
			</main>
		</AppShell>
	);
}
