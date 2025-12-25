import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { buckets, users } from "../db/schema";

export async function getCurrentUser(req: Request) {
	const cookieHeader = req.headers.get("Cookie");
	if (cookieHeader) {
		const cookies = cookieHeader.split(";").reduce(
			(acc, cookie) => {
				const [key, value] = cookie.trim().split("=");
				acc[key] = value;
				return acc;
			},
			{} as Record<string, string>,
		);

		if (cookies.silo_user_id) {
			const user = await db
				.select()
				.from(users)
				.where(eq(users.id, cookies.silo_user_id))
				.limit(1);
			if (user.length > 0) {
				const u = user[0];
				// Calculate storage usage from all buckets
				const usageResult = await db
					.select({ total: sql<number>`sum(${buckets.totalBytes})` })
					.from(buckets)
					.where(eq(buckets.userId, u.id));

				u.storageUsageBytes = Number(usageResult[0]?.total) || 0;
				return u;
			}
		}
	}

	return null;
}
