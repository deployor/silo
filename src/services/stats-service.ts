import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { buckets, users } from "../db/schema";
import { getContext } from "../lib/context";

class StatsService {
	public async recordUsage(ingress: number, egress: number) {
		const ctx = getContext();
		const userId = ctx?.user?.id;
		if (!userId) return;

		try {
			await db.transaction(async (tx) => {
				await tx
					.update(users)
					.set({
						ingressBytes: sql`COALESCE(${users.ingressBytes}, 0) + ${ingress}`,
						egressBytes: sql`COALESCE(${users.egressBytes}, 0) + ${egress}`,
						totalRequests: sql`COALESCE(${users.totalRequests}, 0) + 1`,
					})
					.where(eq(users.id, userId));

				if (ctx?.bucket) {
					await tx
						.update(buckets)
						.set({
							totalRequests: sql`COALESCE(${buckets.totalRequests}, 0) + 1`,
						})
						.where(eq(buckets.id, ctx.bucket.id));
				}
			});
		} catch (e) {
			console.error("Failed to update aggregate stats:", e);
		}
	}
}

export const statsService = new StatsService();
