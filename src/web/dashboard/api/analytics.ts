import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import { getCurrentUser } from "../../../lib/session";
import { analyticsService } from "../../../services/analytics-service";

export async function handleAnalytics(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	const url = new URL(req.url);
	const path = url.pathname;
	const match = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/analytics\/(summary|timeseries|objects|live)$/,
	);
	if (!match) return errorResponse("Not Found", 404);

	const bucketName = match[1];
	const kind = match[2];

	try {
		if (kind === "summary") {
			return jsonResponse(
				await analyticsService.getBucketAnalyticsSnapshot({
					bucketName,
					userId: user.id,
					isAdmin: user.isAdmin,
				}),
			);
		}

		if (kind === "timeseries") {
			return jsonResponse({
				series: await analyticsService.getBucketAnalyticsTimeseries({
					bucketName,
					userId: user.id,
					isAdmin: user.isAdmin,
					range: url.searchParams.get("range") || "24h",
				}),
			});
		}

		if (kind === "objects") {
			return jsonResponse({
				objects: await analyticsService.getBucketHotObjects({
					bucketName,
					userId: user.id,
					isAdmin: user.isAdmin,
				}),
			});
		}

		return jsonResponse(
			await analyticsService.getBucketAnalyticsLive({
				bucketName,
				userId: user.id,
				isAdmin: user.isAdmin,
			}),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Internal Error";
		return errorResponse(message, message === "Unauthorized" ? 403 : 500);
	}
}
