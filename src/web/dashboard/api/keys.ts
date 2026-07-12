import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { bucketKeys, buckets } from "../../../db/schema";
import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import {
	buildBucketUrlExample,
	parseBucketCustomDomains,
} from "../../../lib/bucket-domains";
import { getCurrentUser } from "../../../lib/session";
import { bucketNameSchema } from "../../../lib/validation";
import {
	assertCanManageKeys,
	getBucketAccessForUser,
} from "../../../services/collaboration-service";
import {
	createKey,
	deleteKey,
	listKeysForBucket,
	updateKeyNote,
} from "../../../services/key-service";

export async function handleKeys(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	if (!user) return errorResponse("Unauthorized", 401);

	const url = new URL(req.url);
	const path = url.pathname;

	const generateKeyMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/keys$/,
	);
	if (generateKeyMatch && req.method === "POST") {
		const bucketName = generateKeyMatch[1];

		const nameValidation = bucketNameSchema.safeParse(bucketName);
		if (!nameValidation.success) {
			return errorResponse("Invalid bucket name", 400);
		}

		const bucket = await db
			.select()
			.from(buckets)
			.where(eq(buckets.name, bucketName))
			.limit(1);

		if (bucket.length === 0) return errorResponse("Bucket not found", 404);
		const access = await getBucketAccessForUser({
			bucketName,
			userId: user.id,
			isAdmin: user.isAdmin,
		});
		if (access.bucket.isPaused && !user.isAdmin)
			return errorResponse("Bucket is paused", 403);
		try {
			assertCanManageKeys(access);
		} catch (e) {
			return errorResponse(
				e instanceof Error ? e.message : "Unauthorized",
				403,
			);
		}

		if (user.markedAsOverAge) {
			return errorResponse(
				"Account is in grace period. New keys cannot be created.",
				403,
			);
		}

		if (user.dataExported) {
			return errorResponse(
				"Account is frozen. New keys cannot be created.",
				403,
			);
		}

		try {
			const body = (await req.json().catch(() => ({}))) as { note?: unknown };
			const note = typeof body.note === "string" ? body.note : null;
			const keys = await createKey(access.bucket.id, "dashboard", note);
			const publicUrl = buildBucketUrlExample({
				bucketName,
				customDomains: parseBucketCustomDomains(access.bucket.customDomains),
			});
			return jsonResponse({ ...keys, publicUrl });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			// Key limit is an expected/handled case.
			if (message.includes("Key limit reached"))
				return errorResponse(message, 429);
			return errorResponse(message, 400);
		}
	}

	const deleteKeyMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/keys\/([^/]+)$/,
	);
	if (deleteKeyMatch && req.method === "DELETE") {
		if (user.dataExported) {
			return errorResponse("Account is frozen. Keys cannot be deleted.", 403);
		}
		const bucketName = deleteKeyMatch[1];
		const keyId = deleteKeyMatch[2];

		try {
			await deleteKey(keyId, bucketName, user.id, user.isAdmin);
			return jsonResponse({ message: "Deleted" });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return errorResponse(message, 403);
		}
	}

	const patchKeyMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/keys\/([^/]+)$/,
	);
	if (patchKeyMatch && req.method === "PATCH") {
		if (user.dataExported) {
			return errorResponse("Account is frozen. Keys cannot be updated.", 403);
		}

		const bucketName = patchKeyMatch[1];
		const keyId = patchKeyMatch[2];

		const access = await getBucketAccessForUser({
			bucketName,
			userId: user.id,
			isAdmin: user.isAdmin,
		});
		if (access.bucket.isPaused && !user.isAdmin)
			return errorResponse("Bucket is paused", 403);
		try {
			assertCanManageKeys(access);
		} catch (e) {
			return errorResponse(
				e instanceof Error ? e.message : "Unauthorized",
				403,
			);
		}

		const body = (await req.json().catch(() => null)) as {
			note?: unknown;
			isPaused?: unknown;
			pauseReason?: unknown;
		} | null;

		if (!body) return errorResponse("Invalid body", 400);

		try {
			if (body.note !== undefined) {
				await updateKeyNote(
					keyId,
					bucketName,
					user.id,
					typeof body.note === "string" ? body.note : null,
					user.isAdmin,
				);
			}

			if (body.isPaused !== undefined) {
				await db
					.update(bucketKeys)
					.set({
						isPaused: Boolean(body.isPaused),
						pauseReason:
							typeof body.pauseReason === "string"
								? body.pauseReason.trim() || null
								: null,
					})
					.where(eq(bucketKeys.id, keyId));
			}

			return jsonResponse({ ok: true });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return errorResponse(message, 400);
		}
	}

	const listKeysMatch = path.match(
		/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/keys$/,
	);
	if (listKeysMatch && req.method === "GET") {
		const bucketName = listKeysMatch[1];
		try {
			const keys = await listKeysForBucket(bucketName, user.id, user.isAdmin);
			return jsonResponse({ keys });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return errorResponse(message, 403);
		}
	}

	return errorResponse("Method not allowed", 405);
}
