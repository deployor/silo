import { createHash, createHmac } from "node:crypto";

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
	let algorithm = "AWS4-HMAC-SHA256";

	const authHeader = headers.get("Authorization");
	const query = url.searchParams;

	if (authHeader?.startsWith("AWS4-HMAC-SHA256")) {
		algorithm = "AWS4-HMAC-SHA256";
		const params = authHeader.slice("AWS4-HMAC-SHA256".length).trim();
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
		algorithm = query.get("X-Amz-Algorithm") || "AWS4-HMAC-SHA256";
	} else {
		return false;
	}

	if (!signature || !credential || !date || !signedHeadersStr) {
		return false;
	}

	let canonicalUri = url.pathname;

	if (canonicalUri === "") canonicalUri = "/";

	const awsUriEncode = (input: string, encodeSlash: boolean = true) => {
		// AWS SigV4 percent-encoding:
		// - encodeURIComponent + RFC3986 fixes for !'()*
		// - spaces must be %20 (encodeURIComponent already does this)
		// - for canonical URI, slashes are preserved between segments; for query, slashes are encoded.
		let result = encodeURIComponent(input).replace(
			/[!'()*]/g,
			(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
		);
		if (!encodeSlash) {
			result = result.replace(/%2F/g, "/");
		}
		return result;
	};

	// Canonical URI: URL.pathname is already decoded for some characters.
	// If the incoming path contains percent-encoded bytes (e.g. %20), `url.pathname`
	// preserves them literally as "%20". We must NOT double-encode the '%' into '%25'.
	//
	// AWS rule: each path segment is URI-encoded, but existing percent-encoded triplets
	// should be preserved.
	const preservePctEncoded = (s: string) =>
		s.replace(/%[0-9A-Fa-f]{2}/g, (m) => m.toUpperCase());

	canonicalUri = canonicalUri
		.split("/")
		.map((segment) => {
			// Protect existing %XX sequences from being re-encoded.
			const protectedSegment = preservePctEncoded(segment);
			const placeholder = "___PCT___";
			const withPlaceholders = protectedSegment.replace(
				/%[0-9A-F]{2}/g,
				(m) => `${placeholder}${m.slice(1)}`,
			);
			let enc = awsUriEncode(withPlaceholders, false);
			enc = enc.replace(new RegExp(`${placeholder}([0-9A-F]{2})`, "g"), "%$1");
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
	const rawSearch = url.search.startsWith("?") ? url.search.slice(1) : url.search;
	const pairs: Array<[string, string]> = rawSearch
		? rawSearch.split("&").map((kv) => {
			const i = kv.indexOf("=");
			const k = i === -1 ? kv : kv.slice(0, i);
			const v = i === -1 ? "" : kv.slice(i + 1);
			// decode '+' as space for query params
			const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, "%20"));
			return [decode(k), decode(v)] as [string, string];
		})
		: [];

	const filtered = pairs.filter(([k]) => k !== "X-Amz-Signature");

	const canonicalQueryString = filtered
		.map(([k, v]) => [awsUriEncode(k, true), awsUriEncode(v, true)] as [string, string])
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join("&");

	const signedHeaders = signedHeadersStr.split(";");
	const canonicalHeaders = `${signedHeaders
		.map((header) => {
			const value = headers.get(header) || "";
			return `${header.toLowerCase()}:${value.trim().replace(/\s+/g, " ")}`;
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
	const credentialScope = `${dateStamp}/${regionScope}/${serviceScope}/${requestType}`;

	const stringToSign = [
		algorithm,
		date,
		credentialScope,
		hashedCanonicalRequest,
	].join("\n");

	const kDate = createHmac("sha256", `AWS4${secretKey}`)
		.update(dateStamp)
		.digest();
	const kRegion = createHmac("sha256", kDate).update(regionScope).digest();
	const kService = createHmac("sha256", kRegion).update(serviceScope).digest();
	// Per SigV4, the final key derivation step is ALWAYS with the literal string "aws4_request".
	// (Not the requestType from the credential scope; it should always be aws4_request.)
	const kSigning = createHmac("sha256", kService)
		.update("aws4_request")
		.digest();

	const calculatedSignature = createHmac("sha256", kSigning)
		.update(stringToSign)
		.digest("hex");

	return calculatedSignature === signature;
}
