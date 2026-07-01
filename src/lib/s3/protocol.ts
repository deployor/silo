export interface CORSRule {
	ID?: string;
	AllowedHeaders?: string[];
	AllowedMethods: string[];
	AllowedOrigins: string[];
	ExposeHeaders?: string[];
	MaxAgeSeconds?: number;
}

export interface CORSConfiguration {
	CORSRules: CORSRule[];
}

export enum S3Action {
	// Bucket Operations
	ListBuckets = "ListBuckets",
	HeadBucket = "HeadBucket",
	GetBucketLocation = "GetBucketLocation",
	PutBucketCors = "PutBucketCors",
	GetBucketCors = "GetBucketCors",
	DeleteBucketCors = "DeleteBucketCors",

	// Object Operations
	PutObject = "PutObject",
	GetObject = "GetObject",
	HeadObject = "HeadObject",
	DeleteObject = "DeleteObject",
	CopyObject = "CopyObject",
	ListObjectsV2 = "ListObjectsV2",
	DeleteObjects = "DeleteObjects",

	// Multipart Uploads
	CreateMultipartUpload = "CreateMultipartUpload",
	UploadPart = "UploadPart",
	CompleteMultipartUpload = "CompleteMultipartUpload",
	AbortMultipartUpload = "AbortMultipartUpload",
	ListMultipartUploads = "ListMultipartUploads",
	ListParts = "ListParts",

	// Preflight
	Options = "Options",

	// Unknown/Denied
	Unknown = "Unknown",
}

export function determineAction(
	method: string,
	key: string,
	query: URLSearchParams,
	headers: Headers,
): S3Action {
	// Preflight
	if (method === "OPTIONS") return S3Action.Options;

	// Bucket Operations (key is empty)
	if (key === "") {
		if (method === "GET") {
			if (query.has("list-type") && query.get("list-type") === "2")
				return S3Action.ListObjectsV2;
			if (query.has("location")) return S3Action.GetBucketLocation;
			if (query.has("cors")) return S3Action.GetBucketCors;
			if (query.has("uploads")) return S3Action.ListMultipartUploads;
			// ListBuckets is handled specially in index.ts (GET / on root domain)
			// but if we are here with key="" and no special params, it's likely ListObjects (v1) or ListBuckets depending on context
			// However, standard S3 GET /bucket is ListObjects.
			// We'll map it to ListObjectsV2 for simplicity if v1 is not explicitly separated, or keep it as Unknown if we want to enforce v2.
			// Let's assume GET /bucket is ListObjectsV2 equivalent for permission purposes.
			return S3Action.ListObjectsV2;
		}
		if (method === "HEAD") return S3Action.HeadBucket;
		if (method === "PUT") {
			if (query.has("cors")) return S3Action.PutBucketCors;
		}
		if (method === "DELETE") {
			if (query.has("cors")) return S3Action.DeleteBucketCors;
		}
		if (method === "POST") {
			if (query.has("delete")) return S3Action.DeleteObjects;
		}
	} else {
		// Object Operations (key is not empty)
		if (method === "GET") {
			if (query.has("uploadId")) return S3Action.ListParts;
			return S3Action.GetObject;
		}
		if (method === "HEAD") return S3Action.HeadObject;
		if (method === "PUT") {
			if (query.has("partNumber") && query.has("uploadId"))
				return S3Action.UploadPart;
			if (headers.has("x-amz-copy-source")) return S3Action.CopyObject;
			return S3Action.PutObject;
		}
		if (method === "DELETE") {
			if (query.has("uploadId")) return S3Action.AbortMultipartUpload;
			return S3Action.DeleteObject;
		}
		if (method === "POST") {
			if (query.has("uploads")) return S3Action.CreateMultipartUpload;
			if (query.has("uploadId")) return S3Action.CompleteMultipartUpload;
		}
	}

	return S3Action.Unknown;
}
