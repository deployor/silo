import { eq } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { config } from "../../config";
import { db } from "../../db";
import { bucketKeys, buckets, users } from "../../db/schema";
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

		if (cookies.cargo_user_id) {
			const user = await db
				.select()
				.from(users)
				.where(eq(users.id, cookies.cargo_user_id))
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
			/https:\/\/cargo\.deployor\.dev/g,
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
			const allUsers = await db.select().from(users);
			return new Response(
				JSON.stringify({
					admin: { id: user.id, slackId: user.slackId },
					users: allUsers,
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
					await s3Client.fetch(internalKey, { method: "DELETE" });
				}
			}
			return new Response("Deleted", { status: 200 });
		}
	}

	return new Response("Not Found", { status: 404 });
}
