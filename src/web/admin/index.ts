import { randomBytes } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { config } from "../../config";
import { deleteBucketContents, getInternalPath } from "../../core/s3/utils";
import { db } from "../../db";
import {
	bucketKeys,
	buckets,
	requestLogs,
	sessions,
	users,
} from "../../db/schema";
import { jsonResponse } from "../../lib/api-utils";
import { getDiskCacheStats } from "../../lib/disk-cache";
import { redis } from "../../lib/redis";
import { s3Client } from "../../lib/s3-client";
import { getCurrentUser } from "../../lib/session";
import { render } from "../../lib/view-engine";
import {
	getAppSettings,
	updateAppSettings,
} from "../../services/settings-service";
import { handleAdminRedemptionsRequest } from "../redemptions";
import { handleAdminYswsRequest } from "./ysws";

function secureFlag(): string {
	return config.isProduction ? "; Secure" : "";
}

type AdminUpdateUserQuotaBody = {
	storageLimitBytes?: unknown;
	egressLimitBytes?: unknown;
};

type S3ListContentsItem = {
	Key: string;
	Size: number;
};

// --- Handlers ---

async function serveAdminUsersPage(req: Request) {
	const user = await getCurrentUser(req);
	const html = await render("admin-users", {
		title: "Admin Users",
		user,
		pageTitle: "ADMIN",
	});
	return new Response(html, {
		headers: { "Content-Type": "text/html" },
	});
}

async function serveAdminBucketsPage(req: Request) {
	const user = await getCurrentUser(req);
	const html = await render("admin-buckets", {
		title: "Admin Buckets",
		user,
		pageTitle: "ADMIN",
	});
	return new Response(html, {
		headers: { "Content-Type": "text/html" },
	});
}

async function serveAdminSpeedtestPage(req: Request) {
	const user = await getCurrentUser(req);
	const html = await render("admin-speedtest", {
		title: "Admin Speed Test",
		user,
		pageTitle: "ADMIN",
	});
	return new Response(html, {
		headers: { "Content-Type": "text/html" },
	});
}

async function serveAdminLogsPage(req: Request) {
	const user = await getCurrentUser(req);
	const html = await render("admin-logs", {
		title: "Admin Logs",
		user,
		pageTitle: "ADMIN",
	});
	return new Response(html, {
		headers: { "Content-Type": "text/html" },
	});
}

async function serveAdminSettingsPage(req: Request) {
	const user = await getCurrentUser(req);
	const html = await render("admin-settings", {
		title: "Admin Settings",
		user,
		pageTitle: "ADMIN",
	});
	return new Response(html, {
		headers: { "Content-Type": "text/html" },
	});
}

async function serveAdminCachePage(req: Request) {
	const user = await getCurrentUser(req);
	const html = await render("admin-cache", {
		title: "Cache - Admin",
		user,
		pageTitle: "ADMIN",
	});
	return new Response(html, {
		headers: { "Content-Type": "text/html" },
	});
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d > 0) return `${d}d ${h}h ${m}m`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function parseRedisInfo(info: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of info.split("\r\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			result[line.slice(0, idx)] = line.slice(idx + 1);
		}
	}
	return result;
}

async function getCacheStatsJson() {
	// Get Redis INFO
	const redisInfo = await redis.info();
	const redisDbSize = await redis.dbsize();
	const info = parseRedisInfo(redisInfo);

	// Key breakdown by prefix using SCAN
	const prefixes = ["s3:meta:", "s3:obj:", "auth:", "stats:", "rl:"];
	const keyBreakdown: Array<{ name: string; count: number }> = [];
	for (const prefix of prefixes) {
		let cursor = "0";
		let count = 0;
		do {
			const [nextCursor, keys] = await redis.scan(
				cursor,
				"MATCH",
				`${prefix}*`,
				"COUNT",
				1000,
			);
			cursor = nextCursor;
			count += keys.length;
		} while (cursor !== "0");
		keyBreakdown.push({ name: `${prefix}*`, count });
	}

	// Get disk cache stats
	const diskStats = getDiskCacheStats();

	// Redis hit/miss
	const hits = Number.parseInt(info.keyspace_hits || "0", 10);
	const misses = Number.parseInt(info.keyspace_misses || "0", 10);
	const hitRate =
		hits + misses > 0
			? `${((hits / (hits + misses)) * 100).toFixed(1)}%`
			: "N/A";

	const uptimeSeconds = Number.parseInt(info.uptime_in_seconds || "0", 10);

	const capacityPercent =
		diskStats.maxTotalSizeBytes > 0
			? (
					(diskStats.totalSizeBytes / diskStats.maxTotalSizeBytes) *
					100
				).toFixed(1)
			: "0";

	// Get S3 circuit breaker state
	const circuit = s3Client.getCircuitState();

	return {
		redis: {
			keyCount: redisDbSize,
			memoryUsed: info.used_memory_human || "-",
			hitRate,
			uptime: formatUptime(uptimeSeconds),
			connectedClients: info.connected_clients || "-",
			keyBreakdown,
		},
		disk: {
			fileCount: diskStats.entryCount,
			currentSize: formatBytes(diskStats.totalSizeBytes),
			maxSize: formatBytes(diskStats.maxTotalSizeBytes),
			capacityPercent: `${capacityPercent}%`,
			capacityPercentNum: Number.parseFloat(capacityPercent),
			admissionThreshold: diskStats.currentAdmissionThreshold,
			topHotObjects: diskStats.topHotObjects,
		},
		system: {
			circuitState: circuit.state,
			circuitFailures: circuit.failures,
			uptime: formatUptime(Math.floor(process.uptime())),
		},
	};
}

