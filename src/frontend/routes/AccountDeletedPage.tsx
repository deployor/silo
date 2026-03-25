import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import type { AppBootstrap } from "../shared/types/app";

export function AccountDeletedPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	return (
		<AppShell title={bootstrap.title} hideNavLinks mainClass="flex items-center justify-center">
			<div className="mx-auto max-w-2xl rounded-[32px] border border-white/10 bg-hc-dark p-10 text-center card-shadow">
				<div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border border-white/10 bg-white/5 text-white">
					<PhIcon className="ph ph-hand-waving text-3xl" />
				</div>
				<h1 className="mt-6 text-4xl font-black text-white">Thanks for being with us.</h1>
				<p className="mt-4 text-base leading-7 text-text-muted">
					Your account, sessions, buckets, and stored data have been removed.
				</p>
				<a
					href="/"
					className="mt-8 inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-6 py-3 text-sm font-bold text-white transition-colors hover:bg-white/10"
				>
					Return home
				</a>
			</div>
		</AppShell>
	);
}
