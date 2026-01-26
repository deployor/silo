import { z } from "zod";

// Bucket Name Validation
// Only lowercase letters, numbers, and hyphens.
// Cannot start with 'u' or 'w' followed by numbers (reserved).
// Also block a small set of globally-reserved product keywords.
const reservedBucketNames = new Set([
	"dashboard",
	"admin",
	"api",
	"auth",
	"docs",
	"ysws",
]);

export const bucketNameSchema = z
	.string()
	.min(3, "Bucket name must be at least 3 characters")
	.max(63, "Bucket name must be at most 63 characters")
	.regex(
		/^[a-z0-9-]+$/,
		"Bucket name can only contain lowercase letters, numbers, and hyphens",
	)
	.refine((name) => !/^[uw][a-z0-9]{7,}$/.test(name), {
		message: "This bucket name is reserved for system use",
	})
	.refine((name) => !reservedBucketNames.has(name), {
		message: "This bucket name is reserved",
	});

export const createBucketSchema = z.object({
	name: bucketNameSchema,
});

export const updateBucketVisibilitySchema = z.object({
	isPublic: z.boolean(),
});

export const corsRuleSchema = z.object({
	AllowedOrigins: z.array(z.string()),
	AllowedMethods: z.array(z.string()),
	AllowedHeaders: z.array(z.string()).optional(),
	ExposeHeaders: z.array(z.string()).optional(),
	MaxAgeSeconds: z.number().optional(),
	ID: z.string().optional(),
});

export const updateCorsSchema = z.object({
	rules: z.array(corsRuleSchema),
});
