import { config } from "../../../config";
import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import {
	buildBucketUrlExample,
	parseBucketCustomDomains,
} from "../../../lib/bucket-domains";
import { getBucketStorageRegion, getStorageRegion } from "../../../lib/regions";
import { getCurrentUser } from "../../../lib/session";
import {
	createBucketSchema,
	customDomainInputSchema,
	setPrimaryCustomDomainSchema,
	updateBucketVisibilitySchema,
} from "../../../lib/validation";
import {
	addBucketCustomDomain,
	createBucket,
	deleteBucket,
	emptyBucket,
	listBucketCustomDomains,
	removeBucketCustomDomain,
	setPrimaryBucketCustomDomain,
	updateBucketVisibility,
	verifyBucketCustomDomain,
} from "../../../services/bucket-service";
import { getBucketAccessForUser } from "../../../services/collaboration-service";
import { createKey } from "../../../services/key-service";

async function getBucketRegionalEndpoint(params: {
	bucketName: string;
	userId: string;
	isAdmin: boolean;
}) {
	const access = await getBucketAccessForUser(params);
	return getStorageRegion(getBucketStorageRegion(access.bucket)).endpoint;
}

export async function handleBuckets(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	if (user.markedAsOverAge) {
		return errorResponse(
			"Account is in grace period. New buckets cannot be created.",
			403,
		);
	}
	if (user.dataExported) {
		return errorResponse(
			"Account is frozen due to data export. New buckets cannot be created.",
			403,
		);
	}

	if (req.method === "POST") {
		try {
			const body = await req.json();
			const result = createBucketSchema.safeParse(body);

			if (!result.success) {
				return errorResponse(result.error.issues[0].message, 400);
			}

			const { name: bucketName, requestedRegion } = result.data;

			const newBucket = await createBucket(
				user.id,
				bucketName,
				requestedRegion,
			);
			const keys = await createKey(newBucket.id, "dashboard", "Default key");

			const region = getStorageRegion(getBucketStorageRegion(newBucket));
			const publicUrl = buildBucketUrlExample({
				bucketName,
				s3Domain: region.endpoint,
			});

			return jsonResponse({
				...keys,
				publicUrl,
				requestedRegion: newBucket.requestedRegion,
				resolvedRegion: newBucket.resolvedRegion,
				endpoint: region.endpoint,
			});
		} catch (e: unknown) {
			console.error(e);
			const message = e instanceof Error ? e.message : "Internal Error";
			return errorResponse(message, 500);
		}
	}

	return errorResponse("Method not allowed", 405);
}

