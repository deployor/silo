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
					transform: translateY(8px);
				}
				to {
					opacity: 1;
					transform: translateY(0);
				}
			}

			@keyframes redeem-line-scan {
				0% { transform: translateX(-105%); }
				100% { transform: translateX(105%); }
			}

			@keyframes redeem-stamp {
				0% {
					opacity: 0;
					transform: scale(.92);
				}
				70% {
					opacity: 1;
					transform: scale(1.03);
				}
				100% {
					opacity: 1;
					transform: scale(1);
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
				background: linear-gradient(90deg, transparent, rgba(236,55,80,.10), transparent);
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
			<main className="min-h-[calc(100vh-96px)]">
				<div className="mx-auto flex min-h-[calc(100vh-96px)] w-full max-w-xl items-center px-4 py-12">
					<section className="redeem-sheet relative w-full overflow-hidden rounded-3xl border border-white/10 bg-hc-dark p-6 card-shadow sm:p-8">
						<div className="mb-8 flex items-start justify-between gap-4 border-b border-white/10 pb-5">
							<div>
								<p className="font-mono text-[11px] uppercase tracking-[0.22em] text-text-muted">
									Silo
								</p>
								<h1 className="mt-2 text-3xl font-black leading-none tracking-normal text-white sm:text-4xl">
									Redeem storage
								</h1>
							</div>
							<div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
								YSWS
							</div>
						</div>

						{p.success ? (
							<div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-6">
								<div className="redeem-stamp mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/15 text-2xl text-emerald-300">
									✓
								</div>
								<p className="font-mono text-[11px] uppercase tracking-[0.22em] text-emerald-300">
									Storage added
								</p>
								<p className="mt-3 text-5xl font-black leading-none text-white">
									{formatBytes(p.credits || 0)}
								</p>
								<p className="mt-3 text-sm leading-6 text-text-muted">
									{p.programName
										? `Redeemed from ${p.programName}.`
										: "Code accepted."}
								</p>
								<div className="redeem-pop mt-6 h-px w-full bg-emerald-400/40" />
								<div className="mt-6">
									<a
										href="/"
										className="inline-flex h-12 items-center justify-center rounded-xl bg-hc-red px-5 text-sm font-bold text-white transition-colors hover:bg-red-600"
									>
										Open Dashboard
									</a>
								</div>
							</div>
						) : (
							<form method="POST" action="/redeem" className="space-y-5">
								<label htmlFor="code" className="block">
									<span className="mb-2 block font-mono text-[11px] uppercase tracking-[0.22em] text-text-muted">
										Code
									</span>
									<div
										className="redeem-input-wrap relative overflow-hidden rounded-2xl border border-white/10 bg-black/30"
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
											className="relative z-10 block h-20 w-full bg-transparent px-4 text-center font-mono text-xl font-black uppercase tracking-[0.18em] text-white outline-none placeholder:text-white/20 sm:text-2xl"
											placeholder="PROGRAM-0000-0000"
										/>
									</div>
								</label>

								<div className="min-h-9 border-y border-white/10 py-2 font-mono text-xs uppercase tracking-[0.14em] text-text-muted">
									{codeParts.length ? (
										<div className="flex flex-wrap items-center gap-2">
											{codeParts.map((part) => (
												<span
													key={part.id}
													className="rounded border border-white/10 bg-white/5 px-2 py-1 text-white"
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
									<div className="rounded-xl border border-hc-red/30 bg-hc-red/10 px-4 py-3 text-sm text-red-200">
										{p.error}
									</div>
								) : null}

								<button
									type="submit"
									className="flex h-14 w-full items-center justify-center rounded-xl bg-hc-red px-5 text-sm font-bold text-white transition-colors hover:bg-red-600"
								>
									Redeem
								</button>
							</form>
						)}

						<div className="mt-6 flex flex-wrap items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
							<span>Signed in as {p.user?.id || "user"}</span>
							<span>Storage credit</span>
						</div>
					</section>
				</div>
			</main>
		</AppShell>
	);
}
