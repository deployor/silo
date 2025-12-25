import { config } from "../config";

export function validateOrigin(req: Request): boolean {
	const origin = req.headers.get("Origin");
	const referer = req.headers.get("Referer");

	// If neither header is present, we can't verify the source.
	// For strict security, we might block this, but for now let's allow it
	// assuming it might be a direct API call from a non-browser client (though auth would still be needed).
	// However, for browser-based attacks, one of these should be present.
	if (!origin && !referer) {
		return true;
	}

	const allowedDomain = config.s3Domain; // e.g. "silo.deployor.dev"
	// We also need to allow localhost for development if needed, but config.s3Domain should cover the production case.
	// Assuming config.s3Domain is the main domain.

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