export async function handleBucketOperations(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	const url = new URL(req.url);
	const path = url.pathname;
	const bucketName = path.split("/")[4]; // /api/dashboard/buckets/:name
	const domainRouteMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/domains$/,
	);

	if (!bucketName) return errorResponse("Invalid bucket name", 400);

	if (domainRouteMatch) {
		if (!config.customDomainsEnabled) {
			return errorResponse("Custom domains are currently disabled", 404);
		}
		if (user.dataExported) {
			return errorResponse(
				"Account is frozen. Bucket settings cannot be updated.",
				403,
			);
		}

		if (req.method === "GET") {
			try {
				const [domains, regionalEndpoint] = await Promise.all([
					listBucketCustomDomains({
						bucketName,
						userId: user.id,
						isAdmin: user.isAdmin,
					}),
					getBucketRegionalEndpoint({
						bucketName,
						userId: user.id,
						isAdmin: user.isAdmin,
					}),
				]);
				return jsonResponse({
					domains,
					publicUrlExample: buildBucketUrlExample({
						bucketName,
						customDomains: domains,
						s3Domain: regionalEndpoint,
					}),
				});
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : "Internal Error";
				return errorResponse(message, 500);
			}
		}

		if (req.method === "POST") {
			try {
				const body = await req.json();
				const parsed = customDomainInputSchema.safeParse(body);
				if (!parsed.success) {
					return errorResponse(
						parsed.error.issues[0]?.message || "Invalid request",
						400,
					);
				}
				const domains = await addBucketCustomDomain({
					bucketName,
					userId: user.id,
					domain: parsed.data.domain,
					makePrimary: parsed.data.makePrimary,
					isAdmin: user.isAdmin,
				});
				return jsonResponse({ domains });
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : "Internal Error";
				return errorResponse(message, 400);
			}
		}

		if (req.method === "PATCH") {
			try {
				const body = await req.json();
				if (body?.action === "set-primary") {
					const parsed = setPrimaryCustomDomainSchema.safeParse(body);
					if (!parsed.success) {
						return errorResponse(
							parsed.error.issues[0]?.message || "Invalid request",
							400,
						);
					}
					const domains = await setPrimaryBucketCustomDomain({
						bucketName,
						userId: user.id,
						domain: parsed.data.domain,
						isAdmin: user.isAdmin,
					});
					return jsonResponse({ domains });
				}
				if (body?.action === "verify") {
					const parsed = setPrimaryCustomDomainSchema.safeParse(body);
					if (!parsed.success) {
						return errorResponse(
							parsed.error.issues[0]?.message || "Invalid request",
							400,
						);
					}
					const domains = await verifyBucketCustomDomain({
						bucketName,
						userId: user.id,
						domain: parsed.data.domain,
						isAdmin: user.isAdmin,
					});
					return jsonResponse({ domains });
				}
				return errorResponse("Unknown action", 400);
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : "Internal Error";
				return errorResponse(message, 400);
			}
		}

		if (req.method === "DELETE") {
			try {
				const body = await req.json().catch(() => null);
				const domain =
					typeof body?.domain === "string"
						? body.domain
						: url.searchParams.get("domain");
				if (!domain) return errorResponse("Custom domain is required", 400);
				const domains = await removeBucketCustomDomain({
					bucketName,
					userId: user.id,
					domain,
					isAdmin: user.isAdmin,
				});
				return jsonResponse({ domains });
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : "Internal Error";
				return errorResponse(message, 400);
			}
		}

		return errorResponse("Method not allowed", 405);
	}

	// NOTE: Dashboard UI sends:
	// - DELETE /api/dashboard/buckets/:name           => delete bucket
	// - DELETE /api/dashboard/buckets/:name?empty=true => empty bucket (delete all files only)
	if (req.method === "DELETE") {
		if (user.dataExported) {
			return errorResponse(
				"Account is frozen. Buckets cannot be deleted.",
				403,
			);
		}
		const isEmpty = url.searchParams.get("empty") === "true";

		try {
			if (isEmpty) {
				await emptyBucket(bucketName, user.id, user.isAdmin);
				return jsonResponse({ message: "Emptied" });
			}

			await deleteBucket(bucketName, user.id, user.isAdmin);
			return jsonResponse({ message: "Deleted" });
		} catch (error) {
			console.error("[bucket teardown] failed:", error);
			const message =
				error instanceof Error ? error.message : "Bucket teardown failed";
			return errorResponse(message, 502);
		}
	}

	if (req.method === "PATCH") {
		if (user.dataExported) {
			return errorResponse(
				"Account is frozen. Bucket settings cannot be updated.",
				403,
			);
		}
		try {
			const body = await req.json();
			const result = updateBucketVisibilitySchema.safeParse(body);

			if (!result.success) {
				return errorResponse(result.error.issues[0].message, 400);
			}

			const { isPublic } = result.data;

			await updateBucketVisibility(bucketName, user.id, isPublic, user.isAdmin);
			const [bucketRows, regionalEndpoint] = await Promise.all([
				listBucketCustomDomains({
					bucketName,
					userId: user.id,
					isAdmin: user.isAdmin,
				}).catch(() => parseBucketCustomDomains(null)),
				getBucketRegionalEndpoint({
					bucketName,
					userId: user.id,
					isAdmin: user.isAdmin,
				}),
			]);
			return jsonResponse({
				message: "Updated",
				publicUrl: buildBucketUrlExample({
					bucketName,
					customDomains: bucketRows,
					s3Domain: regionalEndpoint,
				}),
			});
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : "Internal Error";
			return errorResponse(message, 500);
		}
	}

	return errorResponse("Method not allowed", 405);
}
