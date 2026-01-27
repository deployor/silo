import { context } from "../../lib/context";
import { render } from "../../lib/view-engine";
import { YswsService } from "../../services/ysws-service";
import { SettingsService } from "../../services/settings-service";
import { getCurrentUser } from "../../lib/session";
import { z } from "zod";
import { s3Client } from "../../lib/s3-client";
import { config } from "../../config";
import { getInternalPath } from "../../core/s3/utils";
import { db } from "../../db";
import { buckets, users } from "../../db/schema";
import { eq } from "drizzle-orm";

// Mock Hackatime Projects
const MOCK_HACKATIME_PROJECTS = [
    { id: "proj_1", name: "My Cool Website", hours: 4 },
    { id: "proj_2", name: "Discord Bot", hours: 12 },
    { id: "proj_3", name: "S3 Thing", hours: 25 },
    { id: "proj_4", name: "Portfolio", hours: 1 },
];

const SubmissionSchema = z.object({
    projectName: z.string().min(1, "Project name is required"),
    shortDescription: z.string().min(1, "Description is required"),
    repoUrl: z.string().url("Invalid Repository URL"),
    demoUrl: z.string().url("Invalid Demo URL"),
    hackatimeProject: z.string().optional(),
    usedAi: z.enum(["yes", "no"]),
    aiToolUsage: z.string().optional(),
    aiUsageDescription: z.string().optional(),
    aiPercent: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(0).max(100)),
    screenshotUrl: z.string().url("Invalid Screenshot URL").optional().or(z.literal("")),
    readmeConfirmed: z.literal("on", { errorMap: () => ({ message: "You must confirm the README is good" }) }),
});

