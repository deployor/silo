import { desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { config } from "../../config";
import { getInternalPath } from "../../core/s3/utils";
import { db } from "../../db";
import { buckets, users, yswsSubmissions } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { getCurrentUser } from "../../lib/session";
import { render } from "../../lib/view-engine";
import { SettingsService } from "../../services/settings-service";
import { YswsService } from "../../services/ysws-service";

// Mock Hackatime Projects
const MOCK_HACKATIME_PROJECTS = [
	{ id: "proj_1", name: "hackclub/silo-s3-gateway", hours: 42.5 },
	{ id: "proj_2", name: "personal/portfolio-2024", hours: 12.0 },
	{ id: "proj_3", name: "hackclub/sprig-game", hours: 8.5 },
	{ id: "proj_4", name: "school/ap-cs-final", hours: 15.2 },
	{ id: "proj_5", name: "random/discord-bot", hours: 3.1 },
];

const SubmissionSchema = z.object({
	projectName: z.string().min(1, "Project name is required"),
	shortDescription: z.string().min(1, "Description is required"),
	repoUrl: z.string().url("Invalid Repository URL"),
	demoUrl: z.string().url("Invalid Demo URL"),
	hackatimeProject: z.string().optional(), // Comma separated IDs
	usedAi: z.enum(["yes", "no"]),
	aiToolUsage: z.string().optional(),
	aiUsageDescription: z.string().optional(),
	aiPercent: z
		.string()
		.transform((val) => parseInt(val, 10))
		.pipe(z.number().min(0).max(100)),
	screenshotUrl: z
		.string()
		.url("Invalid Screenshot URL")
		.optional()
		.or(z.literal("")),
	readmeConfirmed: z.literal("on", {
		errorMap: () => ({ message: "You must confirm the README is good" }),
	}),
});

export async function handleYswsRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const user = await getCurrentUser(req);

	if (!user) {
		return new Response(null, {
			status: 302,
			headers: {
				Location: `/auth/login?next=${encodeURIComponent(url.pathname)}`,
			},
		});
	}

	const appSettings = await SettingsService.getAppSettings();

	if (req.method === "GET") {
		if (url.pathname === "/ysws") {
			// Calculate average review time
			const recentReviews = await db
				.select({
					createdAt: yswsSubmissions.createdAt,
					reviewedAt: yswsSubmissions.reviewedAt,
				})
				.from(yswsSubmissions)
				.where(isNotNull(yswsSubmissions.reviewedAt));

			let estimatedReviewTime = "24 hours"; // Default

			if (recentReviews.length > 0) {
				let totalDurationMs = 0;
				let count = 0;
				for (const review of recentReviews) {
					if (review.createdAt && review.reviewedAt) {
						const duration =
							review.reviewedAt.getTime() - review.createdAt.getTime();
						if (duration > 0) {
							totalDurationMs += duration;
							count++;
						}
					}
				}

				if (count > 0) {
					const avgMs = totalDurationMs / count;

					const days = Math.floor(avgMs / (1000 * 60 * 60 * 24));
					const hours = Math.floor(
						(avgMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
					);
					const minutes = Math.floor((avgMs % (1000 * 60 * 60)) / (1000 * 60));

					const parts = [];
					if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
					if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
					if (days === 0 && hours === 0)
						parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);

					estimatedReviewTime = parts.join(", ");
				}
			}

			// Get User Submissions
			const userSubmissions = await db
				.select()
				.from(yswsSubmissions)
				.where(eq(yswsSubmissions.userId, user.id))
				.orderBy(desc(yswsSubmissions.createdAt));

			// Get Public Gallery (Approved Projects)
			const galleryProjects = await db
				.select()
				.from(yswsSubmissions)
				.where(eq(yswsSubmissions.status, "approved"))
				.orderBy(desc(yswsSubmissions.reviewedAt))
				.limit(12);

			return new Response(
				await render("ysws-list", {
					title: "Your YSWS Projects",
					user,
					submissions: userSubmissions,
					galleryProjects,
					estimatedReviewTime,
					success: url.searchParams.get("success") === "true",
				}),
				{
					headers: { "Content-Type": "text/html" },
				},
			);
		}

		if (url.pathname === "/ysws/submit") {
			return new Response(
				await render("ysws-submit", {
					title: "Submit to YSWS",
					user,
					hackatimeProjects: MOCK_HACKATIME_PROJECTS,
					quotaPerHour: appSettings.yswsQuotaPerHourBytes,
					yswsBonusTiers: appSettings.yswsBonusTiers,
					quotaPerHourFormatted:
						(appSettings.yswsQuotaPerHourBytes / (1024 * 1024)).toFixed(0) +
						" MB",
				}),
				{
					headers: { "Content-Type": "text/html" },
				},
			);
		}
	}

	if (req.method === "POST" && url.pathname === "/ysws/submit") {
		console.log("[YSWS] POST /ysws/submit received");
		try {
			const formData = await req.formData();
			const data = Object.fromEntries(formData.entries());

			const validation = SubmissionSchema.safeParse(data);

			if (!validation.success) {
				console.log(
					"[YSWS] Validation failed",
					validation.error.flatten().fieldErrors,
				);
				return new Response(
					await render("ysws-submit", {
						title: "Submit to YSWS",
						user,
						hackatimeProjects: MOCK_HACKATIME_PROJECTS,
						quotaPerHour: appSettings.yswsQuotaPerHourBytes,
						errors: validation.error.flatten().fieldErrors,
						values: data,
					}),
					{
						headers: { "Content-Type": "text/html" },
					},
				);
			}

			const validData = validation.data;

			// AI Validation Logic
			if (validData.usedAi === "yes") {
				if (validData.aiToolUsage === "no-code") {
					return new Response(
						await render("ysws-submit", {
							title: "Submit to YSWS",
							user,
							hackatimeProjects: MOCK_HACKATIME_PROJECTS,
							quotaPerHour: appSettings.yswsQuotaPerHourBytes,
							error:
								"Sorry, purely AI-generated / no-code projects are not eligible for YSWS rewards.",
							values: data,
						}),
						{ headers: { "Content-Type": "text/html" } },
					);
				}

				if (
					["tab-completion", "command-k", "chat"].includes(
						validData.aiToolUsage || "",
					)
				) {
					if (
						!validData.aiUsageDescription ||
						validData.aiUsageDescription.length < 10
					) {
						return new Response(
							await render("ysws-submit", {
								title: "Submit to YSWS",
								user,
								hackatimeProjects: MOCK_HACKATIME_PROJECTS,
								quotaPerHour: appSettings.yswsQuotaPerHourBytes,
								error: "Please provide a description of how you used AI tools.",
								values: data,
							}),
							{ headers: { "Content-Type": "text/html" } },
						);
					}
				}

				if (validData.aiPercent > 30) {
					return new Response(
						await render("ysws-submit", {
							title: "Submit to YSWS",
							user,
							hackatimeProjects: MOCK_HACKATIME_PROJECTS,
							quotaPerHour: appSettings.yswsQuotaPerHourBytes,
							error: "AI contribution cannot exceed 30%",
							values: data,
						}),
						{ headers: { "Content-Type": "text/html" } },
					);
				}
			}

			// Calculate hours from multiple projects
			let hoursSpent = 0;
			const hackatimeProjectNames: string[] = [];

			if (validData.hackatimeProject) {
				const projectIds = validData.hackatimeProject
					.split(",")
					.filter(Boolean);

				for (const pid of projectIds) {
					const project = MOCK_HACKATIME_PROJECTS.find((p) => p.id === pid);
					if (project) {
						hoursSpent += project.hours;
						hackatimeProjectNames.push(project.name);
					}
				}
			}

			let screenshotUrl = validData.screenshotUrl;

			// Handle Screenshot Upload
			const screenshotFile = formData.get("screenshotFile");
			if (
				screenshotFile &&
				screenshotFile instanceof File &&
				screenshotFile.size > 0
			) {
				console.log(
					`[YSWS] Processing screenshot upload: ${screenshotFile.name} (${screenshotFile.size} bytes)`,
				);
				try {
					// Create or get 'ysws' bucket owned by admin/system or current user?
					// We'll create a 'ysws' system bucket if it doesn't exist, owned by this user for simplicity in this context,
					// or better: a dedicated system bucket. But we need an owner.
					// Let's use the current user's bucket or a specific 'ysws-assets' bucket.
					// For now, let's just upload to a public 'ysws' bucket owned by the first admin found, or the current user.
					// User requested "we handle the upload into our bucket and make like a public whatever bucket for system".

					const systemBucketName = "ysws";

					// Check if bucket exists
					const bucketResult = await db
						.select({
							bucket: buckets,
							user: users,
						})
						.from(buckets)
						.leftJoin(users, eq(buckets.userId, users.id))
						.where(eq(buckets.name, systemBucketName))
						.limit(1);

					let targetBucket: typeof buckets.$inferSelect;
					let targetOwner: typeof users.$inferSelect | undefined;

					if (bucketResult.length === 0) {
						console.log(`[YSWS] Creating system bucket '${systemBucketName}'`);
						// Create it if not exists. System bucket with no owner.
						const [newBucket] = await db
							.insert(buckets)
							.values({
								name: systemBucketName,
								userId: null,
								isPublic: true,
								isSystem: true,
								region: "auto",
							})
							.returning();
						targetBucket = newBucket;
					} else {
						console.log(`[YSWS] Using existing bucket '${systemBucketName}'`);
						targetBucket = bucketResult[0].bucket;
						targetOwner = bucketResult[0].user || undefined;
					}

					const ext = screenshotFile.name.split(".").pop() || "png";
					const fileName = `screenshots/${crypto.randomUUID()}.${ext}`;

					// The getInternalPath function will ignore user for system buckets
					const internalPath = getInternalPath(
						fileName,
						targetOwner || user,
						targetBucket,
					);
					console.log(`[YSWS] Internal path: ${internalPath}`);
					const fileBuffer = await screenshotFile.arrayBuffer();

					// Upload to S3
					console.log("[YSWS] Uploading to S3...");
					const uploadRes = await s3Client.fetch(internalPath, {
						method: "PUT",
						body: fileBuffer,
						headers: {
							"Content-Type": screenshotFile.type || "application/octet-stream",
						},
					});

					if (!uploadRes.ok) {
						throw new Error(
							`S3 Upload failed: ${uploadRes.status} ${uploadRes.statusText}`,
						);
					}
					console.log("[YSWS] Upload successful");

					// Construct Public URL
					screenshotUrl = `https://${config.s3Domain}/${systemBucketName}/${fileName}`;
					console.log(`[YSWS] Screenshot URL: ${screenshotUrl}`);
				} catch (uploadError) {
					console.error("Screenshot upload failed:", uploadError);
					return new Response(
						await render("ysws-submit", {
							title: "Submit to YSWS",
							user,
							hackatimeProjects: MOCK_HACKATIME_PROJECTS,
							quotaPerHour: appSettings.yswsQuotaPerHourBytes,
							error:
								"Failed to upload screenshot. Please try again or use a URL.",
							values: data,
						}),
						{
							headers: { "Content-Type": "text/html" },
						},
					);
				}
			} else if (!screenshotUrl) {
				// Require either file or URL
				return new Response(
					await render("ysws-submit", {
						title: "Submit to YSWS",
						user,
						hackatimeProjects: MOCK_HACKATIME_PROJECTS,
						quotaPerHour: appSettings.yswsQuotaPerHourBytes,
						error: "Please provide a screenshot URL or upload a file.",
						values: data,
					}),
					{
						headers: { "Content-Type": "text/html" },
					},
				);
			}

			console.log("[YSWS] Creating submission record...");
			await YswsService.createSubmission({
				userId: user.id,
				projectName: validData.projectName,
				shortDescription: validData.shortDescription,
				repoUrl: validData.repoUrl,
				demoUrl: validData.demoUrl,
				hackatimeProject: hackatimeProjectNames.join(", "),
				hoursSpent: hoursSpent,
				usedAi: validData.usedAi === "yes",
				aiToolUsage: validData.aiToolUsage,
				aiUsageDescription: validData.aiUsageDescription,
				aiPercent: validData.aiPercent,
				screenshotUrl: screenshotUrl,
				readmeConfirmed: true,
				status: "pending",
			});

			// Redirect to success or list
			console.log("[YSWS] Submission successful, redirecting...");
			return new Response(null, {
				status: 302,
				headers: { Location: "/ysws?success=true" },
			});
		} catch (e) {
			console.error("[YSWS] Error in submission handler:", e);
			return new Response("Internal Server Error", { status: 500 });
		}
	}

	return new Response("Not Found", { status: 404 });
}
