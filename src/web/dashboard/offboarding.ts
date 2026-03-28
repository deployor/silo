import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import archiver from "archiver";
import { AwsClient } from "aws4fetch";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { config } from "../../config";
import { getInternalPath } from "../../core/s3/utils";
import { db } from "../../db";
import { buckets, offboardingExportSessions, users } from "../../db/schema";
import {
	OFFBOARDING_EXPORT_TTL_MS,
	buildOffboardingAllowedPrefix,
	buildOffboardingRcloneCommand,
	createOffboardingExportAccessKey,
	deriveOffboardingExportSecret,
	expireOffboardingExportSessions,
	hashOffboardingExportSecret,
} from "../../lib/offboarding-export";
import { s3Client } from "../../lib/s3-client";
import { getCurrentUser } from "../../lib/session";
import { render } from "../../lib/view-engine";

// Simple in-memory rate limiting (use Redis in production)
const EXPORT_LIMITS = new Map<string, number[]>();
const MAX_EXPORTS_PER_HOUR = 3;
const MIGRATION_LOCKS = new Set<string>();

async function getS3Error(res: Response): Promise<string> {
	try {
		const text = await res.text();
		if (text.includes("<?xml") || text.includes("<Error>")) {
			const { XMLParser } = await import("fast-xml-parser");
			const parser = new XMLParser();
			const parsed = parser.parse(text);
			if (parsed.Error) {
				return `${parsed.Error.Code}: ${parsed.Error.Message}`;
			}
		}
		return `Status ${res.status}`;
	} catch (_e) {
		return `Status ${res.status}`;
	}
}

function checkExportRateLimit(userId: string): boolean {
	const now = Date.now();
	const timestamps = EXPORT_LIMITS.get(userId) || [];

	// Filter out timestamps older than 1 hour
	const recent = timestamps.filter((t) => now - t < 60 * 60 * 1000);

	if (recent.length >= MAX_EXPORTS_PER_HOUR) {
		return false;
	}

	recent.push(now);
	EXPORT_LIMITS.set(userId, recent);
	return true;
}

