import { AdminBucketsPage } from "../routes/AdminBucketsPage";
import { AdminCachePage } from "../routes/AdminCachePage";
import { AdminLogsPage } from "../routes/AdminLogsPage";
import { AdminRedemptionDetailsPage } from "../routes/AdminRedemptionDetailsPage";
import { AdminRedemptionGeneratedPage } from "../routes/AdminRedemptionGeneratedPage";
import { AdminRedemptionsPage } from "../routes/AdminRedemptionsPage";
import { AdminSettingsPage } from "../routes/AdminSettingsPage";
import { AdminSpeedtestPage } from "../routes/AdminSpeedtestPage";
import { AdminUsersPage } from "../routes/AdminUsersPage";
import { AdminYswsListPage } from "../routes/AdminYswsListPage";
import { AdminYswsReviewPage } from "../routes/AdminYswsReviewPage";
import { AgedOutPage } from "../routes/AgedOutPage";
import { CdnPage } from "../routes/CdnPage";
import { DashboardPage } from "../routes/DashboardPage";
import { DocsPage } from "../routes/DocsPage";
import { FilesPage } from "../routes/FilesPage";
import { GalleryPage } from "../routes/GalleryPage";
import { LandingPage } from "../routes/LandingPage";
import { LockedPage } from "../routes/LockedPage";
import { OffboardingPage } from "../routes/OffboardingPage";
import { OnboardingPage } from "../routes/OnboardingPage";
import { RedeemPage } from "../routes/RedeemPage";
import { SlackSuccessPage } from "../routes/SlackSuccessPage";
import { WipPage } from "../routes/WipPage";
import { YswsListPage } from "../routes/YswsListPage";
import { YswsSubmitPage } from "../routes/YswsSubmitPage";
import type { AppBootstrap } from "../shared/types/app";

type Props = { bootstrap: AppBootstrap };

export function App({ bootstrap }: Props) {
	const page = bootstrap.page;
	const props = bootstrap.props ?? {};

	switch (page) {
		case "landing":
			return <LandingPage bootstrap={bootstrap} />;
		case "dashboard":
			return <DashboardPage bootstrap={bootstrap} />;
		case "files":
			return <FilesPage bootstrap={bootstrap} />;
		case "docs":
			return <DocsPage bootstrap={bootstrap} />;
		case "cdn":
			return <CdnPage bootstrap={bootstrap} />;
		case "offboarding":
			return <OffboardingPage bootstrap={bootstrap} />;
		case "admin-users":
			return <AdminUsersPage bootstrap={bootstrap} />;
		case "admin-buckets":
			return <AdminBucketsPage bootstrap={bootstrap} />;
		case "admin-speedtest":
			return <AdminSpeedtestPage bootstrap={bootstrap} />;
		case "admin-logs":
			return <AdminLogsPage bootstrap={bootstrap} />;
		case "admin-cache":
			return <AdminCachePage bootstrap={bootstrap} />;
		case "admin-settings":
			return <AdminSettingsPage bootstrap={bootstrap} />;
		case "admin-redemptions":
			return <AdminRedemptionsPage bootstrap={bootstrap} />;
		case "admin-redemption-details":
			return <AdminRedemptionDetailsPage bootstrap={bootstrap} />;
		case "admin-redemption-generated":
			return <AdminRedemptionGeneratedPage bootstrap={bootstrap} />;
		case "admin-ysws":
			return <AdminYswsListPage bootstrap={bootstrap} />;
		case "admin-ysws-review":
			return <AdminYswsReviewPage bootstrap={bootstrap} />;
		case "ysws-list":
			return <YswsListPage bootstrap={bootstrap} />;
		case "ysws-submit":
			return <YswsSubmitPage bootstrap={bootstrap} />;
		case "gallery":
			return <GalleryPage bootstrap={bootstrap} />;
		case "redeem":
			return <RedeemPage bootstrap={bootstrap} />;
		case "slack-success":
			return <SlackSuccessPage bootstrap={bootstrap} />;
		case "wip":
			return <WipPage bootstrap={bootstrap} />;
		case "onboarding":
			return <OnboardingPage bootstrap={bootstrap} />;
		case "locked":
			return <LockedPage bootstrap={bootstrap} />;
		case "aged-out":
			return <AgedOutPage bootstrap={bootstrap} />;
		default:
			return (
				<div className="min-h-screen flex items-center justify-center text-white">
					<div className="bg-hc-dark rounded-2xl border border-white/10 p-8 max-w-xl">
						<h1 className="text-2xl font-bold mb-2">Unsupported page</h1>
						<p className="text-text-muted text-sm">
							No React renderer for page: {page}
						</p>
						<pre className="mt-4 text-xs bg-black/30 p-3 rounded-lg overflow-auto">
							{JSON.stringify(props, null, 2)}
						</pre>
					</div>
				</div>
			);
	}
}
