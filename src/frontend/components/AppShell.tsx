import type React from "react";
import { useMemo } from "react";
import type { FrontendConfig, FrontendUser } from "../shared/types/app";
import { timeAgo } from "../shared/utils/format";

function stripTags(value: string): string {
	return value.replace(/<[^>]*>/g, "").trim();
}

type Props = {
	title?: string;
	pageTitle?: string;
	user?: FrontendUser | null;
	hideNavLinks?: boolean;
	mainClass?: string;
	breadcrumbs?: string;
	config?: FrontendConfig;
	children: React.ReactNode;
};

export function AppShell({
	title,
	pageTitle,
	user,
	hideNavLinks,
	mainClass,
	breadcrumbs,
	config,
	children,
}: Props) {
	const isImpersonating = useMemo(() => {
		try {
			return document.cookie.includes("silo_impersonating=true");
		} catch {
			return false;
		}
	}, []);

	return (
		<div className="min-h-screen selection:bg-hc-red selection:text-white flex flex-col font-sans">
			<nav className="w-full bg-hc-darker border-b border-white/10 px-6 py-4 sticky top-0 z-50 flex justify-between items-center">
				<div className="flex items-center gap-4 min-w-0">
					<a
						href="/"
						className="font-bold text-2xl tracking-tighter italic text-white hover:text-hc-red transition-colors"
					>
						SILO
					</a>
					{pageTitle ? (
						<span className="bg-hc-red/20 text-hc-red px-2 py-0.5 rounded text-sm font-mono border border-hc-red/30">
							{pageTitle}
						</span>
					) : null}
					{breadcrumbs ? (
						<span className="text-sm text-text-muted">
							{stripTags(breadcrumbs)}
						</span>
					) : null}
					{config?.git?.shortSha ? (
						<div className="hidden md:flex flex-col justify-center text-[10px] leading-none text-white/20 font-mono ml-4 cursor-default select-none gap-[1px]">
							<div className="flex items-center gap-[3px] whitespace-nowrap">
								<span className="uppercase tracking-wider font-bold">
									{config.env}
								</span>
								<span className="opacity-30 text-[8px]">|</span>
								<span title={config.git.sha}>{config.git.shortSha}</span>
								{config.git.message ? (
									<>
										<span className="opacity-30 text-[8px]">|</span>
										<span
											className="max-w-[150px] truncate"
											title={config.git.message}
										>
											{config.git.message}
										</span>
									</>
								) : null}
							</div>
							<div className="flex items-center gap-[3px] whitespace-nowrap opacity-70">
								{config.git.date ? (
									<span>{timeAgo(config.git.date)}</span>
								) : null}
								{config.git.date && config.git.buildDate ? (
									<>
										<span className="opacity-30 text-[8px]">|</span>
										<span>
											took{" "}
											{Math.max(
												0,
												Math.floor(
													(new Date(config.git.buildDate).getTime() -
														new Date(config.git.date).getTime()) /
														1000,
												),
											)}
											s
										</span>
									</>
								) : null}
							</div>
						</div>
					) : null}
				</div>
				<div className="flex items-center gap-6 font-bold text-sm">
					{!hideNavLinks ? (
						user ? (
							<>
								<a
									href="/ysws"
									className="text-white hover:text-hc-green transition-colors font-bold border border-white/20 rounded px-3 py-1 bg-white/5 hover:bg-white/10"
								>
									YSWS
								</a>
								<a
									href="/cdn"
									className="text-text-muted hover:text-white transition-colors"
								>
									CDN
								</a>
								<a
									href="/docs"
									className="text-text-muted hover:text-white transition-colors"
								>
									Docs
								</a>
								<div className="flex items-center gap-2 min-w-0">
									{user.avatarUrl ? (
										<img
											src={user.avatarUrl}
											alt="User Avatar"
											className="w-6 h-6 rounded-full"
										/>
									) : null}
									<div className="flex items-center gap-2">
										<span className="text-text-muted font-mono truncate max-w-[14rem]">
											{user.id}
										</span>
										{user.isImmortal ? (
											<i
												className="ph ph-crown text-amber-400 text-lg"
												title="You are immortal. Your account won't be deleted, and your storage and bandwidth are unlimited."
											/>
										) : null}
									</div>
								</div>
								{user.isAdmin ? (
									<a
										href="/admin/users"
										className="text-text-muted hover:text-white transition-colors"
									>
										Admin
									</a>
								) : user.isReviewer ? (
									<a
										href="/admin/ysws"
										className="text-text-muted hover:text-white transition-colors"
									>
										Admin
									</a>
								) : null}
								<a
									href="/auth/logout"
									className="text-hc-red hover:text-white transition-colors"
								>
									{isImpersonating ? "Stop impersonating" : "Logout"}
								</a>
							</>
						) : (
							<a
								href="/auth/login"
								className="text-hc-red hover:text-white transition-colors"
							>
								Login
							</a>
						)
					) : null}
				</div>
			</nav>
			<main className={`max-w-7xl mx-auto w-full px-6 py-8 ${mainClass || ""}`}>
				{title ? <h1 className="sr-only">{title}</h1> : null}
				{children}
			</main>
		</div>
	);
}