export async function handleYswsRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const user = await getCurrentUser(req);

    if (!user) {
        return new Response(null, {
            status: 302,
            headers: { Location: "/auth/login?next=" + encodeURIComponent(url.pathname) },
        });
    }

    const appSettings = await SettingsService.getAppSettings();

    if (req.method === "GET") {
        if (url.pathname === "/ysws") {
            return new Response(await render("ysws", {
                title: "Ship to Earn",
                user,
                hackatimeProjects: MOCK_HACKATIME_PROJECTS,
                quotaPerHour: appSettings.yswsQuotaPerHourBytes,
                quotaPerHourFormatted: (appSettings.yswsQuotaPerHourBytes / (1024 * 1024)).toFixed(0) + " MB"
            }), {
                headers: { "Content-Type": "text/html" },
            });
        }
    }

    if (req.method === "POST" && url.pathname === "/ysws/submit") {
        try {
            const formData = await req.formData();
            const data = Object.fromEntries(formData.entries());
            
            const validation = SubmissionSchema.safeParse(data);

            if (!validation.success) {
                 return new Response(await render("ysws", {
                    title: "Ship to Earn",
                    user,
                    hackatimeProjects: MOCK_HACKATIME_PROJECTS,
                    quotaPerHour: appSettings.yswsQuotaPerHourBytes,
                    errors: validation.error.flatten().fieldErrors,
                    values: data
                }), {
                    headers: { "Content-Type": "text/html" },
                });
            }

            const validData = validation.data;
            
            if (validData.aiPercent > 50) {
                 return new Response(await render("ysws", {
                    title: "Ship to Earn",
                    user,
                    hackatimeProjects: MOCK_HACKATIME_PROJECTS,
                    quotaPerHour: appSettings.yswsQuotaPerHourBytes,
                    error: "AI contribution cannot exceed 50%",
                    values: data
                }), {
                    headers: { "Content-Type": "text/html" },
                });
            }

            // Find hours from hackatime project
            let hoursSpent = 0;
            let hackatimeProjectName = "";
            if (validData.hackatimeProject) {
                const project = MOCK_HACKATIME_PROJECTS.find(p => p.id === validData.hackatimeProject);
                if (project) {
                    hoursSpent = project.hours;
                    hackatimeProjectName = project.name;
                }
            }
            
            let screenshotUrl = validData.screenshotUrl;
            
            // Handle Screenshot Upload
            const screenshotFile = formData.get("screenshotFile");
            if (screenshotFile && screenshotFile instanceof File && screenshotFile.size > 0) {
                try {
                    // Create or get 'ysws' bucket owned by admin/system or current user?
                    // We'll create a 'ysws' system bucket if it doesn't exist, owned by this user for simplicity in this context,
                    // or better: a dedicated system bucket. But we need an owner.
                    // Let's use the current user's bucket or a specific 'ysws-assets' bucket.
                    // For now, let's just upload to a public 'ysws' bucket owned by the first admin found, or the current user.
                    // User requested "we handle the upload into our bucket and make like a public whatever bucket for system".
                    
                    const systemBucketName = "ysws";
                    
                    // Check if bucket exists
                    let bucket = await db.select().from(buckets).where(eq(buckets.name, systemBucketName)).limit(1);
                    
                    if (bucket.length === 0) {
                        // Create it if not exists. Assign to current user for ownership.
                        // In real app, this should be a system user.
                        const newBucket = await db.insert(buckets).values({
                            name: systemBucketName,
                            userId: user.id,
                            isPublic: true,
                            region: "auto",
                        }).returning();
                        bucket = newBucket;
                    }

                    const targetBucket = bucket[0];
                    const ext = screenshotFile.name.split(".").pop() || "png";
                    const fileName = `screenshots/${crypto.randomUUID()}.${ext}`;
                    const internalPath = getInternalPath(fileName, user, targetBucket);
                    const fileBuffer = await screenshotFile.arrayBuffer();

                    // Upload to S3
                    await s3Client.fetch(internalPath, {
                        method: "PUT",
                        body: fileBuffer,
                        headers: {
                            "Content-Type": screenshotFile.type || "application/octet-stream",
                        }
                    });

                    // Construct Public URL
                    screenshotUrl = `https://${config.s3Domain}/${systemBucketName}/${fileName}`;

                } catch (uploadError) {
                    console.error("Screenshot upload failed:", uploadError);
                     return new Response(await render("ysws", {
                        title: "Ship to Earn",
                        user,
                        hackatimeProjects: MOCK_HACKATIME_PROJECTS,
                        quotaPerHour: appSettings.yswsQuotaPerHourBytes,
                        error: "Failed to upload screenshot. Please try again or use a URL.",
                        values: data
                    }), {
                        headers: { "Content-Type": "text/html" },
                    });
                }
            } else if (!screenshotUrl) {
                // Require either file or URL
                 return new Response(await render("ysws", {
                    title: "Ship to Earn",
                    user,
                    hackatimeProjects: MOCK_HACKATIME_PROJECTS,
                    quotaPerHour: appSettings.yswsQuotaPerHourBytes,
                    error: "Please provide a screenshot URL or upload a file.",
                    values: data
                }), {
                    headers: { "Content-Type": "text/html" },
                });
            }

            await YswsService.createSubmission({
                userId: user.id,
                projectName: validData.projectName,
                shortDescription: validData.shortDescription,
                repoUrl: validData.repoUrl,
                demoUrl: validData.demoUrl,
                hackatimeProject: hackatimeProjectName, // Store name or ID? Schema says text.
                hoursSpent: hoursSpent,
                usedAi: validData.usedAi === "yes",
                aiToolUsage: validData.aiToolUsage,
                aiUsageDescription: validData.aiUsageDescription,
                aiPercent: validData.aiPercent,
                screenshotUrl: screenshotUrl,
                readmeConfirmed: true,
                status: "pending"
            });

            // Redirect to success or list
             return new Response(null, {
                status: 302,
                headers: { Location: "/ysws?success=true" },
            });

        } catch (e) {
            console.error(e);
            return new Response("Internal Server Error", { status: 500 });
        }
    }

    return new Response("Not Found", { status: 404 });
}
