import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { getCurrentUser } from "../../lib/session";
import { render } from "../../lib/view-engine";
import archiver from "archiver";
import { Readable, Transform } from "stream";
import { s3Client } from "../../lib/s3-client";
import { getInternalPath } from "../../core/s3/utils";
import { buckets } from "../../db/schema";
import crypto from "crypto";
import { AwsClient } from "aws4fetch";

// Simple in-memory rate limiting for exports
// In a production environment with multiple instances, this should be in Redis
const EXPORT_LIMITS = new Map<string, number[]>();
const MAX_EXPORTS_PER_HOUR = 3;
// Lock to prevent multiple simultaneous migrations for the same user
const MIGRATION_LOCKS = new Set<string>();

function checkExportRateLimit(userId: string): boolean {
	const now = Date.now();
	const timestamps = EXPORT_LIMITS.get(userId) || [];
	
	// Filter out timestamps older than 1 hour
	const recent = timestamps.filter(t => now - t < 60 * 60 * 1000);
	
	if (recent.length >= MAX_EXPORTS_PER_HOUR) {
		return false;
	}
	
	recent.push(now);
	EXPORT_LIMITS.set(userId, recent);
	return true;
}

export async function handleOffboardingRequest(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) {
		return Response.redirect("/auth/login");
	}

	const url = new URL(req.url);

	// Ensure user is actually offboarding
	if (!user.markedAsOverAge) {
		return Response.redirect("/");
	}

	// GET /dashboard/offboarding - Show export portal
	if (req.method === "GET" && url.pathname === "/dashboard/offboarding") {
		// If files already deleted, show "Aged Out" page
		if (user.filesDeleted) {
			const html = await render("aged-out", {
				title: "Silo - Offboarding",
				layout: "blank",
				user,
			});
			return new Response(html, { headers: { "Content-Type": "text/html" } });
		}

		// Calculate days remaining
		const now = new Date();
		const ends = user.overAgeGracePeriodEndsAt
			? new Date(user.overAgeGracePeriodEndsAt)
			: now;
		const diffTime = Math.max(0, ends.getTime() - now.getTime());
		const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
		      
		const totalDays = 60;
		const progressPercentage = Math.min(100, Math.max(0, ((totalDays - daysRemaining) / totalDays) * 100));

		const html = await render("offboarding", {
			title: "Export Your Data - Silo",
			layout: "main",
			user,
			daysRemaining,
		    progressPercentage: progressPercentage.toFixed(1),
			gracePeriodEndsAt: ends.toLocaleDateString(),
			hideNavLinks: true,
			showSuccess: url.searchParams.get("success") === "1",
		});
		return new Response(html, { headers: { "Content-Type": "text/html" } });
	}

	// GET /dashboard/offboarding/archive - Actual download stream
	if (
		req.method === "GET" &&
		url.pathname === "/dashboard/offboarding/archive"
	) {
		if (!checkExportRateLimit(user.id)) {
			return new Response(
				"Export rate limit exceeded. You can only generate 3 exports per hour. Please try again later.",
				{ status: 429 }
			);
		}
		return streamUserData(user);
	}

	// POST /dashboard/offboarding/download - Trigger state change + redirect
	if (
		req.method === "POST" &&
		url.pathname === "/dashboard/offboarding/download"
	) {
		// 1. Mark as data exported (Freezes account) if not already
		if (!user.dataExported) {
			await db
				.update(users)
				.set({ dataExported: true })
				.where(eq(users.id, user.id));
			
			// Redirect to success page for the first time
			return Response.redirect("/dashboard/offboarding?success=1");
		}

		// If already exported, just redirect to the archive download
		return Response.redirect("/dashboard/offboarding/archive");
	}

	// POST /dashboard/offboarding/migrate - Handle automated migration
	if (
		req.method === "POST" &&
		url.pathname === "/dashboard/offboarding/migrate"
	) {
		if (MIGRATION_LOCKS.has(user.id)) {
			return new Response("Migration already in progress", { status: 409 });
		}
		
		let body: any;
		try {
			body = await req.json();
		} catch (e) {
			return new Response("Invalid JSON", { status: 400 });
		}
		
		return migrateUserData(user, body);
	}

	return new Response("Not Found", { status: 404 });
}

