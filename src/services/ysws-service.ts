import { db } from "../db";
import { yswsSubmissions, users } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { SettingsService } from "./settings-service";
import { UserService } from "./user-service";

export type YswsSubmission = typeof yswsSubmissions.$inferSelect;
export type NewYswsSubmission = typeof yswsSubmissions.$inferInsert;

export async function createSubmission(submission: NewYswsSubmission) {
	const [result] = await db
		.insert(yswsSubmissions)
		.values(submission)
		.returning();
	return result;
}

export async function getSubmissions() {
	return await db.select().from(yswsSubmissions).orderBy(desc(yswsSubmissions.createdAt));
}

export async function getSubmissionById(id: string) {
	const result = await db
		.select()
		.from(yswsSubmissions)
		.where(eq(yswsSubmissions.id, id))
		.limit(1);
	return result[0];
}

export async function updateSubmission(id: string, update: Partial<YswsSubmission>) {
	const [result] = await db
		.update(yswsSubmissions)
		.set(update)
		.where(eq(yswsSubmissions.id, id))
		.returning();
	return result;
}

export async function approveSubmission(id: string, reviewerId: string, publicNotes?: string, privateNotes?: string) {
	const submission = await getSubmissionById(id);
	if (!submission) throw new Error("Submission not found");
	if (submission.status !== "pending") throw new Error("Submission already processed");

	const appSettings = await SettingsService.getAppSettings();
	const rewardBytes = submission.hoursSpent * appSettings.yswsQuotaPerHourBytes;

	// Transaction to update submission status and user quota
	await db.transaction(async (tx) => {
		// Update submission
		await tx
			.update(yswsSubmissions)
			.set({
				status: "approved",
				reviewedBy: reviewerId,
				reviewedAt: new Date(),
				adminNotesPublic: publicNotes,
				adminNotesPrivate: privateNotes,
			})
			.where(eq(yswsSubmissions.id, id));

		// Update user quota
		// We need to fetch the current user to get their current limit
		// However, UserService.updateUserStorageLimit updates the absolute limit, not adds to it.
		// Wait, UserService logic might be needed here.
		// Let's look at schema. users.storageLimitBytes is a number.
		// If it's null, it falls back to default.
		
		const user = await UserService.getUserById(submission.userId);
		if (!user) throw new Error("User not found");

		const currentLimit = user.storageLimitBytes ?? appSettings.defaultStorageLimitBytes;
		const newLimit = currentLimit + rewardBytes;

		await tx
			.update(users)
			.set({
				storageLimitBytes: newLimit,
			})
			.where(eq(users.id, submission.userId));
	});

	return { success: true, rewardBytes };
}

export async function rejectSubmission(id: string, reviewerId: string, publicNotes?: string, privateNotes?: string) {
	await db
		.update(yswsSubmissions)
		.set({
			status: "rejected",
			reviewedBy: reviewerId,
			reviewedAt: new Date(),
			adminNotesPublic: publicNotes,
			adminNotesPrivate: privateNotes,
		})
		.where(eq(yswsSubmissions.id, id));
	
	return { success: true };
}

export const YswsService = {
	createSubmission,
	getSubmissions,
	getSubmissionById,
	updateSubmission,
	approveSubmission,
	rejectSubmission,
};
