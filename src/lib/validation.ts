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

export const customDomainInputSchema = z.object({
	domain: z.string().min(1, "Custom domain is required").max(253),
	makePrimary: z.boolean().optional(),
});

export const setPrimaryCustomDomainSchema = z.object({
	domain: z.string().min(1, "Custom domain is required").max(253),
});

export const deepFreezeActionSchema = z.object({
	action: z.enum(["freeze", "unfreeze"]),
});

export const collaborationPermissionValues = [
	"manage_keys",
	"manage_cors",
	"files_read",
	"files_write",
] as const;

export const collaborationPermissionSchema = z.enum(
	collaborationPermissionValues,
);

export const collaborationPermissionsSchema = z
	.array(collaborationPermissionSchema)
	.max(4, "Too many permissions")
	.refine((value) => new Set(value).size === value.length, {
		message: "Permissions must be unique",
	})
	.refine(
		(value) => !value.includes("files_write") || value.includes("files_read"),
		{
			message: "File write permission also requires file read permission",
		},
	);

export const createCollaborationInviteSchema = z.object({
	inviteeUserId: z
		.string()
		.min(1, "User ID is required")
		.max(128, "User ID is too long"),
	permissions: collaborationPermissionsSchema,
});

export const updateCollaborationInviteSchema = z.object({
	permissions: collaborationPermissionsSchema,
});

export const respondToCollaborationInviteSchema = z.object({
	action: z.enum(["accept", "decline"]),
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
