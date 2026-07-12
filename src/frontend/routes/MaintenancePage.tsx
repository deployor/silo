import { AppShell } from "../components/AppShell";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";

export function MaintenancePage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const props = bootstrap.props as {
		user?: FrontendUser | null;
		storageOnly?: boolean;
	};
	const storageOnly = props.storageOnly === true;
	return (
		<AppShell
			title="Maintenance"
			user={props.user || null}
			config={bootstrap.config}
		>
			<section className="mx-auto max-w-xl border border-amber-400/30 bg-hc-dark rounded-2xl p-10 text-center card-shadow">
				<div className="text-5xl" aria-hidden="true">
					🔧
				</div>
				<h1 className="mt-5 text-3xl font-bold text-white">Maintenance</h1>
				<p className="mt-3 text-text-muted leading-relaxed">
					{storageOnly
						? "Storage is temporarily unavailable due to planned maintenance. Files, links, and object details cannot be accessed right now."
						: "The application is temporarily unavailable due to planned maintenance. Please check back shortly."}
				</p>
			</section>
		</AppShell>
	);
}
