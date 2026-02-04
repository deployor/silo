
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { YswsService } from "../src/services/ysws-service";
import { db } from "../src/db";
import { yswsSubmissions, users } from "../src/db/schema";
import { eq } from "drizzle-orm";

describe("YSWS Gallery Final Verification", () => {
    let testUserId: string;

    beforeAll(async () => {
        // Create a test user
        const [user] = await db.insert(users).values({
            id: `final_verify_user_${Date.now()}`,
            email: `final_verify_${Date.now()}@example.com`,
            storageUsageBytes: 0,
            onboarded: true,
        }).returning();
        testUserId = user.id;

        // Create approved submission
        await YswsService.createSubmission({
            userId: testUserId,
            projectName: "Final Verify Approved",
            shortDescription: "A verified project",
            repoUrl: "https://github.com/test/repo",
            demoUrl: "https://test.com",
            hoursSpent: 10,
            usedAi: false,
            screenshotUrl: "https://example.com/screenshot.png",
            status: "approved",
            reviewedAt: new Date(),
        });
    });

    afterAll(async () => {
        // Cleanup
        await db.delete(yswsSubmissions).where(eq(yswsSubmissions.userId, testUserId));
        await db.delete(users).where(eq(users.id, testUserId));
    });

    it("should fetch approved submissions for gallery", async () => {
        const publicSubmissions = await YswsService.getPublicApprovedSubmissions();
        const approved = publicSubmissions.find(s => s.projectName === "Final Verify Approved");
        expect(approved).toBeDefined();
    });
});
