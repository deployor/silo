import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { getCurrentUser } from "../../lib/session";
import { render } from "../../lib/view-engine";
import archiver from "archiver";
import { Readable } from "stream";
import { s3Client } from "../../lib/s3-client";
import { getInternalPath } from "../../core/s3/utils";
import { buckets, bucketKeys } from "../../db/schema";

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
				title: "Silo - Graduation",
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

		const html = await render("offboarding", {
			title: "Export Your Data - Silo",
			layout: "main", // or blank if we want to isolate them
			user,
			daysRemaining,
			gracePeriodEndsAt: ends.toLocaleDateString(),
			hideNavLinks: true, // Don't let them wander too much if we want
		});
		return new Response(html, { headers: { "Content-Type": "text/html" } });
	}

	// POST /dashboard/offboarding/download - Trigger download
	if (
		req.method === "POST" &&
		url.pathname === "/dashboard/offboarding/download"
	) {
		// 1. Mark as data exported (Freezes account)
		await db
			.update(users)
			.set({ dataExported: true })
			.where(eq(users.id, user.id));

		// 2. Start streaming ZIP
		return streamUserData(user);
	}

	return new Response("Not Found", { status: 404 });
}

async function streamUserData(user: typeof users.$inferSelect) {
	const userBuckets = await db
		.select()
		.from(buckets)
		.where(eq(buckets.userId, user.id));

	const archive = archiver("zip", {
		zlib: { level: 9 }, // Sets the compression level.
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
		stream.push(null); // End stream on error
	});

    // We process asynchronously to avoid blocking the initial response headers? 
    // Actually, we need to return the stream immediately. 
    // The archiving process happens in the "background" feeding the stream.
	(async () => {
		try {
            // Metadata JSON
            const metadata = {
                user: {
                    id: user.id,
                    email: user.email,
                    slackId: user.slackId,
                    createdAt: user.createdAt,
                },
                buckets: userBuckets.map(b => ({
                    name: b.name,
                    createdAt: b.createdAt,
                    region: b.region
                })),
                exportedAt: new Date().toISOString()
            };
            archive.append(JSON.stringify(metadata, null, 2), { name: "metadata.json" });

			for (const bucket of userBuckets) {
				// List all files in bucket
				const internalPrefix = getInternalPath("", user, bucket);
				
                // We need to list ALL files. For now, simple loop with continuation token handling is best, 
                // but for MVP/V1 assuming <1000 or paginating a bit is okay. 
                // Let's do a simple list loop.
                let continuationToken: string | undefined = undefined;
                
                do {
                    const query = new URLSearchParams();
                    query.set("list-type", "2");
                    query.set("prefix", internalPrefix);
                    if (continuationToken) query.set("continuation-token", continuationToken);

                    const listRes = await s3Client.fetch(`?${query.toString()}`, { method: "GET" });
                    if (!listRes.ok) break;

                    const xml = await listRes.text();
                    // Quick regex parsing to avoid heavy XML parser import if possible, 
                    // OR just import XMLParser since we already use it in admin.
                    // We'll reuse fast-xml-parser from existing dependencies.
                    const { XMLParser } = await import("fast-xml-parser");
                    const parser = new XMLParser();
                    const result = parser.parse(xml).ListBucketResult;
                    
                    const contents = result.Contents 
                        ? (Array.isArray(result.Contents) ? result.Contents : [result.Contents]) 
                        : [];

                    for (const item of contents) {
                         const key = item.Key; // Internal key path
                         const relativeKey = key.replace(internalPrefix, ""); // User visible path
                         
                         // Fetch file stream
                         const fileRes = await s3Client.fetch(key, { method: "GET" });
                         if (fileRes.ok && fileRes.body) {
                            // Convert web stream to node stream for archiver
                            // @ts-ignore - Bun/Node compat usually handles this or we need utility
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
                             
                            archive.append(nodeStream, { name: `${bucket.name}/${relativeKey}` });
                         }
                    }
                    
                    continuationToken = result.NextContinuationToken;

                } while (continuationToken);
			}

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
