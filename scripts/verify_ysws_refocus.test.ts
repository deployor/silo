
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { YswsService } from "../src/services/ysws-service";
import { db } from "../src/db";
import { users, yswsSubmissions } from "../src/db/schema";
import { eq } from "drizzle-orm";

// Mock user for testing
const MOCK_USER = {
    id: "test-user-refocus",
    email: "test-refocus@example.com",
    storageLimitBytes: 1073741824, // 1GB
    storageUsageBytes: 0,
    onboarded: true,
};

describe("YSWS Refocus Verification", () => {
    beforeAll(async () => {
        // Clean up any existing test data
        await db.delete(yswsSubmissions).where(eq(yswsSubmissions.userId, MOCK_USER.id));
        await db.delete(users).where(eq(users.id, MOCK_USER.id));

        // Create mock user
        await db.insert(users).values(MOCK_USER);
    });

    afterAll(async () => {
        // Clean up test data
        await db.delete(yswsSubmissions).where(eq(yswsSubmissions.userId, MOCK_USER.id));
        await db.delete(users).where(eq(users.id, MOCK_USER.id));
    });

    test("should fetch submissions by user ID correctly", async () => {
        // Create a submission
        const submission = {
            userId: MOCK_USER.id,
            projectName: "Test Project",
            shortDescription: "A test project",
            repoUrl: "https://github.com/test/test",
            demoUrl: "https://test.com",
            hoursSpent: 10,
            status: "pending",
        };

        await YswsService.createSubmission(submission);

        // Fetch submissions
        const submissions = await YswsService.getSubmissionsByUserId(MOCK_USER.id);

        expect(submissions).toBeDefined();
        expect(submissions.length).toBeGreaterThan(0);
        expect(submissions[0].projectName).toBe("Test Project");
        expect(submissions[0].userId).toBe(MOCK_USER.id);
    });

    test("dashboard view logic should receive latest submission", async () => {
         // Create another submission (newer)
         const newerSubmission = {
            userId: MOCK_USER.id,
            projectName: "Newer Project",
            shortDescription: "A newer test project",
            repoUrl: "https://github.com/test/newer",
            demoUrl: "https://newer.com",
            hoursSpent: 5,
            status: "approved",
        };
        await YswsService.createSubmission(newerSubmission);

        // Fetch again, should get the newer one first because of ordering
        const submissions = await YswsService.getSubmissionsByUserId(MOCK_USER.id);
        
        expect(submissions.length).toBeGreaterThan(1);
        expect(submissions[0].projectName).toBe("Newer Project");
    });
});
