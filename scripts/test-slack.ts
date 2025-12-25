import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { buckets, users } from "../src/db/schema";
import { handleMessage } from "../src/features/slack/message-handler";

// Mock config
const _mockConfig = {
	s3Domain: "localhost:3000",
	slack: {
		botToken: "mock-token",
	},
};

// Mock fetch
const originalFetch = global.fetch;
// @ts-expect-error
global.fetch = async (url: string | Request | URL, init?: RequestInit) => {
	const urlStr = url.toString();
	if (urlStr.includes("slack.com/api/chat.postMessage")) {
		console.log("[Mock Slack] Post Message:", JSON.parse(init?.body as string));
		return new Response(JSON.stringify({ ok: true }));
	}
	if (urlStr.includes("files.slack.com")) {
		console.log("[Mock Slack] Download File:", urlStr);
		return new Response(new ArrayBuffer(1024)); // 1KB file
	}
	return originalFetch(url, init);
};

// Mock S3 Client
const mockS3Client = {
	fetch: async (path: string, init: any) => {
		console.log(`[Mock S3] ${init.method} ${path}`);
		return new Response("OK", { status: 200 });
	},
};

// Monkey patch s3Client
import { s3Client } from "../src/lib/s3-client";

// @ts-expect-error
s3Client.fetch = mockS3Client.fetch;

async function runTest() {
	console.log("Running Slack Integration Test...");

	// 1. Setup User
	const slackId = "U123456";
	const userId = "test-user-slack";
	await db
		.insert(users)
		.values({
			id: userId,
			email: "test-slack@example.com",
			slackId: slackId,
			storageLimitBytes: 1024 * 1024 * 100, // 100MB
		})
		.onConflictDoNothing();

	// 2. Mock Event
	const event = {
		type: "message",
		user: slackId,
		channel: "C123456",
		files: [
			{
				name: "test-image.png",
				size: 1024,
				url_private_download: "https://files.slack.com/test-image.png",
				mimetype: "image/png",
			},
		],
	};

	// 3. Run Handler
	await handleMessage(event);

	// 4. Verify Bucket Created
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, slackId.toLowerCase()))
		.limit(1);

	if (bucket.length > 0) {
		console.log("✅ CDN Bucket created:", bucket[0].name);
		if (bucket[0].isCdn) {
			console.log("✅ Bucket marked as CDN");
		} else {
			console.error("❌ Bucket NOT marked as CDN");
		}
	} else {
		console.error("❌ CDN Bucket not created");
	}

	// 5. Cleanup
	await db.delete(buckets).where(eq(buckets.userId, userId));
	await db.delete(users).where(eq(users.id, userId));

	console.log("Test Complete.");
}

runTest().catch(console.error);
