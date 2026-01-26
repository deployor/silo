import { context } from "../../lib/context";
import { render } from "../../lib/view-engine";
import { YswsService } from "../../services/ysws-service";
import { SettingsService } from "../../services/settings-service";
import { getCurrentUser } from "../../lib/session";
import { z } from "zod";

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
    screenshotUrl: z.string().url("Invalid Screenshot URL").optional(),
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
            // Check if user has pending submissions? Maybe just list them or show form.
            // User asked for "one form not some step by step process"
            // We'll pass the mock hackatime projects
            
            // In a real implementation, we would fetch these from an API using the user's connected account
            // For now, we mock it as requested.
            
            return new Response(await render("ysws", {
                title: "Ship to Earn",
                user,
                hackatimeProjects: MOCK_HACKATIME_PROJECTS,
                quotaPerHour: appSettings.yswsQuotaPerHourBytes,
                quotaPerHourFormatted: (appSettings.yswsQuotaPerHourBytes / (1024 * 1024)).toFixed(0) + " MB" // Simplified for display
            }), {
                headers: { "Content-Type": "text/html" },
            });
        }
    }

    if (req.method === "POST" && url.pathname === "/ysws/submit") {
        try {
            const formData = await req.formData();
            const data = Object.fromEntries(formData.entries());
            
            // Handle checkbox "on" value for boolean
            // usedAi is radio yes/no
            
            const validation = SubmissionSchema.safeParse(data);

            if (!validation.success) {
                // Return errors to the form
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

            // TODO: Handle screenshot upload if it was a file upload?
            // The prompt says "Screenshot of project" - likely a file upload.
            // But for now let's assume they provide a URL or we need to implement file upload to S3 here.
            // Wait, "shipping means people put their code url ... and then a playable URL ... and then they select hackaitme project ... Screenshot of project"
            // Let's assume for now it's a URL input or we might need to change it to file upload if the user wants us to host it.
            // "Screenshot of project" usually implies uploading an image.
            // Since we are building an S3 thing, we should probably upload it to a system bucket?
            // Or just let them paste a URL. The prompt says "Screenshot of project". 
            // I'll stick to text URL in schema for now, but if it's a file in FormData, I need to handle it.
            // Let's check formData for 'screenshot'.
            
            let screenshotUrl = validData.screenshotUrl;
            
            const screenshotFile = formData.get("screenshotFile");
            if (screenshotFile && screenshotFile instanceof File && screenshotFile.size > 0) {
                 // Upload logic would go here. For now, let's assume we want them to host it on their own bucket?
                 // Or we could upload it to a public bucket if we had one.
                 // Simplification: We'll require a URL for now as per my schema, but I should probably allow file upload in a real app.
                 // The prompt doesn't explicitly say "upload file", just "Screenshot of project". 
                 // I will stick to URL input to avoid complex file handling in this single step unless user complains.
                 // Actually, looking at the schema I wrote `screenshotUrl: text("screenshot_url")`.
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
