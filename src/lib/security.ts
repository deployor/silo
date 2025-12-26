import { config } from "../config";

export function validateOrigin(req: Request): boolean {
	const origin = req.headers.get("Origin");
	const referer = req.headers.get("Referer");

	if (!origin && !referer) {
		return true;
	}

	const allowedDomain = config.s3Domain;

	if (origin) {
		try {
			const originUrl = new URL(origin);
			if (
				originUrl.hostname !== allowedDomain &&
				originUrl.hostname !== "localhost"
			) {
				return false;
			}
		} catch (_e) {
			return false;
		}
	}

	if (referer) {
		try {
			const refererUrl = new URL(referer);
			if (
				refererUrl.hostname !== allowedDomain &&
				refererUrl.hostname !== "localhost"
			) {
				return false;
			}
		} catch (_e) {
			return false;
		}
	}

	return true;
}
