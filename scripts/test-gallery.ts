
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { YswsService } from "../src/services/ysws-service";
import { db } from "../src/db";
import { yswsSubmissions, users } from "../src/db/schema";
import { eq } from "drizzle-orm";

describe("YSWS Gallery Functionality", () => {
    let testUserId: string;

    beforeAll(async () => {
        // Create a test user
        const [user] = await db.insert(users).values({
            id: `test_user_${Date.now()}`,
            email: `test_${Date.now()}@example.com`,
            storageUsageBytes: 0,
            onboarded: true,
        }).returning();
        testUserId = user.id;

        // Create approved submission
        await YswsService.createSubmission({
            userId: testUserId,
            projectName: "Approved Project",
            shortDescription: "A great project",
            repoUrl: "https://github.com/test/repo",
            demoUrl: "https://test.com",
            hoursSpent: 10,
            usedAi: false,
            screenshotUrl: "https://example.com/screenshot.png",
            status: "approved",
            reviewedAt: new Date(),
        });

        // Create pending submission
        await YswsService.createSubmission({
            userId: testUserId,
            projectName: "Pending Project",
            shortDescription: "A wip project",
            repoUrl: "https://github.com/test/wip",
            demoUrl: "https://wip.com",
            hoursSpent: 5,
            usedAi: false,
            screenshotUrl: "https://example.com/wip.png",
            status: "pending",
        });
    });

    afterAll(async () => {
        // Cleanup
        await db.delete(yswsSubmissions).where(eq(yswsSubmissions.userId, testUserId));
        await db.delete(users).where(eq(users.id, testUserId));
    });

    it("should fetch only approved submissions for public gallery", async () => {
        const publicSubmissions = await YswsService.getPublicApprovedSubmissions();
        
        // Should contain "Approved Project"
        const approved = publicSubmissions.find(s => s.projectName === "Approved Project");
        expect(approved).toBeDefined();

        // Should NOT contain "Pending Project"
        const pending = publicSubmissions.find(s => s.projectName === "Pending Project");
        expect(pending).toBeUndefined();
    });

    it("should fetch all submissions for user view", async () => {
        // Mocking user fetch (simulating what happens in the route)
         const allSubmissions = await db
            .select()
            .from(yswsSubmissions)
            .where(eq(yswsSubmissions.userId, testUserId));

        expect(allSubmissions.length).toBeGreaterThanOrEqual(2);
        
        const approved = allSubmissions.find(s => s.projectName === "Approved Project");
        const pending = allSubmissions.find(s => s.projectName === "Pending Project");

        expect(approved).toBeDefined();
        expect(pending).toBeDefined();
    });
});