export async function handleOffboardingRequest(
	req: Request,
): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) {
		return Response.redirect("/auth/login");
	}

	const url = new URL(req.url);
	await expireOffboardingExportSessions();

	// Ensure user is actually offboarding or has already exported
	if (!user.markedAsOverAge && !user.dataExported) {
		return Response.redirect("/");
	}

	if (req.method === "GET" && url.pathname === "/dashboard/offboarding") {
		if (user.filesDeleted) {
			const html = await render("aged-out", {
				title: "Silo - Offboarding",
				layout: "blank",
				user,
			});
			return new Response(html, { headers: { "Content-Type": "text/html" } });
		}

		const now = new Date();
		const ends = user.overAgeGracePeriodEndsAt
			? new Date(user.overAgeGracePeriodEndsAt)
			: now;
		const diffTime = Math.max(0, ends.getTime() - now.getTime());
		const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

		const totalDays = 60;
		const progressPercentage = Math.min(
			100,
			Math.max(0, ((totalDays - daysRemaining) / totalDays) * 100),
		);

		const stats = await db.execute(sql`
		          SELECT SUM(total_bytes) as total_size
		          FROM buckets
		          WHERE user_id = ${user.id}
		      `);
		const totalBytes = Number(stats[0]?.total_size || 0);

		const units = ["B", "KB", "MB", "GB", "TB"];
		let size = totalBytes;
		let unitIndex = 0;
		while (size >= 1024 && unitIndex < units.length - 1) {
			size /= 1024;
			unitIndex++;
		}
		const totalStorageFormatted = `${size.toFixed(2)} ${units[unitIndex]}`;

		const html = await render("offboarding", {
			title: "Export Your Data - Silo",
			layout: "main",
			user,
			daysRemaining,
			totalStorageBytes: totalBytes,
			totalStorageFormatted,
			progressPercentage: progressPercentage.toFixed(1),
			gracePeriodEndsAt: ends.toLocaleDateString(),
			hideNavLinks: true,
			showSuccess: url.searchParams.get("success") === "1",
		});
		return new Response(html, { headers: { "Content-Type": "text/html" } });
	}

	if (
		req.method === "POST" &&
		url.pathname === "/dashboard/offboarding/rclone-export"
	) {
		const activeSession = await db
			.select()
			.from(offboardingExportSessions)
			.where(
				and(
					eq(offboardingExportSessions.userId, user.id),
					isNull(offboardingExportSessions.revokedAt),
					gt(offboardingExportSessions.expiresAt, new Date()),
				),
			)
			.limit(1);

		const accessKey =
			activeSession[0]?.accessKey || createOffboardingExportAccessKey();
		const secretKey = deriveOffboardingExportSecret(accessKey);
		const expiresAt = new Date(Date.now() + OFFBOARDING_EXPORT_TTL_MS);

		if (!activeSession[0]) {
			await db.insert(offboardingExportSessions).values({
				userId: user.id,
				accessKey,
				secretKeyHash: hashOffboardingExportSecret(secretKey),
				allowedPrefix: buildOffboardingAllowedPrefix(user),
				expiresAt,
			});
		}

		const userBuckets = await db
			.select({ name: buckets.name })
			.from(buckets)
			.where(eq(buckets.userId, user.id));

		const endpoint = `https://${config.s3Domain}`;
		const command = buildOffboardingRcloneCommand({
			endpoint,
			accessKey,
			secretKey,
			bucketNames: userBuckets.map((bucket) => bucket.name),
			destinationPath: "./silo-export",
		});

		return new Response(
			JSON.stringify({
				accessKey,
				secretKey,
				endpoint,
				expiresAt: (activeSession[0]?.expiresAt || expiresAt).toISOString(),
				command,
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	}

	if (
		req.method === "GET" &&
		url.pathname === "/dashboard/offboarding/archive"
	) {
		if (!checkExportRateLimit(user.id)) {
			return new Response(
				"Export rate limit exceeded. You can only generate 3 exports per hour. Please try again later.",
				{ status: 429 },
			);
		}
		return streamUserData(user);
	}

	if (
		req.method === "POST" &&
		url.pathname === "/dashboard/offboarding/download"
	) {
		if (!user.dataExported) {
			await db
				.update(users)
				.set({ dataExported: true })
				.where(eq(users.id, user.id));

			return Response.redirect("/dashboard/offboarding?success=1");
		}

		return Response.redirect("/dashboard/offboarding/archive");
	}

	if (
		req.method === "POST" &&
		url.pathname === "/dashboard/offboarding/analyze"
	) {
		let body: unknown;
		try {
			body = await req.json();
		} catch (_e) {
			return new Response("Invalid JSON", { status: 400 });
		}

		return analyzeMigration(user, body as MigrationParams);
	}

	if (
		req.method === "POST" &&
		url.pathname === "/dashboard/offboarding/migrate"
	) {
		if (MIGRATION_LOCKS.has(user.id)) {
			return new Response("Migration already in progress", { status: 409 });
		}

		let body: unknown;
		try {
			body = await req.json();
		} catch (_e) {
			return new Response("Invalid JSON", { status: 400 });
		}

		return migrateUserData(user, body as MigrationParams);
	}

	return new Response("Not Found", { status: 404 });
}

type MigrationParams = {
	endpoint?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	bucketMapping?: Record<string, string>;
};

async function analyzeMigration(
	user: typeof users.$inferSelect,
	params: MigrationParams,
) {
	const { endpoint, accessKeyId, secretAccessKey, bucketMapping } = params;

	const cleanEndpoint = endpoint ? endpoint.trim() : "";
	const cleanAccessKey = accessKeyId ? accessKeyId.trim() : "";
	const cleanSecretKey = secretAccessKey ? secretAccessKey.trim() : "";

	if (!cleanEndpoint || !cleanAccessKey || !cleanSecretKey) {
		return new Response(
			JSON.stringify({
				error: "Missing required credentials",
				details: {
					hasEndpoint: !!cleanEndpoint,
					hasAccessKey: !!cleanAccessKey,
					hasSecretKey: !!cleanSecretKey,
				},
			}),
			{ status: 400 },
		);
	}

	if (cleanEndpoint.includes("<account_id>")) {
		return new Response(
			JSON.stringify({
				error:
					"Please replace <account_id> in the endpoint URL with your actual Cloudflare Account ID.",
			}),
			{ status: 400 },
		);
	}

	// Debug bypass for testing
	if (
		!config.isProduction &&
		cleanAccessKey === "348f6572f69435b0d014457e5b385966" &&
		cleanSecretKey ===
			"01e5df70067643e26b38c22780b621df26be0f089602492f2323a0747448378d"
	) {
		const localBuckets = await db
			.select()
			.from(buckets)
			.where(eq(buckets.userId, user.id));

		const plan = localBuckets.map((b) => {
			const targetName = bucketMapping?.[b.name]
				? bucketMapping[b.name]
				: b.name;
			let status = "AVAILABLE";
			if (targetName.includes("taken")) status = "TAKEN"; // Mock taken
			if (targetName.includes("exists")) status = "EXISTS"; // Mock exists

			return {
				localName: b.name,
				targetName: targetName,
				status: status,
			};
		});

		// Simulating checking
		await new Promise((r) => setTimeout(r, 800));

		return new Response(JSON.stringify({ plan }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	try {
		const destClient = new AwsClient({
			accessKeyId: cleanAccessKey,
			secretAccessKey: cleanSecretKey,
			service: "s3",
			region: "auto",
		});

		const localBuckets = await db
			.select()
			.from(buckets)
			.where(eq(buckets.userId, user.id));

		const listRes = await destClient.fetch(cleanEndpoint, { method: "GET" });

		if (!listRes.ok) {
			const err = await getS3Error(listRes);
			if (listRes.status === 403) {
				return new Response(
					JSON.stringify({ error: `Access Denied: ${err}` }),
					{ status: 403 },
				);
			}
			return new Response(
				JSON.stringify({ error: `Could not connect: ${err}` }),
				{ status: 400 },
			);
		}

		const xml = await listRes.text();
		const { XMLParser } = await import("fast-xml-parser");
		const parser = new XMLParser();
		const result = parser.parse(xml).ListAllMyBucketsResult;

		const remoteBuckets = new Set<string>();
		if (result.Buckets?.Bucket) {
			const bucketsArr = Array.isArray(result.Buckets.Bucket)
				? result.Buckets.Bucket
				: [result.Buckets.Bucket];
			for (const b of bucketsArr) {
				remoteBuckets.add(b.Name);
			}
		}

		const plan = await Promise.all(
			localBuckets.map(async (b) => {
				const targetName = bucketMapping?.[b.name]
					? bucketMapping[b.name]
					: b.name;

				if (remoteBuckets.has(targetName)) {
					return {
						localName: b.name,
						targetName: targetName,
						status: "EXISTS",
					};
				}

				try {
					const bucketUrl = `${cleanEndpoint.replace(/\/+$/, "")}/${targetName}`;
					const headRes = await destClient.fetch(bucketUrl, { method: "HEAD" });

					if (headRes.status === 404) {
						return {
							localName: b.name,
							targetName: targetName,
							status: "AVAILABLE",
						};
					} else {
						return {
							localName: b.name,
							targetName: targetName,
							status: "TAKEN",
						};
					}
				} catch (_e) {
					return {
						localName: b.name,
						targetName: targetName,
						status: "AVAILABLE",
					};
				}
			}),
		);

		return new Response(JSON.stringify({ plan }), {
			headers: { "Content-Type": "application/json" },
		});
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : "Unknown error";
		return new Response(JSON.stringify({ error: message }), { status: 500 });
	}
}

async function migrateUserData(
	user: typeof users.$inferSelect,
	params: MigrationParams,
) {
	const { endpoint, accessKeyId, secretAccessKey, bucketMapping } = params;

	const cleanEndpoint = endpoint ? endpoint.trim() : "";
	const cleanAccessKey = accessKeyId ? accessKeyId.trim() : "";
	const cleanSecretKey = secretAccessKey ? secretAccessKey.trim() : "";

	if (!cleanEndpoint || !cleanAccessKey || !cleanSecretKey || !bucketMapping) {
		return new Response(JSON.stringify({ error: "Missing required fields" }), {
			status: 400,
		});
	}

	try {
		new URL(cleanEndpoint);
	} catch (_e) {
		return new Response(JSON.stringify({ error: "Invalid endpoint URL" }), {
			status: 400,
		});
	}

	const currentEndpoint = s3Client.getEndpoint();
	if (cleanEndpoint.includes(currentEndpoint)) {
		return new Response(
			JSON.stringify({ error: "Cannot migrate to the same Silo instance" }),
			{ status: 400 },
		);
	}

	MIGRATION_LOCKS.add(user.id);

	const isDebug =
		!config.isProduction &&
		cleanAccessKey === "348f6572f69435b0d014457e5b385966" &&
		cleanSecretKey ===
			"01e5df70067643e26b38c22780b621df26be0f089602492f2323a0747448378d";

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (
				msg: string,
				type: "info" | "success" | "error" = "info",
			) => {
				const payload = JSON.stringify({ text: msg, type });
				controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
			};

			if (isDebug) {
				try {
					send(
						"[DEBUG MODE] Using mock credentials. No data will be transferred.",
						"info",
					);
					await new Promise((r) => setTimeout(r, 1000));

					if (!user.dataExported) {
						send("Freezing Silo account...", "info");
						await db
							.update(users)
							.set({ dataExported: true })
							.where(eq(users.id, user.id));
						await new Promise((r) => setTimeout(r, 800));
					}

					const userBuckets = await db
						.select()
						.from(buckets)
						.where(eq(buckets.userId, user.id));
					send(`Found ${userBuckets.length} buckets to migrate.`);

					let totalFiles = 0;

					send("Phase 1: Creating destination buckets...", "info");
					for (const sourceBucket of userBuckets) {
						const targetName = bucketMapping[sourceBucket.name];
						if (!targetName) continue;

						send(`Ensuring target bucket '${targetName}' exists...`);
						await new Promise((r) => setTimeout(r, 500));
					}
					send("All buckets ready.", "success");
					await new Promise((r) => setTimeout(r, 500));

					send("Phase 2: Migrating files...", "info");
					for (const sourceBucket of userBuckets) {
						const targetName = bucketMapping[sourceBucket.name];
						if (!targetName) continue;

						send(
							`Migrating '${sourceBucket.name}' -> '${targetName}'...`,
							"info",
						);

						// Fake file list
						send(`Scanning bucket: ${sourceBucket.name}...`);
						await new Promise((r) => setTimeout(r, 800));

						// Simulate 5 files per bucket
						for (let i = 1; i <= 5; i++) {
							const filename = `example-file-${i}.jpg`;
							send(`Transferred ${filename}...`);
							await new Promise((r) => setTimeout(r, 200));
							totalFiles++;
						}
					}

					send("----------------------------------------");
					send(`Migration Complete!`, "success");
					send(
						`Total: ${totalFiles} | Success: ${totalFiles} | Failed: 0`,
						"success",
					);
					send(
						"All files migrated successfully! (Debug Simulation)",
						"success",
					);
				} catch (e: unknown) {
					const message = e instanceof Error ? e.message : String(e);
					send(`Debug Error: ${message}`, "error");
				} finally {
					MIGRATION_LOCKS.delete(user.id);
					controller.close();
				}
				return;
			}

			try {
				send("Initializing migration...", "info");

				const destClient = new AwsClient({
					accessKeyId: cleanAccessKey,
					secretAccessKey: cleanSecretKey,
					service: "s3",
					region: "auto",
				});

				const userBuckets = await db
					.select()
					.from(buckets)
					.where(eq(buckets.userId, user.id));

				send("Verifying destination buckets...", "info");
				let bucketCreationErrors = 0;

				for (const localBucket of userBuckets) {
					const targetName = bucketMapping[localBucket.name];
					if (!targetName) continue;

					const bucketUrl = `${cleanEndpoint.replace(/\/+$/, "")}/${targetName}`;

					try {
						send(`Ensuring target bucket '${targetName}' exists...`);
						const putRes = await destClient.fetch(bucketUrl, { method: "PUT" });

						if (!putRes.ok) {
							if (putRes.status === 409) {
								const listRes = await destClient.fetch(
									`${bucketUrl}?max-keys=1`,
									{ method: "GET" },
								);
								if (!listRes.ok) {
									send(
										`Error: Bucket '${targetName}' exists but is not accessible (Status ${listRes.status}).`,
										"error",
									);
									bucketCreationErrors++;
								}
							} else if (putRes.status === 403) {
								const err = await getS3Error(putRes);
								send(
									`Error: Access Denied creating bucket '${targetName}': ${err}`,
									"error",
								);
								bucketCreationErrors++;
							} else {
								const err = await getS3Error(putRes);
								send(
									`Error: Failed to create bucket '${targetName}': ${err}`,
									"error",
								);
								bucketCreationErrors++;
							}
						}
					} catch (e: unknown) {
						const message = e instanceof Error ? e.message : String(e);
						send(
							`Network Error checking bucket '${targetName}': ${message}`,
							"error",
						);
						bucketCreationErrors++;
					}
				}

				if (bucketCreationErrors > 0) {
					send("----------------------------------------");
					send(
						`Warning: Failed to prepare ${bucketCreationErrors} buckets.`,
						"error",
					);
					send(
						"We will attempt to migrate the remaining accessible buckets.",
						"info",
					);
				}

				if (!user.dataExported) {
					send("Freezing Silo account to ensure data integrity...");
					await db
						.update(users)
						.set({ dataExported: true })
						.where(eq(users.id, user.id));
				}

				let totalFiles = 0;
				let successFiles = 0;
				let failFiles = 0;

				for (const sourceBucket of userBuckets) {
					const targetName = bucketMapping[sourceBucket.name];
					if (!targetName) {
						send(
							`Skipping bucket '${sourceBucket.name}' (no target mapped)`,
							"info",
						);
						continue;
					}

					send(
						`Migrating '${sourceBucket.name}' -> '${targetName}'...`,
						"info",
					);

					const internalPrefix = getInternalPath("", user, sourceBucket);
					let continuationToken: string | undefined;

					do {
						const query = new URLSearchParams();
						query.set("list-type", "2");
						query.set("prefix", internalPrefix);
						if (continuationToken)
							query.set("continuation-token", continuationToken);

						const listRes = await s3Client.fetch(`?${query.toString()}`, {
							method: "GET",
						});
						if (!listRes.ok) {
							send(
								`Failed to list bucket ${sourceBucket.name}: ${listRes.status}`,
								"error",
							);
							break;
						}

						const xml = await listRes.text();
						const { XMLParser } = await import("fast-xml-parser");
						const parser = new XMLParser();
						const result = parser.parse(xml).ListBucketResult;

						const contents = result.Contents
							? Array.isArray(result.Contents)
								? result.Contents
								: [result.Contents]
							: [];

						for (const item of contents) {
							totalFiles++;
							const key = item.Key;
							const relativeKey = key.replace(internalPrefix, "");

							const destUrl = `${cleanEndpoint.replace(/\/+$/, "")}/${targetName}/${relativeKey}`;

							try {
								const getRes = await s3Client.fetch(key, { method: "GET" });
								if (!getRes.ok)
									throw new Error(`Read failed: ${getRes.status}`);

								const headers: Record<string, string> = {};
								if (getRes.headers.get("content-type")) {
									headers["Content-Type"] =
										getRes.headers.get("content-type") ||
										"application/octet-stream";
								}

								let body: ReadableStream | Blob | null = getRes.body;
								let contentLength = getRes.headers.get("content-length");

								if (!contentLength && item.Size !== undefined) {
									contentLength = item.Size.toString();
								}

								if (!contentLength) {
									try {
										const headRes = await s3Client.fetch(key, {
											method: "HEAD",
										});
										if (headRes.ok) {
											const headCL = headRes.headers.get("content-length");
											if (headCL) {
												contentLength = headCL;
												// send(`DEBUG: Found size via HEAD: ${contentLength}`, "info");
											}
										}
									} catch (_e) {
										// Ignore HEAD errors
									}
								}

								// Convert stream to Blob to ensure Content-Length is sent.
								// Upstream S3 providers often reject chunked encoding.
								if (
									body &&
									typeof body === "object" &&
									"getReader" in body &&
									typeof (body as ReadableStream).getReader === "function"
								) {
									body = await getRes.blob();
									contentLength = (body as Blob).size.toString();
								}

								if (contentLength) {
									headers["Content-Length"] = contentLength;
								} else {
									throw new Error(
										"MissingContentLength: Could not resolve file size. S3 PUT requires Content-Length.",
									);
								}

								getRes.headers.forEach((val, name) => {
									if (name.toLowerCase().startsWith("x-amz-meta-")) {
										headers[name] = val;
									}
								});

								try {
									const tagRes = await s3Client.fetch(`${key}?tagging`, {
										method: "GET",
									});
									if (tagRes.ok) {
										const tXml = await tagRes.text();
										const tRes = parser.parse(tXml);
										const tagSet = tRes.Tagging?.TagSet?.Tag;
										if (tagSet) {
											const tagArray = Array.isArray(tagSet)
												? tagSet
												: [tagSet];
											const tagStr = tagArray
												.map(
													(t: { Key: string; Value: string }) =>
														`${t.Key}=${t.Value}`,
												)
												.join("&");
											if (tagStr) headers["x-amz-tagging"] = tagStr;
										}
									}
								} catch (_e) {
									/* ignore tag fetch errors */
								}

								const putRes = await destClient.fetch(destUrl, {
									method: "PUT",
									headers,
									body: body,
								});

								if (!putRes.ok) {
									const err = await getS3Error(putRes);
									throw new Error(`Write failed: ${err}`);
								}

								successFiles++;
								send(`Transferred ${relativeKey}`, "success");
							} catch (e: unknown) {
								failFiles++;
								const message = e instanceof Error ? e.message : String(e);
								send(`Failed to move ${relativeKey}: ${message}`, "error");
							}
						}
						continuationToken = result.NextContinuationToken;
					} while (continuationToken);
				}

				send("----------------------------------------");
				send(`Migration Complete!`, "success");
				send(
					`Total: ${totalFiles} | Success: ${successFiles} | Failed: ${failFiles}`,
					"success",
				);
				if (failFiles > 0) {
					send("Some files failed. Check the logs above.", "error");
					send("Troubleshooting:", "info");
					send(
						"• AccessDenied: Verify your API Token has 'Object Read & Write' permissions.",
						"info",
					);
					send(
						"• NoSuchBucket: The destination bucket could not be created or found.",
						"info",
					);
					send(
						"• SignatureDoesNotMatch: Check your Secret Access Key.",
						"info",
					);
				} else {
					send("All files migrated successfully!", "success");
				}
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				send(`Critical Error: ${message}`, "error");
			} finally {
				MIGRATION_LOCKS.delete(user.id);
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

async function streamUserData(user: typeof users.$inferSelect) {
	const userBuckets = await db
		.select()
		.from(buckets)
		.where(eq(buckets.userId, user.id));

	const archive = archiver("zip", {
		zlib: { level: 9 },
	});

	const stream = new Readable({
		read() {},
	});

	archive.on("data", (chunk) => {
		stream.push(chunk);
	});

	archive.on("end", () => {
		stream.push(null);
	});

	archive.on("error", (err) => {
		console.error("Archiver error:", err);
		stream.push(null);
	});

	(async () => {
		try {
			const manifestEntries: string[] = [];

			const bagitTxt =
				"BagIt-Version: 0.97\nTag-File-Character-Encoding: UTF-8\n";
			archive.append(bagitTxt, { name: "bagit.txt" });

			for (const bucket of userBuckets) {
				const internalPrefix = getInternalPath("", user, bucket);
				let continuationToken: string | undefined;

				do {
					const query = new URLSearchParams();
					query.set("list-type", "2");
					query.set("prefix", internalPrefix);
					if (continuationToken)
						query.set("continuation-token", continuationToken);

					const listRes = await s3Client.fetch(`?${query.toString()}`, {
						method: "GET",
					});
					if (!listRes.ok) break;

					const xml = await listRes.text();
					const { XMLParser } = await import("fast-xml-parser");
					const parser = new XMLParser();
					const result = parser.parse(xml).ListBucketResult;

					const contents = result.Contents
						? Array.isArray(result.Contents)
							? result.Contents
							: [result.Contents]
						: [];

					// Sequential processing to avoid high memory usage
					for (const item of contents) {
						const key = item.Key;
						const relativeKey = key.replace(internalPrefix, "");
						const bagPath = `data/${bucket.name}/${relativeKey}`;

						const fileRes = await s3Client.fetch(key, { method: "GET" });

						const tags: Record<string, string> = {};
						try {
							const taggingRes = await s3Client.fetch(`${key}?tagging`, {
								method: "GET",
							});
							if (taggingRes.ok) {
								const xml = await taggingRes.text();
								const p = new XMLParser();
								const r = p.parse(xml);
								const tagSet = r.Tagging?.TagSet?.Tag;
								if (tagSet) {
									const tagArray = Array.isArray(tagSet) ? tagSet : [tagSet];
									for (const t of tagArray) {
										tags[t.Key] = t.Value;
									}
								}
							}
						} catch (_e) {
							// Ignore tagging errors
						}

						const userMetadata: Record<string, string> = {};
						if (fileRes.headers) {
							fileRes.headers.forEach((value, key) => {
								if (key.startsWith("x-amz-meta-")) {
									userMetadata[key.replace("x-amz-meta-", "")] = value;
								}
							});
						}

						if (
							Object.keys(tags).length > 0 ||
							Object.keys(userMetadata).length > 0 ||
							fileRes.headers
						) {
							const metaContent = JSON.stringify(
								{
									tags,
									metadata: userMetadata,
									contentType: fileRes.headers.get("content-type"),
									lastModified: fileRes.headers.get("last-modified"),
									eTag: fileRes.headers.get("etag"),
								},
								null,
								2,
							);

							archive.append(metaContent, {
								name: `metadata/${bucket.name}/${relativeKey}.json`,
							});
						}

						if (fileRes.ok && fileRes.body) {
							const reader = fileRes.body.getReader();
							const nodeStream = new Readable({
								async read() {
									const { done, value } = await reader.read();
									if (done) {
										this.push(null);
									} else {
										this.push(Buffer.from(value));
									}
								},
							});

							await new Promise<void>((resolve, reject) => {
								const hash = crypto.createHash("sha256");
								const checksumTransform = new Transform({
									transform(chunk, _encoding, callback) {
										hash.update(chunk);
										this.push(chunk);
										callback();
									},
									flush(callback) {
										const checksum = hash.digest("hex");
										manifestEntries.push(`${checksum}  ${bagPath}`);
										resolve();
										callback();
									},
								});

								nodeStream.on("error", reject);
								checksumTransform.on("error", reject);

								archive.append(nodeStream.pipe(checksumTransform), {
									name: bagPath,
								});
							});
						}
					}
					continuationToken = result.NextContinuationToken;
				} while (continuationToken);
			}

			const manifestContent = manifestEntries.join("\n");
			archive.append(manifestContent, { name: "manifest-sha256.txt" });

			const bagInfo =
				`Payload-Oxum: ${manifestEntries.reduce((acc, _entry) => acc + 0, 0)}.0\n` +
				`Bagging-Date: ${new Date().toISOString().split("T")[0]}\n` +
				`Contact-Name: HackClub\n`;
			archive.append(bagInfo, { name: "bag-info.txt" });

			await archive.finalize();
		} catch (e) {
			console.error("Error generating export archive:", e);
			archive.abort();
		}
	})();

	return new Response(stream as unknown as BodyInit, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="silo-export-${user.id}.zip"`,
		},
	});
}
