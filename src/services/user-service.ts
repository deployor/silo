import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { buckets, users } from "../db/schema";

export async function getUserById(userId: string) {
	const user = await db
		.select()
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return user[0] || null;
}

export async function getUserBySlackId(slackId: string) {
	const user = await db
		.select()
		.from(users)
		.where(eq(users.slackId, slackId))
		.limit(1);
	return user[0] || null;
}

export async function getStorageUsage(userId: string): Promise<number> {
	const usageResult = await db
		.select({ total: sql<number>`sum(${buckets.totalBytes})` })
		.from(buckets)
		.where(eq(buckets.userId, userId));
	return Number(usageResult[0]?.total) || 0;
}

export const UserService = {
	getUserById,
	getUserBySlackId,
	getStorageUsage,
};
