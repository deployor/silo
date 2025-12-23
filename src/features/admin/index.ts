import { and, asc, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { config } from "../../config";
import { db } from "../../db";
import { bucketKeys, buckets, requestLogs, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { deleteBucketContents, getInternalPath } from "../s3-api/utils";

const adminTemplate = await Bun.file(
	"src/features/admin/templates/admin.html",
).text();

async function getCurrentUser(req: Request) {
	const cookieHeader = req.headers.get("Cookie");
	if (cookieHeader) {
		const cookies = cookieHeader.split(";").reduce(
			(acc, cookie) => {
				const [key, value] = cookie.trim().split("=");
				acc[key] = value;
				return acc;
			},
			{} as Record<string, string>,
		);

		if (cookies.silo_user_id) {
			const user = await db
				.select()
				.from(users)
				.where(eq(users.id, cookies.silo_user_id))
				.limit(1);
			if (user.length > 0) return user[0];
		}
	}
	return null;
}

export async function handleAdminRequest(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user || !user.isAdmin) {
		return new Response("Unauthorized", { status: 403 });
	}

	const url = new URL(req.url);
	const path = url.pathname;

	// Serve Admin Dashboard
	if (path === "/admin" || path === "/admin/") {
		const finalHtml = adminTemplate.replace(
			/https:\/\/silo\.deployor\.dev/g,
			`https://${config.s3Domain}`,
		);
		return new Response(finalHtml, {
			headers: { "Content-Type": "text/html" },
		});
	}

	// API Routes
	if (path.startsWith("/api/admin/")) {
		// List Users
		if (path === "/api/admin/users" && req.method === "GET") {
			const limit = Number.parseInt(url.searchParams.get("limit") || "50");
			const offset = Number.parseInt(url.searchParams.get("offset") || "0");
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
					storageUsageBytes: sql<number>`COALESCE(sum(${buckets.totalBytes}), 0)`.mapWith(
						Number,
					),
					egressLimitBytes: users.egressLimitBytes,
					ingressBytes: users.ingressBytes,
					egressBytes: users.egressBytes,
					totalRequests: users.totalRequests,
					createdAt: users.createdAt,
					updatedAt: users.updatedAt,
					isAdmin: users.isAdmin,
					isLocked: users.isLocked,
					lockReason: users.lockReason,
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

		// Get User Buckets
		const userBucketsMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/buckets$/);
		if (userBucketsMatch && req.method === "GET") {
			const userId = userBucketsMatch[1];
			const userBuckets = await db
				.select()
				.from(buckets)
				.where(eq(buckets.userId, userId));
			return new Response(JSON.stringify(userBuckets), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Update User Quota
		const userQuotaMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/quota$/);
		if (userQuotaMatch && req.method === "POST") {
			const userId = userQuotaMatch[1];
			const body = await req.json();
			const updateData: any = {};
			if (body.storageLimitBytes !== undefined)
				updateData.storageLimitBytes = body.storageLimitBytes;
			if (body.egressLimitBytes !== undefined)
				updateData.egressLimitBytes = body.egressLimitBytes;

			await db.update(users).set(updateData).where(eq(users.id, userId));
			return new Response("Updated", { status: 200 });
		}

		// Lock/Unlock User
		const userLockMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/lock$/);
		if (userLockMatch && req.method === "POST") {
			const userId = userLockMatch[1];
			const body = await req.json();
			await db
				.update(users)
				.set({ isLocked: body.isLocked, lockReason: body.lockReason || null })
				.where(eq(users.id, userId));
			return new Response("Updated", { status: 200 });
		}

		// Get Bucket Details (with keys and files)
		const bucketMatch = path.match(/^\/api\/admin\/buckets\/([a-z0-9-]+)$/);
		if (bucketMatch && req.method === "GET") {
			const bucketName = bucketMatch[1];
			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);

			if (bucket.length === 0)
				return new Response("Not Found", { status: 404 });

			const keys = await db
				.select()
				.from(bucketKeys)
				.where(eq(bucketKeys.bucketId, bucket[0].id));

			// List files from S3 (limit 50 for preview)
			let files = [];
			try {
				const owner = await db
					.select()
					.from(users)
					.where(eq(users.id, bucket[0].userId))
					.limit(1);
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
							const contents = Array.isArray(result.Contents)
								? result.Contents
								: [result.Contents];
							files = contents.map((item: any) => ({
								key: item.Key.replace(internalPrefix, ""),
								size: item.Size,
								url: `/api/admin/buckets/${bucketName}/files/preview?key=${encodeURIComponent(item.Key.replace(internalPrefix, ""))}`,
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

		// Preview File (Admin)
		const previewMatch = path.match(
			/^\/api\/admin\/buckets\/([a-z0-9-]+)\/files\/preview$/,
		);
		if (previewMatch && req.method === "GET") {
			const bucketName = previewMatch[1];
			const key = url.searchParams.get("key");
			if (!key) return new Response("Missing key", { status: 400 });

			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);
			if (bucket.length === 0)
				return new Response("Not Found", { status: 404 });

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
			} catch (e) {
				return new Response("Error fetching file", { status: 500 });
			}
		}

		// Pause/Resume Bucket
		const bucketPauseMatch = path.match(
			/^\/api\/admin\/buckets\/([a-z0-9-]+)\/pause$/,
		);
		if (bucketPauseMatch && req.method === "POST") {
			const bucketName = bucketPauseMatch[1];
			const body = await req.json();
			await db
				.update(buckets)
				.set({ isPaused: body.isPaused, pauseReason: body.pauseReason || null })
				.where(eq(buckets.name, bucketName));
			return new Response("Updated", { status: 200 });
		}

		// Reset CORS (Admin)
		const bucketCorsMatch = path.match(
			/^\/api\/admin\/buckets\/([a-z0-9-]+)\/cors$/,
		);
		if (bucketCorsMatch && req.method === "DELETE") {
			const bucketName = bucketCorsMatch[1];
			await db
				.update(buckets)
				.set({ corsConfig: null })
				.where(eq(buckets.name, bucketName));
			return new Response("Reset", { status: 200 });
		}

		// Delete Bucket (Admin Force Delete)
		if (bucketMatch && req.method === "DELETE") {
			const bucketName = bucketMatch[1];
			// Logic to empty bucket first would be good, similar to user dashboard
			// For now, we assume the admin knows what they are doing or we reuse the empty logic
			// Reusing empty logic requires user context, but we are admin.
			// We can fetch the owner and use that.
			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);
			if (bucket.length > 0) {
				const owner = await db
					.select()
					.from(users)
					.where(eq(users.id, bucket[0].userId))
					.limit(1);
				if (owner.length > 0) {
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

		// Pause/Resume Key
		const keyPauseMatch = path.match(
			/^\/api\/admin\/keys\/([a-z0-9-]+)\/pause$/,
		);
		if (keyPauseMatch && req.method === "POST") {
			const keyId = keyPauseMatch[1];
			const body = await req.json();
			await db
				.update(bucketKeys)
				.set({ isPaused: body.isPaused, pauseReason: body.pauseReason || null })
				.where(eq(bucketKeys.id, keyId));
			return new Response("Updated", { status: 200 });
		}

		// Delete Key
		const keyMatch = path.match(/^\/api\/admin\/keys\/([a-z0-9-]+)$/);
		if (keyMatch && req.method === "DELETE") {
			const keyId = keyMatch[1];
			await db.delete(bucketKeys).where(eq(bucketKeys.id, keyId));
			return new Response("Deleted", { status: 200 });
		}

		// Delete File (Admin)
		const fileMatch = path.match(
			/^\/api\/admin\/buckets\/([a-z0-9-]+)\/files$/,
		);
		if (fileMatch && req.method === "DELETE") {
			const bucketName = fileMatch[1];
			const key = url.searchParams.get("key");
			if (!key) return new Response("Missing key", { status: 400 });

			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);
			if (bucket.length > 0) {
				const owner = await db
					.select()
					.from(users)
					.where(eq(users.id, bucket[0].userId))
					.limit(1);
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

		// Get Logs (Admin)
		if (path === "/api/admin/logs" && req.method === "GET") {
			const limit = Number.parseInt(url.searchParams.get("limit") || "50");
			const offset = Number.parseInt(url.searchParams.get("offset") || "0");
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
				filters.push(eq(requestLogs.statusCode, Number.parseInt(statusFilter)));
			}
			if (ipFilter) {
				filters.push(eq(requestLogs.ipAddress, ipFilter));
			}

			const conditions = filters.length > 0 ? and(...filters) : undefined;

			let orderBy: any;
			switch (sortBy) {
				case "latencyMs":
					orderBy =
						sortOrder === "asc"
							? asc(requestLogs.latencyMs)
							: desc(requestLogs.latencyMs);
					break;
				case "ingressBytes":
					orderBy =
						sortOrder === "asc"
							? asc(requestLogs.ingressBytes)
							: desc(requestLogs.ingressBytes);
					break;
				case "egressBytes":
					orderBy =
						sortOrder === "asc"
							? asc(requestLogs.egressBytes)
							: desc(requestLogs.egressBytes);
					break;
				case "statusCode":
					orderBy =
						sortOrder === "asc"
							? asc(requestLogs.statusCode)
							: desc(requestLogs.statusCode);
					break;
				case "createdAt":
				default:
					orderBy =
						sortOrder === "asc"
							? asc(requestLogs.createdAt)
							: desc(requestLogs.createdAt);
					break;
			}

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
	}

	return new Response("Not Found", { status: 404 });
}