async function migrateUserData(user: typeof users.$inferSelect, params: any) {
	const { endpoint, bucket: targetBucket, accessKeyId, secretAccessKey } = params;

	// 1. Validation
	if (!endpoint || !targetBucket || !accessKeyId || !secretAccessKey) {
		return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
	}

	try {
		new URL(endpoint);
	} catch (e) {
		return new Response(JSON.stringify({ error: "Invalid endpoint URL" }), { status: 400 });
	}

	// 2. Loop Prevention
	const currentEndpoint = s3Client.getEndpoint(); // e.g. "s3.yourdomain.com"
	if (endpoint.includes(currentEndpoint)) {
		return new Response(JSON.stringify({ error: "Cannot migrate to the same Silo instance" }), { status: 400 });
	}
	
	MIGRATION_LOCKS.add(user.id);

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (msg: string, type: "info" | "success" | "error" = "info") => {
				const payload = JSON.stringify({ text: msg, type });
				controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
			};

			try {
				send("Validating destination credentials...");
				
				// Initialize Destination Client
				const destClient = new AwsClient({
					accessKeyId,
					secretAccessKey,
					service: "s3",
					region: "auto" // R2 uses 'auto', others might ignore or need specific
				});

				// Helper to fetch from destination
				const fetchDest = async (path: string, init?: RequestInit) => {
					// AwsClient doesn't handle full URL construction with custom endpoints automatically
					// in the way we need for all providers, so we build it manually.
					// R2/S3 format: https://<bucket>.<endpoint>/<key> or https://<endpoint>/<bucket>/<key>
					// We'll assume path-style for safety if not virtual-hosted capable
					
					let urlStr = endpoint;
					if (!urlStr.endsWith("/")) urlStr += "/";
					urlStr += targetBucket;
					if (path) urlStr += path.startsWith("/") ? path : `/${path}`;
					
					return destClient.fetch(urlStr, init);
				};

				// Test Connection (List Objects on target bucket)
				try {
					const testRes = await fetchDest("?max-keys=1", { method: "GET" });
					if (!testRes.ok) {
						if (testRes.status === 404) {
							throw new Error("Target bucket does not exist. Please create it first.");
						} else if (testRes.status === 403) {
							throw new Error("Access denied. Check your credentials.");
						} else {
							throw new Error(`Connection failed: ${testRes.status} ${testRes.statusText}`);
						}
					}
					send("Connection established successfully.", "success");
				} catch (e: any) {
					send(`Connection failed: ${e.message}`, "error");
					throw e; // Stop execution
				}

				// Freeze Account
				if (!user.dataExported) {
					send("Freezing Silo account to ensure data integrity...");
					await db
						.update(users)
						.set({ dataExported: true })
						.where(eq(users.id, user.id));
				}

				// Fetch User Buckets
				const userBuckets = await db
					.select()
					.from(buckets)
					.where(eq(buckets.userId, user.id));

				send(`Found ${userBuckets.length} buckets to migrate.`);

				let totalFiles = 0;
				let successFiles = 0;
				let failFiles = 0;

				for (const sourceBucket of userBuckets) {
					send(`Scanning bucket: ${sourceBucket.name}...`);
					const internalPrefix = getInternalPath("", user, sourceBucket);
					let continuationToken: string | undefined = undefined;

					do {
						// List Objects from Silo
						const query = new URLSearchParams();
						query.set("list-type", "2");
						query.set("prefix", internalPrefix);
						if (continuationToken) query.set("continuation-token", continuationToken);

						const listRes = await s3Client.fetch(`?${query.toString()}`, { method: "GET" });
						if (!listRes.ok) {
							send(`Failed to list bucket ${sourceBucket.name}: ${listRes.status}`, "error");
							break;
						}

						const xml = await listRes.text();
						const { XMLParser } = await import("fast-xml-parser");
						const parser = new XMLParser();
						const result = parser.parse(xml).ListBucketResult;
						
						const contents = result.Contents
							? (Array.isArray(result.Contents) ? result.Contents : [result.Contents])
							: [];

						for (const item of contents) {
							totalFiles++;
							const key = item.Key;
							const relativeKey = key.replace(internalPrefix, "");
							// Destination structure: <target-bucket>/<source-bucket-name>/<key>
							// This keeps files organized by original bucket
							const destPath = `/${sourceBucket.name}/${relativeKey}`;

							try {
								// 1. Get from Silo
								const getRes = await s3Client.fetch(key, { method: "GET" });
								if (!getRes.ok) throw new Error(`Read failed: ${getRes.status}`);

								// 2. Prepare Metadata & Tags
								const headers: Record<string, string> = {};
								if (getRes.headers.get("content-type")) {
									headers["Content-Type"] = getRes.headers.get("content-type")!;
								}
								
								// Copy User Metadata
								getRes.headers.forEach((val, name) => {
									if (name.toLowerCase().startsWith("x-amz-meta-")) {
										headers[name] = val;
									}
								});

								// Fetch Tags (best effort)
								try {
									const tagRes = await s3Client.fetch(`${key}?tagging`, { method: "GET" });
									if (tagRes.ok) {
										const tXml = await tagRes.text();
										const tRes = parser.parse(tXml);
										const tagSet = tRes.Tagging?.TagSet?.Tag;
										if (tagSet) {
											const tagArray = Array.isArray(tagSet) ? tagSet : [tagSet];
											const tagStr = tagArray.map((t: any) => `${t.Key}=${t.Value}`).join("&");
											if (tagStr) headers["x-amz-tagging"] = tagStr;
										}
									}
								} catch (e) { /* ignore tag fetch errors */ }

								// 3. Put to Destination
								// We can pass the stream body directly
								const putRes = await fetchDest(destPath, {
									method: "PUT",
									headers,
									body: getRes.body // Pipe the stream
								});

								if (!putRes.ok) {
									throw new Error(`Write failed: ${putRes.status} ${await putRes.text()}`);
								}

								successFiles++;
								// Throttle logs slightly to avoid flooding
								if (successFiles % 5 === 0) {
									send(`Transferred ${successFiles} files...`);
								}
							} catch (e: any) {
								failFiles++;
								send(`Failed to move ${relativeKey}: ${e.message}`, "error");
							}
						}
						continuationToken = result.NextContinuationToken;
					} while (continuationToken);
				}

				send("----------------------------------------");
				send(`Migration Complete!`, "success");
				send(`Total: ${totalFiles} | Success: ${successFiles} | Failed: ${failFiles}`, "success");
				if (failFiles > 0) {
					send("Some files failed. You can retry migration to retry failed files.", "info");
				} else {
					send("All files have been safely moved to your new home. Goodbye! 👋", "success");
				}

			} catch (e: any) {
				send(`Critical Error: ${e.message}`, "error");
			} finally {
				MIGRATION_LOCKS.delete(user.id);
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive"
		}
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

            // BagIt: bagit.txt
            const bagitTxt = "BagIt-Version: 0.97\nTag-File-Character-Encoding: UTF-8\n";
            archive.append(bagitTxt, { name: "bagit.txt" });

			for (const bucket of userBuckets) {
				const internalPrefix = getInternalPath("", user, bucket);
                let continuationToken: string | undefined = undefined;
                
                do {
                    const query = new URLSearchParams();
                    query.set("list-type", "2");
                    query.set("prefix", internalPrefix);
                    if (continuationToken) query.set("continuation-token", continuationToken);

                    const listRes = await s3Client.fetch(`?${query.toString()}`, { method: "GET" });
                    if (!listRes.ok) break;

                    const xml = await listRes.text();
                    const { XMLParser } = await import("fast-xml-parser");
                    const parser = new XMLParser();
                    const result = parser.parse(xml).ListBucketResult;
                    
                    const contents = result.Contents 
                        ? (Array.isArray(result.Contents) ? result.Contents : [result.Contents]) 
                        : [];

                    // SEQUENTIAL PROCESSING to avoid RAM explosion with Promise.all on huge buckets
                    for (const item of contents) {
                         const key = item.Key;
                         const relativeKey = key.replace(internalPrefix, "");
                         const bagPath = `data/${bucket.name}/${relativeKey}`;

                         // 1. Fetch File Content
                         const fileRes = await s3Client.fetch(key, { method: "GET" });
                         
                         // 2. Fetch Object Tags
                         let tags: Record<string, string> = {};
                         try {
                             const taggingRes = await s3Client.fetch(`${key}?tagging`, { method: "GET" });
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
                         } catch (e) {
                             // Ignore tagging errors
                         }

                         // 3. User Metadata
                         const userMetadata: Record<string, string> = {};
                         if (fileRes.headers) {
                             fileRes.headers.forEach((value, key) => {
                                 if (key.startsWith("x-amz-meta-")) {
                                     userMetadata[key.replace("x-amz-meta-", "")] = value;
                                 }
                             });
                         }

                         // 4. Create Metadata JSON Sidecar
                         if (Object.keys(tags).length > 0 || Object.keys(userMetadata).length > 0 || fileRes.headers) {
                             const metaContent = JSON.stringify({
                                 tags,
                                 metadata: userMetadata,
                                 contentType: fileRes.headers.get("content-type"),
                                 lastModified: fileRes.headers.get("last-modified"),
                                 eTag: fileRes.headers.get("etag")
                             }, null, 2);
                             
                             archive.append(metaContent, { name: `metadata/${bucket.name}/${relativeKey}.json` });
                         }

                         if (fileRes.ok && fileRes.body) {
                            // @ts-ignore
                            const reader = fileRes.body.getReader();
                            const nodeStream = new Readable({
                                async read() {
                                    const { done, value } = await reader.read();
                                    if (done) {
                                        this.push(null);
                                    } else {
                                        this.push(Buffer.from(value));
                                    }
                                }
                            });
                             
                            await new Promise<void>((resolve, reject) => {
                                const hash = crypto.createHash('sha256');
                                const checksumTransform = new Transform({
                                    transform(chunk, encoding, callback) {
                                        hash.update(chunk);
                                        this.push(chunk);
                                        callback();
                                    },
                                    flush(callback) {
                                        const checksum = hash.digest('hex');
                                        manifestEntries.push(`${checksum}  ${bagPath}`);
                                        resolve();
                                        callback();
                                    }
                                });
                                
                                nodeStream.on('error', reject);
                                checksumTransform.on('error', reject);
                                
                                // We append the TRANSFORMED stream to archive
                                // Archiver will drain this stream before accepting the next append?
                                // Actually, archiver queues appends. But since we await the stream completion (resolve)
                                // inside this loop, we effectively serialize the download -> zip pipe.
                                // This ensures we don't open 1000 connections or buffer 1TB of data.
                                archive.append(nodeStream.pipe(checksumTransform), { name: bagPath });
                                
                                // IMPORTANT: We must wait for the stream to be fully consumed by archiver
                                // before moving to the next file to prevent memory buildup?
                                // 'flush' on checksumTransform is called when the stream ends.
                                // So awaiting this Promise ensures the file is fully processed.
                            });
                         }
                    }
                    continuationToken = result.NextContinuationToken;
                } while (continuationToken);
			}

            // Append Manifest
            const manifestContent = manifestEntries.join("\n");
            archive.append(manifestContent, { name: "manifest-sha256.txt" });
            
            // Append Bag Info
             const bagInfo = `Payload-Oxum: ${manifestEntries.reduce((acc, entry) => acc + 0, 0)}.0\n` + 
                            `Bagging-Date: ${new Date().toISOString().split('T')[0]}\n` +
                            `Contact-Name: HackClub\n`;
            archive.append(bagInfo, { name: "bag-info.txt" });

            // Finalize Archive
			await archive.finalize();
		} catch (e) {
			console.error("Error generating export archive:", e);
            archive.abort();
		}
	})();

	return new Response(stream as any, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="silo-export-${user.id}.zip"`,
		},
	});
}
