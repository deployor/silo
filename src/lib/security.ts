import { config } from "../config";

export function validateOrigin(req: Request): boolean {
	const origin = req.headers.get("Origin");
	const referer = req.headers.get("Referer");

	if (!origin && !referer) {
		return true;
	}

	const allowedDomains = new Set([config.dashboardDomain, "localhost"]);

	if (origin) {
		try {
			const originUrl = new URL(origin);
			if (!allowedDomains.has(originUrl.hostname)) {
				return false;
			}
		} catch (_e) {
			return false;
		}
	}

	if (referer) {
		try {
			const refererUrl = new URL(referer);
			if (!allowedDomains.has(refererUrl.hostname)) {
				return false;
			}
		} catch (_e) {
			return false;
		}
	}

	return true;
}