async function listUsers(url: URL, user: typeof users.$inferSelect) {
	const limit = Number.parseInt(url.searchParams.get("limit") || "50", 10);
	const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
	const search = url.searchParams.get("search");
	const adminsOnly = url.searchParams.get("adminsOnly") === "true";

	const filters = [];
	if (search) {
		filters.push(
			or(
				ilike(users.email, `%${search}%`),
				ilike(users.id, `%${search}%`),
				ilike(users.slackId, `%${search}%`),
			),
		);
	}
	if (adminsOnly) {
		filters.push(eq(users.isAdmin, true));
	}

	const conditions = filters.length > 0 ? and(...filters) : undefined;

	const usersQuery = db
		.select({
			id: users.id,
			email: users.email,
			slackId: users.slackId,
			storageLimitBytes: users.storageLimitBytes,
			storageUsageBytes:
				sql<number>`COALESCE(sum(${buckets.totalBytes}), 0)`.mapWith(Number),
			egressLimitBytes: users.egressLimitBytes,
			ingressBytes: users.ingressBytes,
			egressBytes: users.egressBytes,
			totalRequests: users.totalRequests,
			createdAt: users.createdAt,
			updatedAt: users.updatedAt,
			isAdmin: users.isAdmin,
			isReviewer: users.isReviewer,
			isImmortal: users.isImmortal,
			isLocked: users.isLocked,
			lockReason: users.lockReason,
			markedAsOverAge: users.markedAsOverAge,
			dataExported: users.dataExported,
			filesDeleted: users.filesDeleted,
			overAgeGracePeriodEndsAt: users.overAgeGracePeriodEndsAt,
		})
		.from(users)
		.leftJoin(buckets, eq(users.id, buckets.userId))
		.limit(limit)
		.offset(offset)
		.groupBy(users.id);

	if (conditions) {
		usersQuery.where(conditions);
	}

	const allUsers = await usersQuery;

	// Count
	let total = 0;
	if (conditions) {
		const countRes = await db
			.select({ count: sql<number>`count(*)` })
			.from(users)
			.where(conditions);
		total = Number(countRes[0].count);
	} else {
		const countRes = await db
			.select({ count: sql<number>`count(*)` })
			.from(users);
		total = Number(countRes[0].count);
	}

	return new Response(
		JSON.stringify({
			admin: { id: user.id, slackId: user.slackId },
			users: allUsers,
			total,
			limit,
			offset,
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

async function getUserBuckets(userId: string) {
	const userBuckets = await db
		.select()
		.from(buckets)
		.where(eq(buckets.userId, userId));
	return new Response(JSON.stringify(userBuckets), {
		headers: { "Content-Type": "application/json" },
	});
}

async function listAdminBuckets(url: URL) {
	const limit = Number.parseInt(url.searchParams.get("limit") || "50", 10);
	const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
	const search = url.searchParams.get("search")?.trim();
	const pausedOnly = url.searchParams.get("pausedOnly") === "true";
	const sortBy = url.searchParams.get("sortBy") || "totalRequests";
	const sortOrder =
		url.searchParams.get("sortOrder") === "asc" ? "asc" : "desc";

	const filters = [];
	if (search) {
		filters.push(
			or(
				ilike(buckets.name, `%${search}%`),
				ilike(users.email, `%${search}%`),
				ilike(users.id, `%${search}%`),
			),
		);
	}
	if (pausedOnly) {
		filters.push(eq(buckets.isPaused, true));
	}

	const conditions = filters.length > 0 ? and(...filters) : undefined;

	const orderFn = sortOrder === "asc" ? asc : desc;
	const orderBy = (() => {
		switch (sortBy) {
			case "name":
				return orderFn(buckets.name);
			case "totalBytes":
				return orderFn(buckets.totalBytes);
			case "egressBytes":
				return orderFn(
					sql<number>`COALESCE(sum(${requestLogs.egressBytes}), 0)`.mapWith(
						Number,
					),
				);
			case "getRequests":
				return orderFn(
					sql<number>`COALESCE(sum(case when ${requestLogs.method} = 'GET' then 1 else 0 end), 0)`.mapWith(
						Number,
					),
				);
			case "putRequests":
				return orderFn(
					sql<number>`COALESCE(sum(case when ${requestLogs.method} = 'PUT' then 1 else 0 end), 0)`.mapWith(
						Number,
					),
				);
			case "updatedAt":
				return orderFn(buckets.updatedAt);
			default:
				return orderFn(buckets.totalRequests);
		}
	})();

	const query = db
		.select({
			id: buckets.id,
			name: buckets.name,
			userId: buckets.userId,
			ownerEmail: users.email,
			ownerSlackId: users.slackId,
			isPaused: buckets.isPaused,
			pauseReason: buckets.pauseReason,
			isCdn: buckets.isCdn,
			totalBytes: buckets.totalBytes,
			totalRequests: buckets.totalRequests,
			getRequests:
				sql<number>`COALESCE(sum(case when ${requestLogs.method} = 'GET' then 1 else 0 end), 0)`.mapWith(
					Number,
				),
			putRequests:
				sql<number>`COALESCE(sum(case when ${requestLogs.method} = 'PUT' then 1 else 0 end), 0)`.mapWith(
					Number,
				),
			deleteRequests:
				sql<number>`COALESCE(sum(case when ${requestLogs.method} = 'DELETE' then 1 else 0 end), 0)`.mapWith(
					Number,
				),
			headRequests:
				sql<number>`COALESCE(sum(case when ${requestLogs.method} = 'HEAD' then 1 else 0 end), 0)`.mapWith(
					Number,
				),
			egressBytes:
				sql<number>`COALESCE(sum(${requestLogs.egressBytes}), 0)`.mapWith(
					Number,
				),
			ingressBytes:
				sql<number>`COALESCE(sum(${requestLogs.ingressBytes}), 0)`.mapWith(
					Number,
				),
			updatedAt: buckets.updatedAt,
			createdAt: buckets.createdAt,
		})
		.from(buckets)
		.leftJoin(users, eq(buckets.userId, users.id))
		.leftJoin(requestLogs, eq(requestLogs.bucketName, buckets.name))
		.groupBy(buckets.id, users.id)
		.orderBy(orderBy)
		.limit(limit)
		.offset(offset);

	if (conditions) {
		query.where(conditions);
	}

	const rows = await query;

	const countQuery = db
		.select({ count: sql<number>`count(*)` })
		.from(buckets)
		.leftJoin(users, eq(buckets.userId, users.id));
	if (conditions) {
		countQuery.where(conditions);
	}
	const countRes = await countQuery;
	const total = Number(countRes[0]?.count || 0);

	return new Response(
		JSON.stringify({
			buckets: rows,
			total,
			limit,
			offset,
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

async function runAdminSpeedtest(req: Request) {
	const schema = z.object({
		bucketName: z.string().regex(/^[a-z0-9-]+$/),
		sizeMb: z.number().int().min(1).max(64).default(8),
		iterations: z.number().int().min(1).max(10).default(3),
	});

	const body = await req.json().catch(() => null);
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		return new Response(
			parsed.error.issues[0]?.message ?? "Invalid request body",
			{
				status: 400,
			},
		);
	}

	const { bucketName, sizeMb, iterations } = parsed.data;

	const bucket = await db
		.select({ id: buckets.id, name: buckets.name, isPaused: buckets.isPaused })
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);

	if (bucket.length === 0) {
		return new Response("Bucket not found", { status: 404 });
	}
	if (bucket[0].isPaused) {
		return new Response("Bucket is paused", { status: 400 });
	}

	const key = await db
		.select({
			accessKey: bucketKeys.accessKey,
			secretKey: bucketKeys.secretKey,
		})
		.from(bucketKeys)
		.where(eq(bucketKeys.bucketId, bucket[0].id))
		.limit(1);

	if (key.length === 0) {
		return new Response("Bucket has no API key to run speed test", {
			status: 400,
		});
	}

	const client = new AwsClient({
		accessKeyId: key[0].accessKey,
		secretAccessKey: key[0].secretKey,
		service: "s3",
		region: config.s3.region || "auto",
	});

	const payloadSizeBytes = sizeMb * 1024 * 1024;
	const payload = randomBytes(payloadSizeBytes);
	const runId = crypto.randomUUID().slice(0, 8);
	const baseUrl = `https://${config.s3Domain}`;

	const iterationsDetail: Array<{
		index: number;
		key: string;
		uploadMs: number;
		downloadColdMs: number;
		downloadWarmMs: number;
		warmCacheHeader: string | null;
	}> = [];

	let uploadMsTotal = 0;
	let downloadColdMsTotal = 0;
	let downloadWarmMsTotal = 0;
	let warmHitCount = 0;
	let warmMissCount = 0;

	for (let i = 0; i < iterations; i++) {
		const objectKey = `admin-speedtest/${runId}/iter-${i}.bin`;
		const objectUrl = `${baseUrl}/${bucketName}/${objectKey}`;

		const putStart = performance.now();
		const putRes = await client.fetch(objectUrl, {
			method: "PUT",
			body: payload,
			headers: {
				"content-type": "application/octet-stream",
				"x-amz-content-sha256": "UNSIGNED-PAYLOAD",
			},
		});
		const uploadMs = performance.now() - putStart;
		if (!putRes.ok) {
			const message = await putRes.text();
			return new Response(`Upload failed (${putRes.status}): ${message}`, {
				status: 500,
			});
		}

		const coldStart = performance.now();
		const coldRes = await client.fetch(objectUrl, { method: "GET" });
		const coldBody = await coldRes.arrayBuffer();
		const downloadColdMs = performance.now() - coldStart;
		if (!coldRes.ok || coldBody.byteLength !== payloadSizeBytes) {
			return new Response("Cold download failed or size mismatch", {
				status: 500,
			});
		}

		const warmStart = performance.now();
		const warmRes = await client.fetch(objectUrl, { method: "GET" });
		const warmBody = await warmRes.arrayBuffer();
		const downloadWarmMs = performance.now() - warmStart;
		if (!warmRes.ok || warmBody.byteLength !== payloadSizeBytes) {
			return new Response("Warm download failed or size mismatch", {
				status: 500,
			});
		}

		const cacheHeader = warmRes.headers.get("x-cache");
		if (cacheHeader?.toLowerCase().includes("hit")) {
			warmHitCount++;
		} else {
			warmMissCount++;
		}

		uploadMsTotal += uploadMs;
		downloadColdMsTotal += downloadColdMs;
		downloadWarmMsTotal += downloadWarmMs;

		iterationsDetail.push({
			index: i,
			key: objectKey,
			uploadMs,
			downloadColdMs,
			downloadWarmMs,
			warmCacheHeader: cacheHeader,
		});

		await client.fetch(objectUrl, { method: "DELETE" });
	}

	const latencyKey = iterationsDetail[0]?.key;
	const headSamplesMs: number[] = [];
	if (latencyKey) {
		const latencyUrl = `${baseUrl}/${bucketName}/${latencyKey}`;
		for (let i = 0; i < 5; i++) {
			const start = performance.now();
			const headRes = await client.fetch(latencyUrl, { method: "HEAD" });
			const elapsedMs = performance.now() - start;
			if (headRes.ok) headSamplesMs.push(elapsedMs);
		}
	}

	const sorted = [...headSamplesMs].sort((a, b) => a - b);
	const avgMs =
		headSamplesMs.length > 0
			? headSamplesMs.reduce((acc, n) => acc + n, 0) / headSamplesMs.length
			: 0;
	const p95Ms =
		sorted.length > 0
			? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ||
				0
			: 0;

	return jsonResponse({
		ok: true,
		result: {
			bucketName,
			sizeBytes: payloadSizeBytes,
			iterations,
			totals: {
				uploadMs: uploadMsTotal,
				downloadColdMs: downloadColdMsTotal,
				downloadWarmMs: downloadWarmMsTotal,
				putRequests: iterations,
				getRequests: iterations * 2,
				deleteRequests: iterations,
				bytesUp: payloadSizeBytes * iterations,
				bytesDown: payloadSizeBytes * iterations * 2,
			},
			latency: {
				headSamplesMs,
				avgMs,
				p95Ms,
			},
			cache: {
				warmHitCount,
				warmMissCount,
			},
			iterationsDetail,
		},
	});
}

async function updateUserQuota(userId: string, req: Request) {
	const body = (await req.json()) as AdminUpdateUserQuotaBody;
	const updateData: Partial<
		Pick<typeof users.$inferInsert, "storageLimitBytes" | "egressLimitBytes">
	> = {};

	if (typeof body.storageLimitBytes === "number") {
		updateData.storageLimitBytes = body.storageLimitBytes;
	}
	if (typeof body.egressLimitBytes === "number") {
		updateData.egressLimitBytes = body.egressLimitBytes;
	}

	if (Object.keys(updateData).length === 0) {
		return new Response("No valid quota fields", { status: 400 });
	}

	await db.update(users).set(updateData).where(eq(users.id, userId));
	return new Response("Updated", { status: 200 });
}

async function lockUser(userId: string, req: Request) {
	const body = await req.json();

	if (body.isLocked) {
		const user = await db
			.select({ isImmortal: users.isImmortal })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);

		if (user.length > 0 && user[0].isImmortal) {
			return new Response("User is immortal and cannot be locked", {
				status: 400,
			});
		}
	}

	await db
		.update(users)
		.set({ isLocked: body.isLocked, lockReason: body.lockReason || null })
		.where(eq(users.id, userId));
	return new Response("Updated", { status: 200 });
}

async function toggleUserReviewer(userId: string, req: Request) {
	const body = await req.json();
	await db
		.update(users)
		.set({ isReviewer: body.isReviewer })
		.where(eq(users.id, userId));
	return new Response("Updated", { status: 200 });
}

async function toggleUserImmortal(userId: string, req: Request) {
	const body = await req.json();
	await db
		.update(users)
		.set({ isImmortal: body.isImmortal })
		.where(eq(users.id, userId));
	return new Response("Updated", { status: 200 });
}

async function ageOutUser(userId: string, _req: Request) {
	const user = await db
		.select()
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (user.length === 0) return new Response("User not found", { status: 404 });

	if (user[0].isImmortal) {
		return new Response("User is immortal and cannot be aged out", {
			status: 400,
		});
	}

	if (user[0].markedAsOverAge) {
		return new Response("User is already marked as over-age", { status: 400 });
	}

	const gracePeriodEndsAt = new Date();
	gracePeriodEndsAt.setMonth(gracePeriodEndsAt.getMonth() + 2);

	await db
		.update(users)
		.set({
			markedAsOverAge: true,
			overAgeGracePeriodEndsAt: gracePeriodEndsAt,
		})
		.where(eq(users.id, userId));

	// Send Slack Notification
	if (user[0].slackId) {
		const { Header, Section, Button, Actions } = await import(
			"slack-block-builder"
		);
		const { config } = await import("../../config");

		const message = (await import("slack-block-builder"))
			.Message({
				channel: user[0].slackId,
				text: "Action Required: You have aged out of Silo",
			})
			.blocks(
				Header({ text: "It's time to move on from Silo." }),
				Section({
					text: "Hey there. Since you're 18 now, you've aged out of Silo. Hack Club is a space for teenagers, so we need you to move your files to another provider.",
				}),
				Section({
					text: `You have until *${gracePeriodEndsAt.toLocaleDateString()}* to migrate everything. After that, we'll permanently delete your files.\n\nWe've built an *super easy migration assistant* that can move your buckets directly to Cloudflare R2, AWS S3, or any other provider in minutes—no downloading required!`,
				}),
				Actions().elements(
					Button({
						text: "Migrate or Download Data",
						url: `https://${config.s3Domain}/dashboard/offboarding`,
						actionId: "open_export_portal",
					}).danger(),
				),
			)
			.buildToObject();

		// message-handler.ts exports postBlocks which is better for Block Kit
		// but wait, postBlocks takes (channel, blocks, ...)
		// The message object built by slack-block-builder is { channel, text, blocks }

		// Let's use fetch directly or the message-handler equivalent
		// postBlocks expects an array of blocks, not the whole message object

		const { postBlocks } = await import(
			"../../integrations/slack/message-handler"
		);
		await postBlocks(
			user[0].slackId,
			message.blocks || [], // Access blocks array from built object
			undefined, // threadTs
			undefined, // username
			undefined, // icon_url
			message.text, // fallback text
		);
	}

	return new Response("User marked as over-age", { status: 200 });
}

async function getBucketDetails(bucketName: string) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);

	if (bucket.length === 0) return new Response("Not Found", { status: 404 });

	const keys = await db
		.select()
		.from(bucketKeys)
		.where(eq(bucketKeys.bucketId, bucket[0].id));

	// List files from S3 (limit 50 for preview)
	let files: Array<{ key: string; size: number; url: string }> = [];
	try {
		let owner: (typeof users.$inferSelect)[] = [];
		if (bucket[0].userId) {
			owner = await db
				.select()
				.from(users)
				.where(eq(users.id, bucket[0].userId))
				.limit(1);
		}
		if (owner.length > 0) {
			const internalPrefix = getInternalPath("", owner[0], bucket[0]);
			const query = new URLSearchParams();
			query.set("list-type", "2");
			query.set("prefix", internalPrefix);
			query.set("max-keys", "50");

			const s3Res = await s3Client.fetch(`?${query.toString()}`, {
				method: "GET",
			});
			if (s3Res.ok) {
				const xml = await s3Res.text();
				const parser = new XMLParser();
				const result = parser.parse(xml).ListBucketResult;
				if (result.Contents) {
					const contents: S3ListContentsItem[] = Array.isArray(result.Contents)
						? (result.Contents as S3ListContentsItem[])
						: ([result.Contents] as S3ListContentsItem[]);
					files = contents.map((contentItem) => ({
						key: contentItem.Key.replace(internalPrefix, ""),
						size: contentItem.Size,
						url: `/api/admin/buckets/${bucketName}/files/preview?key=${encodeURIComponent(contentItem.Key.replace(internalPrefix, ""))}`,
					}));
				}
			}
		}
	} catch (e) {
		console.error("Failed to list files for admin", e);
	}

	return new Response(
		JSON.stringify({
			...bucket[0],
			keys,
			files,
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

async function previewFile(bucketName: string, url: URL) {
	const key = url.searchParams.get("key");
	if (!key) return new Response("Missing key", { status: 400 });

	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);
	if (bucket.length === 0) return new Response("Not Found", { status: 404 });

	if (!bucket[0].userId)
		return new Response("Owner not found", { status: 404 });

	const owner = await db
		.select()
		.from(users)
		.where(eq(users.id, bucket[0].userId))
		.limit(1);
	if (owner.length === 0)
		return new Response("Owner not found", { status: 404 });

	const internalKey = getInternalPath(key, owner[0], bucket[0]);

	try {
		const s3Res = await s3Client.fetch(internalKey, { method: "GET" });
		if (!s3Res.ok) return new Response(s3Res.body, { status: s3Res.status });

		const headers = new Headers(s3Res.headers);
		headers.set("Content-Disposition", "inline");
		return new Response(s3Res.body, {
			status: s3Res.status,
			headers,
		});
	} catch (_e) {
		return new Response("Error fetching file", { status: 500 });
	}
}

async function pauseBucket(bucketName: string, req: Request) {
	const body = await req.json();
	await db
		.update(buckets)
		.set({ isPaused: body.isPaused, pauseReason: body.pauseReason || null })
		.where(eq(buckets.name, bucketName));
	return new Response("Updated", { status: 200 });
}

async function resetBucketCors(bucketName: string) {
	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);

	if (bucket.length > 0 && bucket[0].isCdn) {
		return new Response("Cannot change CORS of CDN bucket", { status: 403 });
	}

	await db
		.update(buckets)
		.set({ corsConfig: null })
		.where(eq(buckets.name, bucketName));
	return new Response("Reset", { status: 200 });
}

async function deleteBucket(bucketName: string, url: URL) {
	const isReset = url.searchParams.get("reset") === "true";

	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);

	if (bucket.length > 0) {
		let owner: (typeof users.$inferSelect)[] = [];
		if (bucket[0].userId) {
			owner = await db
				.select()
				.from(users)
				.where(eq(users.id, bucket[0].userId))
				.limit(1);
		}

		if (owner.length > 0) {
			// CDN Bucket Handling
			if (bucket[0].isCdn) {
				if (!isReset) {
					return new Response(
						"Cannot delete CDN bucket. Use reset to empty it.",
						{ status: 403 },
					);
				}

				// Reset: Empty bucket but don't delete it
				const internalPrefix = getInternalPath("", owner[0], bucket[0]);
				try {
					await deleteBucketContents(internalPrefix);

					// Reset usage stats
					await db
						.update(buckets)
						.set({ totalBytes: 0, totalRequests: 0 })
						.where(eq(buckets.id, bucket[0].id));

					return new Response("Reset", { status: 200 });
				} catch (e) {
					console.error("Failed to reset CDN bucket:", e);
					return new Response("Failed to reset bucket", { status: 500 });
				}
			}

			// Normal Bucket Deletion or Emptying
			if (isReset) {
				// Just empty, don't delete
				const internalPrefix = getInternalPath("", owner[0], bucket[0]);
				try {
					await deleteBucketContents(internalPrefix);

					// Reset usage stats (bytes only, keep requests?)
					await db
						.update(buckets)
						.set({ totalBytes: 0 })
						.where(eq(buckets.id, bucket[0].id));

					return new Response("Emptied", { status: 200 });
				} catch (e) {
					console.error("Failed to empty bucket:", e);
					return new Response("Failed to empty bucket", { status: 500 });
				}
			}

			const internalPrefix = getInternalPath("", owner[0], bucket[0]);
			try {
				await deleteBucketContents(internalPrefix);
			} catch (e) {
				console.error("Failed to empty bucket during admin delete:", e);
			}
		}
	}

	await db.delete(buckets).where(eq(buckets.name, bucketName));
	return new Response("Deleted", { status: 200 });
}

async function pauseKey(keyId: string, req: Request) {
	const body = await req.json();
	await db
		.update(bucketKeys)
		.set({ isPaused: body.isPaused, pauseReason: body.pauseReason || null })
		.where(eq(bucketKeys.id, keyId));
	return new Response("Updated", { status: 200 });
}

async function deleteKey(keyId: string) {
	await db.delete(bucketKeys).where(eq(bucketKeys.id, keyId));
	return new Response("Deleted", { status: 200 });
}

async function deleteFile(bucketName: string, url: URL) {
	const key = url.searchParams.get("key");
	if (!key) return new Response("Missing key", { status: 400 });

	const bucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, bucketName))
		.limit(1);
	if (bucket.length > 0) {
		let owner: (typeof users.$inferSelect)[] = [];
		if (bucket[0].userId) {
			owner = await db
				.select()
				.from(users)
				.where(eq(users.id, bucket[0].userId))
				.limit(1);
		}
		if (owner.length > 0) {
			const internalKey = getInternalPath(key, owner[0], bucket[0]);

			// Get file size first to update quota
			try {
				const headRes = await s3Client.fetch(internalKey, { method: "HEAD" });
				const size = Number(headRes.headers.get("content-length") || 0);

				await s3Client.fetch(internalKey, { method: "DELETE" });

				if (size > 0) {
					await db
						.update(buckets)
						.set({
							totalBytes: sql`${buckets.totalBytes} - ${size}`,
						})
						.where(eq(buckets.id, bucket[0].id));
				}
			} catch (e) {
				console.error("Failed to delete file (admin):", e);
			}
		}
	}
	return new Response("Deleted", { status: 200 });
}

async function listLogs(url: URL) {
	const limit = Number.parseInt(url.searchParams.get("limit") || "50", 10);
	const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
	const search = url.searchParams.get("search");
	const bucketFilter = url.searchParams.get("bucket");
	const methodFilter = url.searchParams.get("method");
	const statusFilter = url.searchParams.get("status");
	const ipFilter = url.searchParams.get("ip");
	const sortBy = url.searchParams.get("sortBy") || "createdAt";
	const sortOrder = url.searchParams.get("sortOrder") || "desc";

	const filters = [];

	if (search) {
		filters.push(
			or(
				ilike(requestLogs.path, `%${search}%`),
				ilike(requestLogs.method, `%${search}%`),
				ilike(requestLogs.bucketName, `%${search}%`),
				ilike(users.email, `%${search}%`),
				ilike(requestLogs.userAgent, `%${search}%`),
				ilike(requestLogs.ipAddress, `%${search}%`),
				ilike(requestLogs.requesterId, `%${search}%`),
				// Cast status code to text for search
				sql`CAST(${requestLogs.statusCode} AS TEXT) ILIKE ${`%${search}%`}`,
			),
		);
	}

	if (bucketFilter) {
		filters.push(eq(requestLogs.bucketName, bucketFilter));
	}
	if (methodFilter) {
		filters.push(eq(requestLogs.method, methodFilter));
	}
	if (statusFilter) {
		filters.push(eq(requestLogs.statusCode, Number.parseInt(statusFilter, 10)));
	}
	if (ipFilter) {
		filters.push(eq(requestLogs.ipAddress, ipFilter));
	}

	const conditions = filters.length > 0 ? and(...filters) : undefined;

	const orderFn = sortOrder === "asc" ? asc : desc;
	const orderBy = (() => {
		switch (sortBy) {
			case "latencyMs":
				return orderFn(requestLogs.latencyMs);
			case "ingressBytes":
				return orderFn(requestLogs.ingressBytes);
			case "egressBytes":
				return orderFn(requestLogs.egressBytes);
			case "statusCode":
				return orderFn(requestLogs.statusCode);
			default:
				return orderFn(requestLogs.createdAt);
		}
	})();

	const logsQuery = db
		.select({
			id: requestLogs.id,
			method: requestLogs.method,
			path: requestLogs.path,
			statusCode: requestLogs.statusCode,
			latencyMs: requestLogs.latencyMs,
			createdAt: requestLogs.createdAt,
			bucketName: requestLogs.bucketName,
			ownerEmail: users.email,
			ipAddress: requestLogs.ipAddress,
			ingressBytes: requestLogs.ingressBytes,
			egressBytes: requestLogs.egressBytes,
			userAgent: requestLogs.userAgent,
			requesterId: requestLogs.requesterId,
			requestId: requestLogs.id,
		})
		.from(requestLogs)
		.leftJoin(users, eq(requestLogs.ownerId, users.id))
		.orderBy(orderBy)
		.limit(limit)
		.offset(offset);

	if (conditions) {
		logsQuery.where(conditions);
	}

	const logs = await logsQuery;

	let total = 0;
	if (conditions) {
		const countRes = await db
			.select({ count: sql<number>`count(*)` })
			.from(requestLogs)
			.leftJoin(users, eq(requestLogs.ownerId, users.id))
			.where(conditions);
		total = Number(countRes[0].count);
	} else {
		const countRes = await db
			.select({ count: sql<number>`count(*)` })
			.from(requestLogs);
		total = Number(countRes[0].count);
	}

	return new Response(
		JSON.stringify({
			logs,
			total,
			limit,
			offset,
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

// --- Main Handler ---

export async function handleAdminRequest(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	const url = new URL(req.url);

	if (!user) {
		return new Response(null, {
			status: 302,
			headers: {
				Location: `/auth/login?next=${encodeURIComponent(url.pathname)}`,
			},
		});
	}

	const path = url.pathname;

	// YSWS reviewers can access YSWS admin
	if (path.startsWith("/admin/ysws")) {
		if (!user.isAdmin && !user.isReviewer) {
			return new Response("Forbidden", { status: 403 });
		}
		return handleAdminYswsRequest(req, user);
	}

	if (!user.isAdmin) {
		return new Response("Forbidden", { status: 403 });
	}

	// Admin UI Pages
	// Keep /admin as a convenience redirect to the Users page.
	if (path === "/admin" || path === "/admin/") {
		return new Response(null, {
			status: 302,
			headers: { Location: "/admin/users" },
		});
	}

	if (path.startsWith("/admin/redemptions")) {
		return handleAdminRedemptionsRequest(req, user);
	}

	if (path === "/admin/users") {
		return serveAdminUsersPage(req);
	}
	if (path === "/admin/buckets") {
		return serveAdminBucketsPage(req);
	}
	if (path === "/admin/speedtest") {
		return serveAdminSpeedtestPage(req);
	}
	if (path === "/admin/logs") {
		return serveAdminLogsPage(req);
	}
	if (path === "/admin/settings") {
		return serveAdminSettingsPage(req);
	}
	if (path === "/admin/cache") {
		return serveAdminCachePage(req);
	}

	// API Routes
	if (path.startsWith("/api/admin/")) {
		if (!user.isAdmin) {
			return new Response("Forbidden", { status: 403 });
		}

		// Cache stats API
		if (path === "/api/admin/cache-stats" && req.method === "GET") {
			try {
				const stats = await getCacheStatsJson();
				return new Response(JSON.stringify(stats), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (e) {
				console.error("Failed to get cache stats:", e);
				return new Response(
					JSON.stringify({ error: "Failed to get cache stats" }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
		}

		// Start impersonation (admin-only): switches current session into impersonation mode.
		// Behavior: always 30 minutes, no user-selectable TTL.
		if (path === "/api/admin/impersonate" && req.method === "POST") {
			try {
				const body = await req.json();
				const targetUserId = body?.userId;
				if (!targetUserId || typeof targetUserId !== "string") {
					return new Response("Missing userId", { status: 400 });
				}

				const ttlMs = 30 * 60_000;
				const impersonationExpiresAt = new Date(Date.now() + ttlMs);

				// Read the current cookie session id
				const cookieHeader = req.headers.get("Cookie") || "";
				const cookies = cookieHeader.split(";").reduce(
					(acc, cookie) => {
						const [key, value] = cookie.trim().split("=");
						if (key && value) acc[key] = value;
						return acc;
					},
					{} as Record<string, string>,
				);

				const sessionId = cookies.silo_session;
				if (!sessionId) return new Response("No session", { status: 401 });

				// Ensure target exists
				const target = await db
					.select({ id: users.id })
					.from(users)
					.where(eq(users.id, targetUserId))
					.limit(1);

				if (target.length === 0)
					return new Response("User not found", { status: 404 });

				// Best-practice: keep session owner in sessions.userId; store impersonation overlay separately.
				await db
					.update(sessions)
					.set({
						impersonatorUserId: user.id,
						impersonatedUserId: targetUserId,
						impersonationExpiresAt,
					})
					.where(eq(sessions.id, sessionId));

				// Audit log (very lightweight; will show up in Admin Logs)
				await db.insert(requestLogs).values({
					bucketId: null,
					bucketName: null,
					ownerId: targetUserId,
					requesterId: user.id,
					method: "ADMIN",
					path: `impersonate:start:${targetUserId}`,
					statusCode: 200,
					ingressBytes: 0,
					egressBytes: 0,
					ipAddress:
						req.headers.get("x-forwarded-for") ||
						req.headers.get("cf-connecting-ip") ||
						"unknown",
					userAgent: req.headers.get("user-agent") || "Admin",
					latencyMs: 0,
				});

				const headers = new Headers({ "Content-Type": "application/json" });
				// Non-HttpOnly flag used only for UI label changes.
				headers.append(
					"Set-Cookie",
					`silo_impersonating=true; Path=/; SameSite=Lax${secureFlag()}; Max-Age=1800`,
				);

				return new Response(
					JSON.stringify({
						ok: true,
						userId: targetUserId,
						expiresAt: impersonationExpiresAt.toISOString(),
					}),
					{ headers },
				);
			} catch (e) {
				console.error("Failed to start impersonation", e);
				return new Response("Failed", { status: 500 });
			}
		}

		// Stop impersonation (admin-only): removes impersonation overlay from the current session.
		if (path === "/api/admin/impersonate" && req.method === "DELETE") {
			try {
				const cookieHeader = req.headers.get("Cookie") || "";
				const cookies = cookieHeader.split(";").reduce(
					(acc, cookie) => {
						const [key, value] = cookie.trim().split("=");
						if (key && value) acc[key] = value;
						return acc;
					},
					{} as Record<string, string>,
				);

				const sessionId = cookies.silo_session;
				if (!sessionId) return new Response("No session", { status: 401 });

				const sess = await db
					.select({
						id: sessions.id,
						userId: sessions.userId,
						impersonatorUserId: sessions.impersonatorUserId,
						impersonatedUserId: sessions.impersonatedUserId,
					})
					.from(sessions)
					.where(eq(sessions.id, sessionId))
					.limit(1);

				if (sess.length === 0)
					return new Response("Not found", { status: 404 });
				if (!sess[0].impersonatorUserId || !sess[0].impersonatedUserId) {
					return new Response("Not impersonating", { status: 400 });
				}

				await db
					.update(sessions)
					.set({
						impersonatorUserId: null,
						impersonatedUserId: null,
						impersonationExpiresAt: null,
					})
					.where(eq(sessions.id, sessionId));

				// Audit log
				await db.insert(requestLogs).values({
					bucketId: null,
					bucketName: null,
					ownerId: sess[0].impersonatedUserId,
					requesterId: user.id,
					method: "ADMIN",
					path: `impersonate:stop:${sess[0].impersonatedUserId}`,
					statusCode: 200,
					ingressBytes: 0,
					egressBytes: 0,
					ipAddress:
						req.headers.get("x-forwarded-for") ||
						req.headers.get("cf-connecting-ip") ||
						"unknown",
					userAgent: req.headers.get("user-agent") || "Admin",
					latencyMs: 0,
				});

				const headers = new Headers({ "Content-Type": "application/json" });
				headers.append(
					"Set-Cookie",
					`silo_impersonating=; Path=/; SameSite=Lax${secureFlag()}; Max-Age=0`,
				);

				return new Response(JSON.stringify({ ok: true }), { headers });
			} catch (e) {
				console.error("Failed to stop impersonation", e);
				return new Response("Failed", { status: 500 });
			}
		}

		// List Users
		if (path === "/api/admin/users" && req.method === "GET") {
			return listUsers(url, user);
		}

		// Get User Buckets
		const userBucketsMatch = path.match(
			/^\/api\/admin\/users\/([^/]+)\/buckets$/,
		);
		if (userBucketsMatch && req.method === "GET") {
			return getUserBuckets(userBucketsMatch[1]);
		}

		if (path === "/api/admin/buckets" && req.method === "GET") {
			return listAdminBuckets(url);
		}

		if (path === "/api/admin/speedtest/run" && req.method === "POST") {
			return runAdminSpeedtest(req);
		}

		// Global Settings API
		if (path === "/api/admin/settings" && req.method === "GET") {
			const user = await getCurrentUser(req);
			if (!user || !user.isAdmin)
				return new Response("Forbidden", { status: 403 });
			return jsonResponse(await getAppSettings());
		}

		if (path === "/api/admin/settings" && req.method === "POST") {
			const user = await getCurrentUser(req);
			if (!user || !user.isAdmin)
				return new Response("Forbidden", { status: 403 });

			const schema = z.object({
				defaultStorageLimitBytes: z.number().int().min(0),
				egressMultiplier: z.number().int().min(0).max(1000),
				minEgressBytes: z.number().int().min(0),
				defaultMaxBucketsPerUser: z.number().int().min(1).max(10000),
				defaultMaxKeysPerBucket: z.number().int().min(1).max(10000),
				yswsQuotaPerHourBytes: z.number().int().min(0),
				yswsBonusTiers: z
					.array(
						z.object({
							hours: z.number().min(0),
							percent: z.number().min(0),
							enabled: z.boolean(),
						}),
					)
					.optional(),
				cdnForceSlackUpload: z.boolean().optional(),
			});

			const body = await req.json().catch(() => null);
			const parsed = schema.safeParse(body);
			if (!parsed.success) {
				return new Response(parsed.error.issues[0]?.message ?? "Invalid body", {
					status: 400,
				});
			}

			const updated = await updateAppSettings(parsed.data);
			// TODO: add admin audit log entry
			return jsonResponse(updated);
		}

		// Update User Quota
		const userQuotaMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/quota$/);
		if (userQuotaMatch && req.method === "POST") {
			return updateUserQuota(userQuotaMatch[1], req);
		}

		// Lock/Unlock User
		const userLockMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/lock$/);
		if (userLockMatch && req.method === "POST") {
			return lockUser(userLockMatch[1], req);
		}

		// Toggle Reviewer Status
		const userReviewerMatch = path.match(
			/^\/api\/admin\/users\/([^/]+)\/reviewer$/,
		);
		if (userReviewerMatch && req.method === "POST") {
			return toggleUserReviewer(userReviewerMatch[1], req);
		}

		// Toggle Immortal Status
		const userImmortalMatch = path.match(
			/^\/api\/admin\/users\/([^/]+)\/immortal$/,
		);
		if (userImmortalMatch && req.method === "POST") {
			return toggleUserImmortal(userImmortalMatch[1], req);
		}

		// Age Out User
		const userAgeOutMatch = path.match(
			/^\/api\/admin\/users\/([^/]+)\/age-out$/,
		);
		if (userAgeOutMatch && req.method === "POST") {
			return ageOutUser(userAgeOutMatch[1], req);
		}

		// Get Bucket Details (with keys and files)
		const bucketMatch = path.match(/^\/api\/admin\/buckets\/([a-z0-9-]+)$/);
		if (bucketMatch && req.method === "GET") {
			return getBucketDetails(bucketMatch[1]);
		}

		// Preview File (Admin)
		const previewMatch = path.match(
			/^\/api\/admin\/buckets\/([a-z0-9-]+)\/files\/preview$/,
		);
		if (previewMatch && req.method === "GET") {
			return previewFile(previewMatch[1], url);
		}

		// Pause/Resume Bucket
		const bucketPauseMatch = path.match(
			/^\/api\/admin\/buckets\/([a-z0-9-]+)\/pause$/,
		);
		if (bucketPauseMatch && req.method === "POST") {
			return pauseBucket(bucketPauseMatch[1], req);
		}

		// Reset CORS (Admin)
		const bucketCorsMatch = path.match(
			/^\/api\/admin\/buckets\/([a-z0-9-]+)\/cors$/,
		);
		if (bucketCorsMatch && req.method === "DELETE") {
			return resetBucketCors(bucketCorsMatch[1]);
		}

		// Delete Bucket (Admin Force Delete)
		if (bucketMatch && req.method === "DELETE") {
			return deleteBucket(bucketMatch[1], url);
		}

		// Pause/Resume Key
		const keyPauseMatch = path.match(
			/^\/api\/admin\/keys\/([a-z0-9-]+)\/pause$/,
		);
		if (keyPauseMatch && req.method === "POST") {
			return pauseKey(keyPauseMatch[1], req);
		}

		// Delete Key
		const keyMatch = path.match(/^\/api\/admin\/keys\/([a-z0-9-]+)$/);
		if (keyMatch && req.method === "DELETE") {
			return deleteKey(keyMatch[1]);
		}

		// Delete File (Admin)
		const fileMatch = path.match(
			/^\/api\/admin\/buckets\/([a-z0-9-]+)\/files$/,
		);
		if (fileMatch && req.method === "DELETE") {
			return deleteFile(fileMatch[1], url);
		}

		// Get Logs (Admin)
		if (path === "/api/admin/logs" && req.method === "GET") {
			return listLogs(url);
		}
	}

	return new Response("Not Found", { status: 404 });
}
