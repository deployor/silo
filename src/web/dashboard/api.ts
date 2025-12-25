import { and, eq, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { createHmac } from "node:crypto";
import { config } from "../../config";
import { db } from "../../db";
import { bucketKeys, buckets, requestLogs, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { getCurrentUser } from "../../lib/session";
import {
	deleteBucketContents,
	getInternalPath,
	isReservedBucketName,
} from "../../core/s3/utils";

export async function handleApiRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	if (path === "/api/onboarding/complete" && req.method === "POST") {
		const user = await getCurrentUser(req);
		if (!user) return new Response("Unauthorized", { status: 401 });

		await db
			.update(users)
			.set({ onboarded: true })
			.where(eq(users.id, user.id));

		const headers = new Headers();
		headers.set("Location", "/");
		return new Response(null, { status: 302, headers });
	}

	if (path === "/api/cdn/upload" && req.method === "POST") {
		const user = await getCurrentUser(req);
		if (!user) return new Response("Unauthorized", { status: 401 });
		if (user.isLocked) return new Response("Account Locked", { status: 403 });
		if (!user.slackId)
			return new Response("Slack account required", { status: 403 });

		try {
			const formData = await req.formData();
			const file = formData.get("file");

			if (!file || !(file instanceof File)) {
				return new Response("No file uploaded", { status: 400 });
			}

			// Get/Create CDN Bucket
			const bucketName = user.slackId.toLowerCase();
			let bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);

			if (bucket.length === 0) {
				const newBucket = await db
					.insert(buckets)
					.values({
						name: bucketName,
						userId: user.id,
						isPublic: true,
						isCdn: true,
						region: "auto",
					})
					.returning();
				bucket = newBucket;
			}
			const targetBucket = bucket[0];

			if (targetBucket.isPaused) {
				return new Response(`Bucket paused: ${targetBucket.pauseReason}`, {
					status: 403,
				});
			}

			// Check Quota
			const usageResult = await db
				.select({ total: sql<number>`sum(${buckets.totalBytes})` })
				.from(buckets)
				.where(eq(buckets.userId, user.id));
			const currentUsage = Number(usageResult[0]?.total) || 0;
			const limit = user.storageLimitBytes || 1073741824; // Default 1GB

			if (currentUsage + file.size > limit) {
				return new Response("Quota exceeded", { status: 403 });
			}

			// Upload
			const ext = file.name.split(".").pop();
			const hash = crypto.randomUUID();
			const fileName = `${hash}.${ext}`;
			const internalPath = getInternalPath(fileName, user, targetBucket);
			const fileBuffer = await file.arrayBuffer();

			const s3Res = await s3Client.fetch(internalPath, {
				method: "PUT",
				body: fileBuffer,
				headers: {
					"Content-Type": file.type || "application/octet-stream",
					"Content-Length": file.size.toString(),
				},
			});

			if (!s3Res.ok) {
				throw new Error(`S3 Upload Failed: ${s3Res.status}`);
			}

			// Update Stats
			await db
				.update(buckets)
				.set({
					totalBytes: sql`${buckets.totalBytes} + ${file.size}`,
					totalRequests: sql`${buckets.totalRequests} + 1`,
				})
				.where(eq(buckets.id, targetBucket.id));

			// Log Request
			await db.insert(requestLogs).values({
				bucketId: targetBucket.id,
				bucketName: targetBucket.name,
				ownerId: user.id,
				requesterId: user.id,
				method: "PUT",
				path: fileName,
				statusCode: 200,
				ingressBytes: file.size,
				egressBytes: 0,
				ipAddress: req.headers.get("x-forwarded-for") || "127.0.0.1",
				userAgent: req.headers.get("user-agent") || "Web/CDN",
				latencyMs: 0,
			});

			const publicUrl = `https://${config.s3Domain}/${bucketName}/${fileName}`;
			return new Response(JSON.stringify({ url: publicUrl }), {
				headers: { "Content-Type": "application/json" },
			});
		} catch (e) {
			console.error("CDN Upload Error:", e);
			return new Response("Upload failed", { status: 500 });
		}
	}

	if (path.startsWith("/api/dashboard/")) {
		const user = await getCurrentUser(req);
		if (!user) return new Response("Unauthorized", { status: 401 });

		if (user.isLocked) {
			return new Response("Account Locked", { status: 403 });
		}

		if (path === "/api/dashboard/stats") {
			console.log(`[DEBUG] Fetching stats for user: ${user.id}`);
			const userBuckets = await db
				.select()
				.from(buckets)
				.where(eq(buckets.userId, user.id));

			const bucketsWithKeys = await Promise.all(
				userBuckets.map(async (b) => {
					const keys = await db
						.select()
						.from(bucketKeys)
						.where(eq(bucketKeys.bucketId, b.id));
					return {
						...b,
						keys: keys.map((k) => ({
							id: k.id,
							accessKey: k.accessKey,
						})),
					};
				}),
			);

			const responseData = {
				user: {
					id: user.id,
					slackId: user.slackId,
					storageUsage: Number(user.storageUsageBytes) || 0,
					storageLimit: Number(user.storageLimitBytes) || 1073741824,
					egressLimit:
						user.egressLimitBytes !== null
							? Number(user.egressLimitBytes)
							: null,
					ingressBytes: Number(user.ingressBytes) || 0,
					egressBytes: Number(user.egressBytes) || 0,
					totalBytes:
						(Number(user.ingressBytes) || 0) + (Number(user.egressBytes) || 0),
					totalRequests: Number(user.totalRequests) || 0,
					isAdmin: user.isAdmin,
				},
				buckets: bucketsWithKeys.map((b) => ({
					name: b.name,
					keys: b.keys,
					createdAt: b.createdAt,
					totalBytes: Number(b.totalBytes) || 0,
					totalRequests: Number(b.totalRequests) || 0,
					isPublic: b.isPublic,
					isPaused: b.isPaused,
					pauseReason: b.pauseReason,
					corsConfig: b.corsConfig,
					isCdn: b.isCdn,
				})),
			};
			console.log(`[DEBUG] Stats response:`, JSON.stringify(responseData, null, 2));

			return new Response(
				JSON.stringify(responseData),
				{ headers: { "Content-Type": "application/json" } },
			);
		}

		if (path === "/api/dashboard/buckets" && req.method === "POST") {
			try {
				const body = await req.json();
				const name = body.name;

				if (!name || !/^[a-z0-9-]+$/.test(name)) {
					return new Response("Invalid bucket name", { status: 400 });
				}

				if (isReservedBucketName(name)) {
					return new Response("Bucket name is reserved for system use", {
						status: 403,
					});
				}

				const userBuckets = await db
					.select()
					.from(buckets)
					.where(eq(buckets.userId, user.id));
				if (userBuckets.length >= 50) {
					return new Response("Bucket limit reached", { status: 403 });
				}

				// Check if bucket name exists globally
				const existing = await db
					.select()
					.from(buckets)
					.where(eq(buckets.name, name))
					.limit(1);
				if (existing.length > 0) {
					return new Response("Bucket name already taken", { status: 409 });
				}

				const newBucket = await db
					.insert(buckets)
					.values({
						name,
						userId: user.id,
						isPublic: false,
					})
					.returning();

				const accessKey =
					"CK" +
					Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) =>
						b.toString(16).padStart(2, "0"),
					)
						.join("")
						.toUpperCase();
				const secretKey = Array.from(
					crypto.getRandomValues(new Uint8Array(20)),
					(b) => b.toString(16).padStart(2, "0"),
				).join("");

				await db.insert(bucketKeys).values({
					bucketId: newBucket[0].id,
					accessKey,
					secretKey,
				});

				// Construct public URL example
				// Since we don't use subdomains per bucket, it's just the root domain + bucket name
				const publicUrl = `https://${config.s3Domain}/${name}/file.png`;

				return new Response(
					JSON.stringify({ accessKey, secretKey, publicUrl }),
					{
						headers: { "Content-Type": "application/json" },
					},
				);
			} catch (e) {
				console.error(e);
				return new Response("Internal Error", { status: 500 });
			}
		}

		// Delete bucket
		if (
			path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+$/) &&
			req.method === "DELETE"
		) {
			const bucketName = path.split("/").pop();
			if (!bucketName)
				return new Response("Invalid bucket name", { status: 400 });

			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);
			if (bucket.length === 0)
				return new Response("Bucket not found", { status: 404 });
			if (bucket[0].userId !== user.id && !user.isAdmin)
				return new Response("Unauthorized", { status: 403 });
			if (bucket[0].isPaused && !user.isAdmin)
				return new Response("Bucket is paused", { status: 403 });

			const isEmptyOnly = url.searchParams.get("empty") === "true";

			// Prevent deletion of CDN buckets
			if (bucket[0].isCdn) {
				// Allow emptying CDN bucket but not deleting it
				try {
					const internalPrefix = getInternalPath("", user, bucket[0]);
					await deleteBucketContents(internalPrefix);

					// Reset usage stats
					await db
						.update(buckets)
						.set({ totalBytes: 0, totalRequests: 0 })
						.where(eq(buckets.id, bucket[0].id));

					return new Response("CDN Bucket Emptied", { status: 200 });
				} catch (e) {
					console.error("Failed to empty CDN bucket:", e);
					return new Response("Failed to empty CDN bucket", { status: 500 });
				}
			}

			if (isEmptyOnly) {
				try {
					const internalPrefix = getInternalPath("", user, bucket[0]);
					await deleteBucketContents(internalPrefix);

					// Reset usage stats
					await db
						.update(buckets)
						.set({ totalBytes: 0 }) // Keep requests count for history? Or reset? Usually empty means files.
						.where(eq(buckets.id, bucket[0].id));

					return new Response("Bucket Emptied", { status: 200 });
				} catch (e) {
					console.error("Failed to empty bucket:", e);
					return new Response("Failed to empty bucket", { status: 500 });
				}
			}

			try {
				const internalPrefix = getInternalPath("", user, bucket[0]);
				// We don't need to update bucket usage here because we are deleting the bucket
				await deleteBucketContents(internalPrefix);
			} catch (e) {
				console.error("Failed to empty bucket:", e);
				return new Response("Failed to empty bucket contents", { status: 500 });
			}

			await db.delete(buckets).where(eq(buckets.name, bucketName));

			return new Response("Deleted", { status: 200 });
		}

		// Update bucket (public/private)
		if (
			path.match(/^\/api\/dashboard\/buckets\/[a-z0-9-]+$/) &&
			req.method === "PATCH"
		) {
			const bucketName = path.split("/")[4]; // /api/dashboard/buckets/:name
			if (!bucketName)
				return new Response("Invalid bucket name", { status: 400 });

			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);
			if (bucket.length === 0)
				return new Response("Bucket not found", { status: 404 });
			if (bucket[0].userId !== user.id && !user.isAdmin)
				return new Response("Unauthorized", { status: 403 });
			if (bucket[0].isPaused && !user.isAdmin)
				return new Response("Bucket is paused", { status: 403 });

			if (bucket[0].isCdn)
				return new Response("Cannot modify CDN bucket", { status: 403 });

			try {
				const body = await req.json();

				if (typeof body.isPublic === "boolean") {
					await db
						.update(buckets)
						.set({ isPublic: body.isPublic })
						.where(eq(buckets.name, bucketName));
					return new Response("Updated", { status: 200 });
				}
				return new Response("Invalid body", { status: 400 });
			} catch (_e) {
				return new Response("Internal Error", { status: 500 });
			}
		}

		// Generate new key for bucket
		const generateKeyMatch = path.match(
			/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/keys$/,
		);
		if (generateKeyMatch && req.method === "POST") {
			const bucketName = generateKeyMatch[1];
			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);

			if (bucket.length === 0)
				return new Response("Bucket not found", { status: 404 });
			if (bucket[0].userId !== user.id && !user.isAdmin)
				return new Response("Unauthorized", { status: 403 });
			if (bucket[0].isPaused && !user.isAdmin)
				return new Response("Bucket is paused", { status: 403 });

			if (bucket[0].isCdn)
				return new Response("Cannot create keys for CDN bucket", { status: 403 });

			const accessKey =
				"CK" +
				Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) =>
					b.toString(16).padStart(2, "0"),
				)
					.join("")
					.toUpperCase();
			const secretKey = Array.from(
				crypto.getRandomValues(new Uint8Array(20)),
				(b) => b.toString(16).padStart(2, "0"),
			).join("");

			await db.insert(bucketKeys).values({
				bucketId: bucket[0].id,
				accessKey,
				secretKey,
			});

			const publicUrl = `https://${config.s3Domain}/${bucketName}/file.png`;

			return new Response(JSON.stringify({ accessKey, secretKey, publicUrl }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Delete key
		const deleteKeyMatch = path.match(
			/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/keys\/([^/]+)$/,
		);
		if (deleteKeyMatch && req.method === "DELETE") {
			const bucketName = deleteKeyMatch[1];
			const keyId = deleteKeyMatch[2];

			console.log(`[DELETE KEY] Bucket: "${bucketName}", KeyID: "${keyId}"`);

			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);

			if (bucket.length === 0) {
				console.log(`[DELETE KEY] Bucket not found in DB: "${bucketName}"`);
				return new Response(`Bucket not found: "${bucketName}"`, {
					status: 404,
				});
			}
			if (bucket[0].userId !== user.id && !user.isAdmin)
				return new Response("Unauthorized", { status: 403 });
			if (bucket[0].isPaused && !user.isAdmin)
				return new Response("Bucket is paused", { status: 403 });

			if (bucket[0].isCdn)
				return new Response("Cannot delete keys for CDN bucket", { status: 403 });

			await db.delete(bucketKeys).where(eq(bucketKeys.id, keyId));

			return new Response("Deleted", { status: 200 });
		}

		// Sign Preview URL
		const signPreviewMatch = path.match(
			/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/files\/sign$/,
		);
		if (signPreviewMatch && req.method === "POST") {
			const bucketName = signPreviewMatch[1];

			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);

			if (bucket.length === 0)
				return new Response("Bucket not found", { status: 404 });
			if (bucket[0].userId !== user.id && !user.isAdmin)
				return new Response("Unauthorized", { status: 403 });
			if (bucket[0].isPaused && !user.isAdmin)
				return new Response("Bucket is paused", { status: 403 });

			try {
				const body = await req.json();
				const key = body.key;
				if (!key) return new Response("Missing key", { status: 400 });

				const expires = Date.now() + 5 * 60 * 1000; // 5 minutes
				const dataToSign = `${bucketName}:${key}:${expires}`;
				const signature = createHmac("sha256", config.hcAuth.clientSecret)
					.update(dataToSign)
					.digest("hex");

				const url = `/api/dashboard/buckets/${bucketName}/files/preview?key=${encodeURIComponent(key)}&expires=${expires}&signature=${signature}`;

				return new Response(JSON.stringify({ url }), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (_e) {
				return new Response("Internal Error", { status: 500 });
			}
		}

		// Preview File (Proxy)
		const previewFileMatch = path.match(
			/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/files\/preview$/,
		);
		if (previewFileMatch && req.method === "GET") {
			const bucketName = previewFileMatch[1];
			const key = url.searchParams.get("key");
			const expires = url.searchParams.get("expires");
			const signature = url.searchParams.get("signature");

			if (!key || !expires || !signature)
				return new Response("Missing params", { status: 400 });

			// Verify expiration
			if (Date.now() > parseInt(expires, 10)) {
				return new Response("Link expired", { status: 410 });
			}

			// Verify signature
			const dataToSign = `${bucketName}:${key}:${expires}`;
			const expectedSignature = createHmac("sha256", config.hcAuth.clientSecret)
				.update(dataToSign)
				.digest("hex");

			if (signature !== expectedSignature) {
				return new Response("Invalid signature", { status: 403 });
			}

			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);

			if (bucket.length === 0)
				return new Response("Bucket not found", { status: 404 });
			if (bucket[0].userId !== user.id && !user.isAdmin)
				return new Response("Unauthorized", { status: 403 });
			if (bucket[0].isPaused && !user.isAdmin)
				return new Response("Bucket is paused", { status: 403 });

			// If admin is viewing another user's bucket, we need the owner's user object for the path
			let owner = user;
			if (bucket[0].userId !== user.id) {
				const ownerResult = await db
					.select()
					.from(users)
					.where(eq(users.id, bucket[0].userId))
					.limit(1);
				if (ownerResult.length > 0) {
					owner = ownerResult[0];
				}
			}

			const internalKey = getInternalPath(key, owner, bucket[0]);

			try {
				const s3Res = await s3Client.fetch(internalKey, {
					method: "GET",
				});

				if (!s3Res.ok) {
					if (s3Res.status === 404)
						return new Response("File not found", { status: 404 });
					return new Response(s3Res.body, { status: s3Res.status });
				}

				const headers = new Headers(s3Res.headers);
				headers.set("Content-Disposition", "inline");
				headers.set("Cache-Control", "private, max-age=300"); // Cache for 5 mins
				headers.delete("x-amz-request-id");
				headers.delete("x-amz-id-2");

				return new Response(s3Res.body, {
					status: s3Res.status,
					headers,
				});
			} catch (e) {
				console.error("Preview File Error:", e);
				return new Response("Failed to preview file", { status: 500 });
			}
		}

		// List Files (Proxy to S3 ListObjectsV2)
		const listFilesMatch = path.match(
			/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/files$/,
		);
		if (listFilesMatch && req.method === "GET") {
			const bucketName = listFilesMatch[1];
			const prefix = url.searchParams.get("prefix") || "";
			const continuationToken = url.searchParams.get("continuation-token");

			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);

			if (bucket.length === 0)
				return new Response("Bucket not found", { status: 404 });
			if (bucket[0].userId !== user.id && !user.isAdmin)
				return new Response("Unauthorized", { status: 403 });
			if (bucket[0].isPaused && !user.isAdmin)
				return new Response("Bucket is paused", { status: 403 });

			// If admin is viewing another user's bucket, we need the owner's user object for the path
			let owner = user;
			if (bucket[0].userId !== user.id) {
				const ownerResult = await db
					.select()
					.from(users)
					.where(eq(users.id, bucket[0].userId))
					.limit(1);
				if (ownerResult.length > 0) {
					owner = ownerResult[0];
				}
			}

			// Construct internal prefix
			const internalPrefix = getInternalPath(prefix, owner, bucket[0]);

			// We need to list objects from S3
			// We'll use the s3Client directly
			const query = new URLSearchParams();
			query.set("list-type", "2");
			query.set("prefix", internalPrefix);
			query.set("delimiter", "/"); // Important for folder view
			if (continuationToken) {
				query.set("continuation-token", continuationToken);
			}

			try {
				const s3Res = await s3Client.fetch(`?${query.toString()}`, {
					method: "GET",
				});

				if (!s3Res.ok) {
					throw new Error(`S3 Error: ${s3Res.status}`);
				}

				const xml = await s3Res.text();
				const parser = new XMLParser();
				const result = parser.parse(xml).ListBucketResult;

				// Process Contents (Files)
				let files = [];
				if (result.Contents) {
					const contents = Array.isArray(result.Contents)
						? result.Contents
						: [result.Contents];
					files = contents
						.map(
							(item: { Key: string; Size: number; LastModified: string }) => {
								// Strip internal prefix to get relative path
								const key = item.Key;
								// We want to show the name relative to the current prefix for display?
								// Or just the full key? The UI handles display.
								// But we must strip the user/bucket prefix part.
								const rootPrefix = getInternalPath("", user, bucket[0]);
								const relativeKey = key.startsWith(rootPrefix)
									? key.slice(rootPrefix.length)
									: key;

								return {
									key: relativeKey,
									name: relativeKey.split("/").pop(),
									size: item.Size,
									lastModified: item.LastModified,
									url: `https://${config.s3Domain}/${relativeKey}`,
								};
							},
						)
						.filter((f: { key: string }) => f.key !== prefix); // Exclude the folder itself if it appears
				}

				// Process CommonPrefixes (Folders)
				let folders = [];
				if (result.CommonPrefixes) {
					const prefixes = Array.isArray(result.CommonPrefixes)
						? result.CommonPrefixes
						: [result.CommonPrefixes];
					folders = prefixes.map((item: { Prefix: string }) => {
						const p = item.Prefix;
						const rootPrefix = getInternalPath("", user, bucket[0]);
						const relativePrefix = p.startsWith(rootPrefix)
							? p.slice(rootPrefix.length)
							: p;

						return {
							prefix: relativePrefix,
							name: `${relativePrefix.split("/").filter(Boolean).pop()}/`,
						};
					});
				}

				return new Response(
					JSON.stringify({
						files,
						folders,
						nextContinuationToken: result.NextContinuationToken,
						userId: user.id,
					}),
					{
						headers: { "Content-Type": "application/json" },
					},
				);
			} catch (e) {
				console.error("List Files Error:", e);
				return new Response("Failed to list files", { status: 500 });
			}
		}

		// CORS Management
		const corsMatch = path.match(
			/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/cors$/,
		);
		if (corsMatch) {
			const bucketName = corsMatch[1];
			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);

			if (bucket.length === 0)
				return new Response("Bucket not found", { status: 404 });
			if (bucket[0].userId !== user.id && !user.isAdmin)
				return new Response("Unauthorized", { status: 403 });
			if (bucket[0].isPaused && !user.isAdmin)
				return new Response("Bucket is paused", { status: 403 });

			if (bucket[0].isCdn)
				return new Response("Cannot modify CDN bucket CORS", { status: 403 });

			if (req.method === "PUT") {
				try {
					const body = await req.json();
					const rules = body.rules;

					if (!Array.isArray(rules)) {
						return new Response("Invalid rules format", { status: 400 });
					}

					const corsConfig = {
						CORSRules: rules,
					};

					await db
						.update(buckets)
						.set({ corsConfig: JSON.stringify(corsConfig) })
						.where(eq(buckets.name, bucketName));

					return new Response("Updated", { status: 200 });
				} catch (e) {
					return new Response("Invalid JSON", { status: 400 });
				}
			}

			if (req.method === "DELETE") {
				await db
					.update(buckets)
					.set({ corsConfig: null })
					.where(eq(buckets.name, bucketName));
				return new Response("Deleted", { status: 200 });
			}
		}

		// Delete File
		if (listFilesMatch && req.method === "DELETE") {
			const bucketName = listFilesMatch[1];
			const key = url.searchParams.get("key");

			if (!key) return new Response("Missing key", { status: 400 });

			const bucket = await db
				.select()
				.from(buckets)
				.where(eq(buckets.name, bucketName))
				.limit(1);

			if (bucket.length === 0)
				return new Response("Bucket not found", { status: 404 });
			if (bucket[0].userId !== user.id && !user.isAdmin)
				return new Response("Unauthorized", { status: 403 });
			if (bucket[0].isPaused && !user.isAdmin)
				return new Response("Bucket is paused", { status: 403 });

			// If admin is viewing another user's bucket, we need the owner's user object for the path
			let owner = user;
			if (bucket[0].userId !== user.id) {
				const ownerResult = await db
					.select()
					.from(users)
					.where(eq(users.id, bucket[0].userId))
					.limit(1);
				if (ownerResult.length > 0) {
					owner = ownerResult[0];
				}
			}

			const internalKey = getInternalPath(key, owner, bucket[0]);

			try {
				// Get file size first to update quota
				const headRes = await s3Client.fetch(internalKey, { method: "HEAD" });
				const size = Number(headRes.headers.get("content-length") || 0);

				const s3Res = await s3Client.fetch(internalKey, {
					method: "DELETE",
				});

				if (!s3Res.ok) {
					throw new Error(`S3 Delete Error: ${s3Res.status}`);
				}

				if (size > 0) {
					await db
						.update(buckets)
						.set({
							totalBytes: sql`${buckets.totalBytes} - ${size}`,
						})
						.where(eq(buckets.id, bucket[0].id));
				}

				return new Response("Deleted", { status: 200 });
			} catch (e) {
				console.error("Delete File Error:", e);
				return new Response("Failed to delete file", { status: 500 });
			}
		}
	}

	return new Response("Not Found", { status: 404 });
}
