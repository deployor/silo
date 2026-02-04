
import { test, expect } from "bun:test";
import { YswsService } from "../src/services/ysws-service";
import { db } from "../src/db";
import { yswsSubmissions } from "../src/db/schema";
import { eq } from "drizzle-orm";

test("Can retrieve all submissions for a user", async () => {
    // 1. Create a dummy user ID (we don't strictly need a user record for this DB integration test if foreign keys aren't enforced, 
    //    but let's assume we can just use a random string if FKs are loose or we mock DB. 
    //    Actually, we are running against real DB in these tests usually, so we might need a user.
    //    Let's check if we can insert directly.)
    
    const userId = "test-user-" + Math.random().toString(36).substring(7);
    
    // We need to insert a user first if FKs are enforced.
    // However, looking at previous tests, we might just be able to rely on the service logic.
    // But let's look at `ysws-service.ts`. It doesn't have a 'getSubmissionsByUserId'. 
    // The retrieval logic is in `src/web/ysws/index.ts` directly via DB query.
    // So we should verify that query logic here.
    
    const submission1 = {
        userId,
        projectName: "Pending Project",
        shortDescription: "A pending one",
        repoUrl: "https://github.com/test/1",
        demoUrl: "https://test1.com",
        hoursSpent: 10,
        usedAi: false,
        status: "pending",
        screenshotUrl: "http://example.com/1.png",
        readmeConfirmed: true
    };
    
    const submission2 = {
        userId,
        projectName: "Approved Project",
        shortDescription: "An approved one",
        repoUrl: "https://github.com/test/2",
        demoUrl: "https://test2.com",
        hoursSpent: 5,
        usedAi: false,
        status: "approved",
        screenshotUrl: "http://example.com/2.png",
        readmeConfirmed: true,
        reviewedAt: new Date()
    };

     const submission3 = {
        userId,
        projectName: "Rejected Project",
        shortDescription: "A rejected one",
        repoUrl: "https://github.com/test/3",
        demoUrl: "https://test3.com",
        hoursSpent: 2,
        usedAi: false,
        status: "rejected",
        screenshotUrl: "http://example.com/3.png",
        readmeConfirmed: true,
        reviewedAt: new Date()
    };

    // Insert directly to bypass service constraints if any
    await db.insert(yswsSubmissions).values(submission1 as any);
    await db.insert(yswsSubmissions).values(submission2 as any);
    await db.insert(yswsSubmissions).values(submission3 as any);

    // Now simulate the query from `src/web/ysws/index.ts`
    const userSubmissions = await db
        .select()
        .from(yswsSubmissions)
        .where(eq(yswsSubmissions.userId, userId));
        
    expect(userSubmissions.length).toBe(3);
    expect(userSubmissions.find(s => s.status === 'pending')).toBeDefined();
    expect(userSubmissions.find(s => s.status === 'approved')).toBeDefined();
    expect(userSubmissions.find(s => s.status === 'rejected')).toBeDefined();
    
    // Clean up
    await db.delete(yswsSubmissions).where(eq(yswsSubmissions.userId, userId));
});
