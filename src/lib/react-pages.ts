export const REACT_PAGE_IDS = [
	"landing",
	"dashboard",
	"bucket-analytics",
	"files",
	"docs",
	"cdn",
	"offboarding",
	"admin-users",
	"admin-buckets",
	"admin-bucket-analytics",
	"admin-speedtest",
	"admin-logs",
	"admin-cache",
	"admin-settings",
	"admin-redemptions",
	"admin-redemption-details",
	"admin-redemption-generated",
	"admin-ysws",
	"admin-ysws-review",
	"ysws-list",
	"ysws-submit",
	"gallery",
	"redeem",
	"slack-success",
	"wip",
	"onboarding",
	"locked",
	"aged-out",
] as const;

export type ReactPageId = (typeof REACT_PAGE_IDS)[number];

const REACT_PAGE_SET = new Set<string>(REACT_PAGE_IDS);

export function isReactPageId(value: string): value is ReactPageId {
	return REACT_PAGE_SET.has(value);
}
