export type AnyRecord = Record<string, unknown>;

export type GitInfo = {
	shortSha?: string;
	sha?: string;
	message?: string;
	date?: string;
	buildDate?: string;
};

export type FrontendConfig = {
	env?: string;
	git?: GitInfo;
	s3Domain?: string;
	dashboardDomain?: string;
	dashboardUrl?: string;
	customDomainsEnabled?: boolean;
	deepFreezeEnabled?: boolean;
	cloudflareForSaas?: {
		targetHostname?: string;
		configured?: boolean;
	};
};

export type FrontendUser = {
	id: string;
	email?: string;
	slackId?: string | null;
	avatarUrl?: string | null;
	pendingCollaborationInvites?: number;
	isAdmin?: boolean;
	isImmortal?: boolean;
	isLocked?: boolean;
	lockReason?: string | null;
	onboarded?: boolean;
	markedAsOverAge?: boolean;
	dataExported?: boolean;
	filesDeleted?: boolean;
};

export type AppBootstrap = {
	page: string;
	title?: string;
	layout?: string | boolean;
	props: AnyRecord;
	config?: FrontendConfig;
};

declare global {
	interface Window {
		__SILO_APP__?: AppBootstrap;
	}
}
