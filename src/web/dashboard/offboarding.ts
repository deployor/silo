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

// Simple in-memory rate limiting for exports
// In a production environment with multiple instances, this should be in Redis
const EXPORT_LIMITS = new Map<string, number[]>();
const MAX_EXPORTS_PER_HOUR = 3;

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

	return new Response("Not Found", { status: 404 });
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
