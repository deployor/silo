import { timingSafeEqual } from "node:crypto";
import { config } from "../../../config";
import { errorResponse, jsonResponse } from "../../../lib/api-utils";
import { getCorsHeaders } from "../../../lib/s3/cors";
import {
	getInternalPath,
	getKeyFromRequest,
	stripAuthQueryParams,
} from "../../../lib/s3/paths";
import { determineAction, S3Action } from "../../../lib/s3/protocol";
import { S3Errors } from "../../../lib/s3-errors";
import { authenticate } from "../../../middleware/auth";
import { getAppSettings } from "../../../services/settings-service";

type HeaderTuple = [string, string];

type AuthorizeBody = {
	method?: string;
	url?: string;
	headers?: HeaderTuple[] | Record<string, string>;
};

function internalAuthOk(req: Request) {
	const configured = config.dataplane.internalSecret;
	if (!configured) return false;

	const provided =
		req.headers.get("x-dataplane-secret") ||
		req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
		"";

	const expected = Buffer.from(configured);
	const actual = Buffer.from(provided);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normalizeHeaders(
	headers: AuthorizeBody["headers"],
): HeadersInit | undefined {
	if (!headers) return undefined;
	if (Array.isArray(headers)) return headers;
	return headers;
}

function unsupportedFastPath(action: S3Action) {
	return ![
		S3Action.AbortMultipartUpload,
		S3Action.CompleteMultipartUpload,
		S3Action.CopyObject,
		S3Action.CreateMultipartUpload,
		S3Action.DeleteBucketCors,
		S3Action.DeleteObject,
		S3Action.DeleteObjects,
		S3Action.GetBucketCors,
		S3Action.GetBucketLocation,
		S3Action.GetObject,
		S3Action.HeadBucket,
		S3Action.HeadObject,
		S3Action.ListMultipartUploads,
		S3Action.ListObjectsV2,
		S3Action.ListParts,
		S3Action.Options,
		S3Action.PutBucketCors,
		S3Action.PutObject,
		S3Action.UploadPart,
	].includes(action);
}

export async function handleDataplaneAuthorize(
	req: Request,
): Promise<Response> {
	if (req.method !== "POST") return errorResponse("Method not allowed", 405);
	if (!internalAuthOk(req)) return errorResponse("Unauthorized", 401);

	const body = (await req.json().catch(() => null)) as AuthorizeBody | null;
	if (!body?.method || !body.url) {
		return errorResponse("Invalid dataplane authorization request", 400);
	}

	const method = body.method.toUpperCase();
	const s3Req = new Request(body.url, {
		method,
		headers: normalizeHeaders(body.headers),
	});
	const url = new URL(s3Req.url);

	const authResult = await authenticate(s3Req);
	if (authResult instanceof Response) {
		const text = await authResult.text().catch(() => "");
		return jsonResponse(
			{
				allowed: false,
				status: authResult.status,
				body: text,
			},
			200,
		);
	}

	const { user, bucket, mode } = authResult;
	let key: string;
	try {
		key = getKeyFromRequest(s3Req, bucket.name);
	} catch {
		const denied = S3Errors.AccessDenied().toResponse();
		return jsonResponse(
			{ allowed: false, status: denied.status, body: await denied.text() },
			200,
		);
	}

	const action = determineAction(method, key, url.searchParams, s3Req.headers);
	if (action === S3Action.Unknown) {
		return jsonResponse({
			allowed: false,
			status: 405,
			body: await S3Errors.MethodNotAllowed().toResponse().text(),
		});
	}

	if (unsupportedFastPath(action)) {
		return jsonResponse({
			allowed: false,
			status: 501,
			body: await S3Errors.NotImplemented().toResponse().text(),
		});
	}

	if (
		mode === "public" &&
		![
			S3Action.GetBucketLocation,
			S3Action.GetObject,
			S3Action.HeadBucket,
			S3Action.HeadObject,
			S3Action.ListObjectsV2,
			S3Action.Options,
		].includes(action)
	) {
		return jsonResponse({
			allowed: false,
			status: 403,
			body: await S3Errors.AccessDenied().toResponse().text(),
		});
	}

	if (
		(action === S3Action.DeleteObject ||
			action === S3Action.PutObject ||
			action === S3Action.UploadPart) &&
		!user
	) {
		return jsonResponse({
			allowed: false,
			status: 403,
			body: await S3Errors.AccessDenied().toResponse().text(),
		});
	}

	if (
		user?.markedAsOverAge &&
		!user.isImmortal &&
		![
			S3Action.GetBucketLocation,
			S3Action.GetObject,
			S3Action.HeadBucket,
			S3Action.HeadObject,
			S3Action.ListObjectsV2,
		].includes(action)
	) {
		return jsonResponse({
			allowed: false,
			status: 403,
			body: await S3Errors.AccessDenied(
				"Account is in migration grace period. New uploads are disabled.",
			)
				.toResponse()
				.text(),
		});
	}

	const internalPath = getInternalPath(key, user, bucket);
	const rootPrefix = getInternalPath("", user, bucket);
	const cleanUrl = stripAuthQueryParams(url);
	const queryStr = cleanUrl.searchParams.toString();
	const pathWithQuery = queryStr ? `${internalPath}?${queryStr}` : internalPath;
	const effectiveStorageLimitBytes = user
		? Number(user.storageLimitBytes ?? 0) > 0
			? Number(user.storageLimitBytes)
			: (await getAppSettings()).defaultStorageLimitBytes
		: null;

	return jsonResponse({
		allowed: true,
		fastPath: true,
		action,
		mode,
		key,
		internalPath,
		rootPrefix,
		pathWithQuery,
		corsHeaders: Object.fromEntries(getCorsHeaders(s3Req, bucket).entries()),
		partNumber: url.searchParams.get("partNumber"),
		uploadId: url.searchParams.get("uploadId"),
		bucket: {
			id: bucket.id,
			name: bucket.name,
			isSystem: bucket.isSystem,
			isPublic: bucket.isPublic,
		},
		user: user
			? {
					id: user.id,
					isImmortal: user.isImmortal,
					storageLimitBytes: effectiveStorageLimitBytes,
					storageUsageBytes: user.storageUsageBytes,
					egressLimitBytes: user.egressLimitBytes,
					egressBytes: user.egressBytes,
					egressPeriod: user.egressPeriod,
				}
			: null,
	});
}
