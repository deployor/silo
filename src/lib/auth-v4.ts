import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const AWS_ALGORITHM = "AWS4-HMAC-SHA256";
const RFC3986_EXTRA_CHARS = /[!'()*]/g;
const PCT_ENCODED_TRIPLET = /%[0-9A-Fa-f]{2}/g;
const UPPER_PCT_ENCODED_TRIPLET = /%[0-9A-F]{2}/g;
const WHITESPACE = /\s+/g;
const PLUS = /\+/g;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;
const PCT_PLACEHOLDER = "___PCT___";
const PCT_PLACEHOLDER_RE = new RegExp(`${PCT_PLACEHOLDER}([0-9A-F]{2})`, "g");
const SIGNING_KEY_CACHE_MAX = 256;
const signingKeyCache = new Map<string, Buffer>();

function awsUriEncode(input: string, encodeSlash: boolean = true) {
	let result = encodeURIComponent(input).replace(
		RFC3986_EXTRA_CHARS,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	if (!encodeSlash) {
		result = result.replace(/%2F/g, "/");
	}
	return result;
}

function preservePctEncoded(input: string) {
	return input.replace(PCT_ENCODED_TRIPLET, (match) => match.toUpperCase());
}

function decodeQueryPart(input: string) {
	return decodeURIComponent(input.replace(PLUS, "%20"));
}

function getSigningKey(
	secretKey: string,
	dateStamp: string,
	regionScope: string,
	serviceScope: string,
) {
	const secretKeyHash = createHash("sha256")
		.update(secretKey)
		.digest("base64url");
	const cacheKey = `${secretKeyHash}\0${dateStamp}\0${regionScope}\0${serviceScope}`;
	const cached = signingKeyCache.get(cacheKey);
	if (cached) return cached;

	const kDate = createHmac("sha256", `AWS4${secretKey}`)
		.update(dateStamp)
		.digest();
	const kRegion = createHmac("sha256", kDate).update(regionScope).digest();
	const kService = createHmac("sha256", kRegion).update(serviceScope).digest();
	const kSigning = createHmac("sha256", kService)
		.update("aws4_request")
		.digest();

	if (signingKeyCache.size >= SIGNING_KEY_CACHE_MAX) {
		const firstKey = signingKeyCache.keys().next().value;
		if (firstKey) signingKeyCache.delete(firstKey);
	}
	signingKeyCache.set(cacheKey, kSigning);
	return kSigning;
}

function signaturesMatch(calculatedSignature: string, signature: string) {
	if (signature.length !== calculatedSignature.length) return false;
	if (!HEX_SHA256.test(signature)) return false;
	return timingSafeEqual(
		Buffer.from(calculatedSignature, "hex"),
		Buffer.from(signature, "hex"),
	);
}

export async function verifyAwsV4Signature(
	req: Request,
	secretKey: string,
	_service: string = "s3",
	_region: string = "auto",
): Promise<boolean> {
	const url = new URL(req.url);
	const method = req.method;
	const headers = req.headers;

	let signature = "";
	let signedHeadersStr = "";
	let credential = "";
	let date = "";
	let algorithm = AWS_ALGORITHM;

	const authHeader = headers.get("Authorization");
	const query = url.searchParams;

	if (authHeader?.startsWith(AWS_ALGORITHM)) {
		algorithm = AWS_ALGORITHM;
		const params = authHeader.slice(AWS_ALGORITHM.length).trim();
		const pairs = params.split(",").map((p) => p.trim());
		for (const pair of pairs) {
			const [key, value] = pair.split("=");
			if (key === "Credential") credential = value;
			if (key === "SignedHeaders") signedHeadersStr = value;
			if (key === "Signature") signature = value;
		}
		date = headers.get("X-Amz-Date") || headers.get("Date") || "";
	} else if (query.has("X-Amz-Signature")) {
		signature = query.get("X-Amz-Signature") || "";
		credential = query.get("X-Amz-Credential") || "";
		signedHeadersStr = query.get("X-Amz-SignedHeaders") || "";
		date = query.get("X-Amz-Date") || "";
		algorithm = query.get("X-Amz-Algorithm") || AWS_ALGORITHM;
	} else {
		return false;
	}

	if (!signature || !credential || !date || !signedHeadersStr) {
		return false;
	}
	if (algorithm !== AWS_ALGORITHM) {
		return false;
	}

	let canonicalUri = url.pathname;

	if (canonicalUri === "") canonicalUri = "/";

	// Canonical URI: URL.pathname is already decoded for some characters.
	// If the incoming path contains percent-encoded bytes (e.g. %20), `url.pathname`
	// preserves them literally as "%20". We must NOT double-encode the '%' into '%25'.
	//
	// AWS rule: each path segment is URI-encoded, but existing percent-encoded triplets
	// should be preserved.
	canonicalUri = canonicalUri
		.split("/")
		.map((segment) => {
			// Protect existing %XX sequences from being re-encoded.
			const protectedSegment = preservePctEncoded(segment);
			const withPlaceholders = protectedSegment.replace(
				UPPER_PCT_ENCODED_TRIPLET,
				(m) => `${PCT_PLACEHOLDER}${m.slice(1)}`,
			);
			let enc = awsUriEncode(withPlaceholders, false);
			enc = enc.replace(PCT_PLACEHOLDER_RE, "%$1");
			return enc;
		})
		.join("/");

	if (canonicalUri.startsWith("//") && !url.pathname.startsWith("//")) {
		canonicalUri = canonicalUri.slice(1);
	}

	// Canonical query string:
	// - must include *all* query params except X-Amz-Signature
	// - must be sorted by encoded key, then by encoded value
	// - must preserve duplicate keys (URLSearchParams.get() loses duplicates)
	// - must percent-encode spaces as %20 (NOT '+')
	const rawSearch = url.search.startsWith("?")
		? url.search.slice(1)
		: url.search;
	const pairs: Array<[string, string]> = rawSearch
		? rawSearch.split("&").map((kv) => {
				const i = kv.indexOf("=");
				const k = i === -1 ? kv : kv.slice(0, i);
				const v = i === -1 ? "" : kv.slice(i + 1);
				return [decodeQueryPart(k), decodeQueryPart(v)] as [string, string];
			})
		: [];

	const filtered = pairs.filter(([k]) => k !== "X-Amz-Signature");

	const canonicalQueryString = filtered
		.map(
			([k, v]) =>
				[awsUriEncode(k, true), awsUriEncode(v, true)] as [string, string],
		)
		.sort((a, b) =>
			a[0] < b[0]
				? -1
				: a[0] > b[0]
					? 1
					: a[1] < b[1]
						? -1
						: a[1] > b[1]
							? 1
							: 0,
		)
		.map(([k, v]) => `${k}=${v}`)
		.join("&");

	const signedHeaders = signedHeadersStr.split(";");
	const canonicalHeaders = `${signedHeaders
		.map((header) => {
			// Some runtimes do not expose an explicit Host header, but SigV4 requires it.
			// Derive it from the request URL when absent.
			let value = headers.get(header) || "";
			if (!value && header.toLowerCase() === "host") {
				value = url.host;
			}
			return `${header.toLowerCase()}:${value.trim().replace(WHITESPACE, " ")}`;
		})
		.join("\n")}\n`;

	// Payload hash:
	// - For query-presigned requests, x-amz-content-sha256 may be present in *query*
	//   (NOT headers), especially when produced by aws4fetch.
	// - For header-auth requests, it is typically in headers.
	let hashedPayload = "UNSIGNED-PAYLOAD";
	if (headers.has("X-Amz-Content-Sha256")) {
		hashedPayload = headers.get("X-Amz-Content-Sha256") || "";
	} else if (headers.has("x-amz-content-sha256")) {
		hashedPayload = headers.get("x-amz-content-sha256") || "";
	} else if (query.has("X-Amz-Content-Sha256")) {
		hashedPayload = query.get("X-Amz-Content-Sha256") || "";
	} else if (query.has("x-amz-content-sha256")) {
		hashedPayload = query.get("x-amz-content-sha256") || "";
	} else if (query.has("X-Amz-Signature")) {
		hashedPayload = "UNSIGNED-PAYLOAD";
	}

	const canonicalRequest = [
		method,
		canonicalUri,
		canonicalQueryString,
		canonicalHeaders,
		signedHeadersStr,
		hashedPayload,
	].join("\n");

	const hashedCanonicalRequest = createHash("sha256")
		.update(canonicalRequest)
		.digest("hex");

	const [_accessKey, dateStamp, regionScope, serviceScope, requestType] =
		credential.split("/");
	if (
		!dateStamp ||
		!regionScope ||
		!serviceScope ||
		requestType !== "aws4_request"
	) {
		return false;
	}
	const credentialScope = `${dateStamp}/${regionScope}/${serviceScope}/${requestType}`;

	const stringToSign = [
		algorithm,
		date,
		credentialScope,
		hashedCanonicalRequest,
	].join("\n");

	const kSigning = getSigningKey(
		secretKey,
		dateStamp,
		regionScope,
		serviceScope,
	);

	const calculatedSignature = createHmac("sha256", kSigning)
		.update(stringToSign)
		.digest("hex");

	return signaturesMatch(calculatedSignature, signature);
}
