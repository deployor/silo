import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { config } from "../../config";
import { db } from "../../db";
import { bucketKeys, buckets, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { deleteBucketContents, getInternalPath } from "../s3-api/utils";

const landingTemplate = await Bun.file(
	"src/features/landing/templates/landing.html",
).text();
const dashboardTemplate = await Bun.file(
	"src/features/landing/templates/dashboard.html",
).text();
const filesTemplate = await Bun.file(
	"src/features/landing/templates/files.html",
).text();
const docsTemplate = await Bun.file(
	"src/features/landing/templates/docs.html",
).text();
const lockedTemplate = await Bun.file(
	"src/features/landing/templates/locked.html",
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

export async function handleDashboardRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	if (path === "/docs" || path === "/docs/") {
		const finalDocs = docsTemplate.replace(
			/https:\/\/cargo\.deployor\.dev/g,
			`https://${config.s3Domain}`,
		);
		return new Response(finalDocs, {
			headers: { "Content-Type": "text/html" },
		});
	}

	if (path.startsWith("/auth/")) {
		if (path === "/auth/login") {
			const authUrl = `https://auth.hackclub.com/oauth/authorize?client_id=${config.hcAuth.clientId}&redirect_uri=${encodeURIComponent(config.hcAuth.redirectUri)}&response_type=code&scope=openid%20profile%20email%20slack_id%20verification_status`;
			return Response.redirect(authUrl);
		}

		if (path === "/auth/callback") {
			const code = url.searchParams.get("code");
			if (!code) return new Response("Missing code", { status: 400 });

			try {
				const params = new URLSearchParams();
				params.append("client_id", config.hcAuth.clientId);
				params.append("client_secret", config.hcAuth.clientSecret);
				params.append("code", code);
				params.append("grant_type", "authorization_code");
				params.append("redirect_uri", config.hcAuth.redirectUri);

				const tokenRes = await fetch("https://auth.hackclub.com/oauth/token", {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: params,
				});

				if (!tokenRes.ok) {
					const text = await tokenRes.text();
					console.error("Token Exchange Failed:", text);
					throw new Error(`Token exchange failed: ${tokenRes.status}`);
				}

				const tokenData = await tokenRes.json();
				if (!tokenData.access_token) {
					console.error("Token Error:", tokenData);
					throw new Error("Failed to get token");
				}

				const userRes = await fetch(
					"https://auth.hackclub.com/oauth/userinfo",
					{
						headers: { Authorization: `Bearer ${tokenData.access_token}` },
					},
				);
				const userData = await userRes.json();

				const userId = userData.sub;
				const slackId = userData.slack_id;

				await db
					.insert(users)
					.values({
						id: userId,
						email: userData.email,
						slackId: slackId,
					})
					.onConflictDoUpdate({
						target: users.id,
						set: {
							email: userData.email,
							slackId: slackId,
						},
					});

				const headers = new Headers();
				headers.set(
					"Set-Cookie",
					`cargo_user_id=${userId}; Path=/; HttpOnly; SameSite=Lax`,
				);
				headers.set("Location", "/");

				return new Response(null, { status: 302, headers });
			} catch (e) {
				console.error("Auth Error:", e);
				return new Response("Authentication Failed", { status: 500 });
			}
		}

		if (path === "/auth/logout") {
			const headers = new Headers();
			headers.set(
				"Set-Cookie",
				`cargo_user_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
			);
			headers.set("Location", "/");
			return new Response(null, { status: 302, headers });
		}
	}

	if (path.startsWith("/api/dashboard/")) {
		const user = await getCurrentUser(req);
		if (!user) return new Response("Unauthorized", { status: 401 });

		if (user.isLocked) {
			return new Response("Account Locked", { status: 403 });
		}

		if (path === "/api/dashboard/stats") {
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

			return new Response(
				JSON.stringify({
					user: {
						id: user.id,
						slackId: user.slackId,
						storageUsage: user.storageUsageBytes,
						storageLimit: user.storageLimitBytes,
						ingressBytes: user.ingressBytes,
						egressBytes: user.egressBytes,
						totalBytes: user.ingressBytes + user.egressBytes,
						totalRequests: user.totalRequests,
						isAdmin: user.isAdmin,
					},
					buckets: bucketsWithKeys.map((b) => ({
						name: b.name,
						keys: b.keys,
						createdAt: b.createdAt,
						totalBytes: b.totalBytes,
						totalRequests: b.totalRequests,
						isPublic: b.isPublic,
						isPaused: b.isPaused,
						pauseReason: b.pauseReason,
					})),
				}),
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

			try {
				const internalPrefix = getInternalPath("", user, bucket[0]);
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
				const s3Res = await s3Client.fetch(internalKey, {
					method: "DELETE",
				});

				if (!s3Res.ok) {
					throw new Error(`S3 Delete Error: ${s3Res.status}`);
				}

				return new Response("Deleted", { status: 200 });
			} catch (e) {
				console.error("Delete File Error:", e);
				return new Response("Failed to delete file", { status: 500 });
			}
		}
	}

	const user = await getCurrentUser(req);
	if (!user) {
		return new Response(landingTemplate, {
			headers: { "Content-Type": "text/html" },
		});
	}

	if (user.isLocked) {
		const reason = user.lockReason ? `<p class="text-text-muted mb-4 text-sm">Reason: ${user.lockReason}</p>` : "";
		const finalLocked = lockedTemplate.replace("<!-- REASON_PLACEHOLDER -->", reason);
		return new Response(finalLocked, {
			status: 403,
			headers: { "Content-Type": "text/html" },
		});
	}

	// Serve File Explorer Page
	const fileExplorerMatch = path.match(/^\/dashboard\/buckets\/([a-z0-9-]+)$/);
	if (fileExplorerMatch) {
		const _bucketName = fileExplorerMatch[1];
		// Verify bucket exists and belongs to user (optional, but good for UX to 404 early)
		// But we can just let the API calls handle auth.
		// However, we need to inject the bucket name or just let the client side handle it from URL.
		// The template uses window.location to get bucket name.

		return new Response(filesTemplate, {
			headers: { "Content-Type": "text/html" },
		});
	}

	const finalDashboard = dashboardTemplate.replace(
		/https:\/\/cargo\.deployor\.dev/g,
		`https://${config.s3Domain}`,
	);
	return new Response(finalDashboard, {
		headers: { "Content-Type": "text/html" },
	});
}
