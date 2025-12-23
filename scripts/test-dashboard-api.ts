
import { db } from "../src/db";
import { users } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { handleDashboardRequest } from "../src/features/landing/index";

async function testDashboardStats() {
    console.log("Testing Dashboard Stats API...");

    // 1. Setup a test user
    const testUserId = "test-dashboard-user";
    await db.delete(users).where(eq(users.id, testUserId));
    await db.insert(users).values({
        id: testUserId,
        email: "test-dashboard@example.com",
        storageLimitBytes: 1024 * 1024 * 1024, // 1GB
        egressLimitBytes: null, // Default
    });

    // Mock Request
    const req = new Request("http://localhost/api/dashboard/stats", {
        headers: {
            "Cookie": `cargo_user_id=${testUserId}`
        }
    });

    // 2. Test Default Egress
    console.log("Checking Default Egress...");
    let res = await handleDashboardRequest(req);
    let data = await res.json();
    
    if (data.user.egressLimit !== null) {
        console.error("FAILED: Expected egressLimit to be null (Default), got:", data.user.egressLimit);
    } else {
        console.log("PASSED: Default egressLimit is null");
    }

    // 3. Test Unlimited Egress
    console.log("Checking Unlimited Egress...");
    await db.update(users).set({ egressLimitBytes: -1 }).where(eq(users.id, testUserId));
    
    res = await handleDashboardRequest(req);
    data = await res.json();

    if (data.user.egressLimit !== -1) {
        console.error("FAILED: Expected egressLimit to be -1 (Unlimited), got:", data.user.egressLimit);
    } else {
        console.log("PASSED: Unlimited egressLimit is -1");
    }

    // 4. Test Custom Egress
    console.log("Checking Custom Egress...");
    const customLimit = 5 * 1024 * 1024 * 1024; // 5GB
    await db.update(users).set({ egressLimitBytes: customLimit }).where(eq(users.id, testUserId));

    res = await handleDashboardRequest(req);
    data = await res.json();

    if (data.user.egressLimit !== customLimit) {
        console.error(`FAILED: Expected egressLimit to be ${customLimit}, got:`, data.user.egressLimit);
    } else {
        console.log("PASSED: Custom egressLimit is correct");
    }

    // Cleanup
    await db.delete(users).where(eq(users.id, testUserId));
    console.log("Done.");
}

testDashboardStats();
