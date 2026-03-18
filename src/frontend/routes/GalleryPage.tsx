import { AppShell } from "../components/AppShell";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatDate } from "../shared/utils/format";

type GalleryProject = {
	projectName: string;
	shortDescription?: string;
	demoUrl: string;
	repoUrl?: string;
	screenshotUrl?: string;
	hoursSpent?: number;
	reviewedAt?: string;
};

export function GalleryPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		galleryProjects?: GalleryProject[];
		user?: FrontendUser | null;
	};
	const projects = p.galleryProjects || [];

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<div className="max-w-7xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
				<div className="mb-12 border-b border-white/10 pb-8">
					<h1 className="text-4xl font-extrabold tracking-tight mb-4 text-white">
						Gallery
					</h1>
					<p className="text-xl text-text-muted max-w-2xl">
						Discover projects built by the community.
					</p>
					<div className="mt-6 flex gap-4">
						<a
							href="/ysws/submit"
							className="bg-hc-red hover:bg-red-600 text-white font-bold py-2 px-5 rounded-lg transition-colors inline-flex items-center gap-2"
						>
							<i className="ph-bold ph-plus" /> Submit Project
						</a>
						<a
							href="/"
							className="text-white/60 hover:text-white font-bold py-2 px-5 rounded-lg transition-colors border border-white/10 hover:bg-white/5"
						>
							Back Home
						</a>
					</div>
				</div>

				{projects.length > 0 ? (
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
						{projects.map((item) => (
							<div
								key={`${item.projectName}-${item.demoUrl}`}
								className="bg-hc-dark border border-white/10 rounded-xl overflow-hidden flex flex-col h-full hover:border-white/20 transition-colors"
							>
								<a
									href={item.demoUrl}
									target="_blank"
									rel="noreferrer"
									className="block aspect-video bg-black/20 relative group overflow-hidden border-b border-white/5"
								>
									{item.screenshotUrl ? (
										<img
											src={item.screenshotUrl}
											alt={item.projectName}
											className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
											loading="lazy"
										/>
									) : (
										<div className="w-full h-full flex items-center justify-center text-white/10">
											<i className="ph ph-image text-4xl" />
										</div>
									)}
									<div className="absolute top-3 right-3 bg-black/80 backdrop-blur-sm border border-white/10 rounded px-2 py-1 text-xs font-mono text-white flex items-center gap-1.5 shadow-sm">
										<i className="ph-fill ph-check-circle text-hc-green" />{" "}
										{item.hoursSpent || 0}h
									</div>
								</a>
								<div className="p-5 flex flex-col flex-1">
									<div className="flex justify-between items-start gap-4 mb-2">
										<a
											href={item.demoUrl}
											target="_blank"
											rel="noreferrer"
											className="text-lg font-bold text-white hover:text-hc-blue transition-colors line-clamp-1"
										>
											{item.projectName}
										</a>
										{item.repoUrl ? (
											<a
												href={item.repoUrl}
												target="_blank"
												rel="noreferrer"
												className="text-white/40 hover:text-white transition-colors shrink-0"
												title="View Code"
											>
												<i className="ph-fill ph-github-logo text-xl" />
											</a>
										) : null}
									</div>
									<p className="text-text-muted text-sm line-clamp-2 leading-relaxed mb-4 flex-1">
										{item.shortDescription}
									</p>
									<div className="flex items-center gap-2 text-xs text-white/30 font-mono border-t border-white/5 pt-3 mt-auto">
										<i className="ph ph-calendar-blank" />
										<span>Shipped {formatDate(item.reviewedAt)}</span>
									</div>
								</div>
							</div>
						))}
					</div>
				) : (
					<div className="text-center py-24 bg-white/5 border border-white/10 rounded-xl border-dashed">
						<div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
							<i className="ph ph-images text-3xl text-white/40" />
						</div>
						<h3 className="text-xl font-bold text-white mb-2">
							Gallery is Empty
						</h3>
						<p className="text-text-muted max-w-sm mx-auto mb-6">
							No approved projects yet.
						</p>
					</div>
				)}
			</div>
		</AppShell>
	);
}
