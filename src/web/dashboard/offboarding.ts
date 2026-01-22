import { eq, sql } from "drizzle-orm";
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
	// If dataExported is true, they can still access this page to re-download or check status
	if (!user.markedAsOverAge && !user.dataExported) {
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

		      // Calculate Usage for Estimator
		      // This is a rough sum of all stats if available, or just a placeholder if not calculated
		      // For now, we'll fetch stats sum
		      const stats = await db.execute(sql`
		          SELECT SUM(total_bytes) as total_size
		          FROM buckets
		          WHERE user_id = ${user.id}
		      `);
		      const totalBytes = Number(stats[0]?.total_size || 0);
		      
		      // Format bytes
		      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
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
		          totalStorageFormatted,
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

	// POST /dashboard/offboarding/analyze - Check destination and plan buckets
	if (
		req.method === "POST" &&
		url.pathname === "/dashboard/offboarding/analyze"
	) {
		let body: any;
		try {
			body = await req.json();
		} catch (e) {
			return new Response("Invalid JSON", { status: 400 });
		}
		
		return analyzeMigration(user, body);
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

async function analyzeMigration(user: typeof users.$inferSelect, params: any) {
	const { endpoint, accessKeyId, secretAccessKey, bucketMapping } = params;
	
	if (!endpoint || !accessKeyId || !secretAccessKey) {
		return new Response(JSON.stringify({ error: "Missing required credentials" }), { status: 400 });
	}

    // DEBUG BYPASS: If using the specific debug credentials, return fake data
    if (accessKeyId === '348f6572f69435b0d014457e5b385966' && secretAccessKey === '01e5df70067643e26b38c22780b621df26be0f089602492f2323a0747448378d') {
        const localBuckets = await db
   .select()
   .from(buckets)
   .where(eq(buckets.userId, user.id));

        const plan = localBuckets.map(b => {
            const targetName = bucketMapping && bucketMapping[b.name] ? bucketMapping[b.name] : b.name;
            let status = "AVAILABLE";
            if (targetName.includes("taken")) status = "TAKEN"; // Mock taken
            if (targetName.includes("exists")) status = "EXISTS"; // Mock exists
            
            return {
                localName: b.name,
                targetName: targetName,
                status: status
            };
        });
        
        // Simulating checking
        await new Promise(r => setTimeout(r, 800));

        return new Response(JSON.stringify({ plan }), {
   headers: { "Content-Type": "application/json" }
  });
    }

	try {
		const destClient = new AwsClient({
			accessKeyId,
			secretAccessKey,
			service: "s3",
			region: "auto"
		});

		// 1. Fetch Local Buckets
		const localBuckets = await db
			.select()
			.from(buckets)
			.where(eq(buckets.userId, user.id));

		// 2. Fetch Remote Buckets (ListAllMyBuckets) - Ownership Check
		const listRes = await destClient.fetch(endpoint, { method: "GET" });
		
		if (!listRes.ok) {
			if (listRes.status === 403) {
				return new Response(JSON.stringify({ error: "Access Denied. Check your keys." }), { status: 403 });
			}
			return new Response(JSON.stringify({ error: `Could not connect: ${listRes.status}` }), { status: 400 });
		}

		const xml = await listRes.text();
		const { XMLParser } = await import("fast-xml-parser");
		const parser = new XMLParser();
		const result = parser.parse(xml).ListAllMyBucketsResult;
		
		const remoteBuckets = new Set<string>();
		if (result.Buckets?.Bucket) {
			const bucketsArr = Array.isArray(result.Buckets.Bucket) ? result.Buckets.Bucket : [result.Buckets.Bucket];
			for (const b of bucketsArr) {
                remoteBuckets.add(b.Name);
            }
		}

		// 3. Match & Check Availability
		const plan = await Promise.all(localBuckets.map(async b => {
            const targetName = bucketMapping && bucketMapping[b.name] ? bucketMapping[b.name] : b.name;
            
            // Status 1: Do we own it?
            if (remoteBuckets.has(targetName)) {
                return {
                    localName: b.name,
                    targetName: targetName,
                    status: "EXISTS" // We own it, safe to merge
                };
            }

            // Status 2: Is it available globally? (HEAD Check)
            try {
                const bucketUrl = `${endpoint.replace(/\/+$/, "")}/${targetName}`;
                const headRes = await destClient.fetch(bucketUrl, { method: "HEAD" });
                
                if (headRes.status === 404) {
                     return { localName: b.name, targetName: targetName, status: "AVAILABLE" };
                } else {
                     return { localName: b.name, targetName: targetName, status: "TAKEN" };
                }
            } catch (e) {
                // If we can't even HEAD it (e.g. DNS error), assume available for creation
                return { localName: b.name, targetName: targetName, status: "AVAILABLE" };
            }
        }));

		return new Response(JSON.stringify({ plan }), {
			headers: { "Content-Type": "application/json" }
		});

	} catch (e: any) {
		return new Response(JSON.stringify({ error: e.message }), { status: 500 });
	}
}

async function migrateUserData(user: typeof users.$inferSelect, params: any) {
	const { endpoint, accessKeyId, secretAccessKey, bucketMapping } = params;

	// 1. Validation
	if (!endpoint || !accessKeyId || !secretAccessKey || !bucketMapping) {
		return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
	}

	try {
		new URL(endpoint);
	} catch (e) {
		return new Response(JSON.stringify({ error: "Invalid endpoint URL" }), { status: 400 });
	}

	// 2. Loop Prevention
	const currentEndpoint = s3Client.getEndpoint();
	if (endpoint.includes(currentEndpoint)) {
		return new Response(JSON.stringify({ error: "Cannot migrate to the same Silo instance" }), { status: 400 });
	}
	
	MIGRATION_LOCKS.add(user.id);

    // Check for Debug Creds
    const isDebug = accessKeyId === '348f6572f69435b0d014457e5b385966' && secretAccessKey === '01e5df70067643e26b38c22780b621df26be0f089602492f2323a0747448378d';

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (msg: string, type: "info" | "success" | "error" = "info") => {
				const payload = JSON.stringify({ text: msg, type });
				controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
			};

            // DEBUG MODE MIGRATION
            if (isDebug) {
                try {
                    send("[DEBUG MODE] Using mock credentials. No data will be transferred.", "info");
                    await new Promise(r => setTimeout(r, 1000));

                    // Freeze Account Mock
                    if (!user.dataExported) {
                        send("Freezing Silo account...", "info");
                        await db.update(users).set({ dataExported: true }).where(eq(users.id, user.id));
                        await new Promise(r => setTimeout(r, 800));
                    }

                    const userBuckets = await db.select().from(buckets).where(eq(buckets.userId, user.id));
                    send(`Found ${userBuckets.length} buckets to migrate.`);
                    
                    let totalFiles = 0;

                    for (const sourceBucket of userBuckets) {
                        const targetName = bucketMapping[sourceBucket.name];
                        if (!targetName) continue;
                        
                        send(`Migrating '${sourceBucket.name}' -> '${targetName}'...`, "info");
                        await new Promise(r => setTimeout(r, 500));
                        
                        // Fake creating bucket
                        send(`Ensuring target bucket '${targetName}' exists...`);
                        await new Promise(r => setTimeout(r, 500));

                        // Fake file list
                        send(`Scanning bucket: ${sourceBucket.name}...`);
                        await new Promise(r => setTimeout(r, 800));
                        
                        // Simulate 5 files per bucket
                        for (let i = 1; i <= 5; i++) {
                            const filename = `example-file-${i}.jpg`;
                            send(`Transferred ${filename}...`);
                            await new Promise(r => setTimeout(r, 200));
                            totalFiles++;
                        }
                    }

                    send("----------------------------------------");
                    send(`Migration Complete!`, "success");
                    send(`Total: ${totalFiles} | Success: ${totalFiles} | Failed: 0`, "success");
                    send("All files migrated successfully! (Debug Simulation)", "success");

                } catch (e: any) {
                    send(`Debug Error: ${e.message}`, "error");
                } finally {
                    MIGRATION_LOCKS.delete(user.id);
                    controller.close();
                }
                return;
            }

            // REAL MIGRATION
			try {
				send("Initializing migration...", "info");
				
				// Initialize Destination Client
				const destClient = new AwsClient({
					accessKeyId,
					secretAccessKey,
					service: "s3",
					region: "auto"
				});

				// Fetch User Buckets
				const userBuckets = await db
					.select()
					.from(buckets)
					.where(eq(buckets.userId, user.id));

				// Pre-flight: Create/Check Destination Buckets
				send("Verifying destination buckets...", "info");
				let bucketCreationErrors = 0;

				for (const localBucket of userBuckets) {
					const targetName = bucketMapping[localBucket.name];
					if (!targetName) continue;

					const bucketUrl = `${endpoint.replace(/\/+$/, "")}/${targetName}`;
					
					try {
						send(`Ensuring target bucket '${targetName}' exists...`);
						// Attempt to create bucket (idempotent if owned)
						const putRes = await destClient.fetch(bucketUrl, { method: "PUT" });
						
						if (!putRes.ok) {
							if (putRes.status === 409) {
				                            // Conflict: Bucket exists.
				                            // If we own it (BucketAlreadyOwnedByYou), it's fine.
				                            // If someone else owns it (BucketAlreadyExists), we can't write to it.
				                            // We'll try to ListObjects to verify ownership/access.
				                            const listRes = await destClient.fetch(`${bucketUrl}?max-keys=1`, { method: "GET" });
				                            if (!listRes.ok) {
				                                send(`Error: Bucket '${targetName}' exists but is not accessible (Status ${listRes.status}).`, "error");
				                                bucketCreationErrors++;
				                            }
							} else if (putRes.status === 403) {
				                            send(`Error: Access Denied creating bucket '${targetName}'. Check permissions.`, "error");
				                            bucketCreationErrors++;
				                        } else {
				                            send(`Error: Failed to create bucket '${targetName}' (Status ${putRes.status}).`, "error");
				                            bucketCreationErrors++;
							}
						}
					} catch (e: any) {
				                    send(`Network Error checking bucket '${targetName}': ${e.message}`, "error");
				                    bucketCreationErrors++;
					}
				}

				if (bucketCreationErrors > 0) {
					send("----------------------------------------");
					send(`Warning: Failed to prepare ${bucketCreationErrors} buckets.`, "error");
					send("We will attempt to migrate the remaining accessible buckets.", "info");
					// Do not abort, proceed with migration for other buckets
				}

				// Freeze Account
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
						send(`Skipping bucket '${sourceBucket.name}' (no target mapped)`, "info");
						continue;
					}

					send(`Migrating '${sourceBucket.name}' -> '${targetName}'...`, "info");
					
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
							
							// Destination Path: /{targetBucket}/{relativeKey}
							// IMPORTANT: aws4fetch/S3 url structure depends on path-style vs virtual-hosted
							// We'll stick to constructing the URL manually for path-style support which R2 supports well enough
							const destUrl = `${endpoint.replace(/\/+$/, "")}/${targetName}/${relativeKey}`;

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
								const putRes = await destClient.fetch(destUrl, {
									method: "PUT",
									headers,
									body: getRes.body // Pipe the stream
								});

								if (!putRes.ok) {
									throw new Error(`Write failed: ${putRes.status}`);
								}

								successFiles++;
								if (successFiles % 10 === 0) {
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
					send("Some files failed. Check the logs above.", "info");
				} else {
					send("All files migrated successfully!", "success");
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
