/**
 * Local SigV4 debug helper.
 *
 * Generates a signed request using aws4fetch, then runs server verifier locally,
 * printing the canonical request and string-to-sign that the verifier uses.
 */

import { createHash, createHmac } from "node:crypto";
import { AwsClient } from "aws4fetch";

function awsUriEncode(input: string, encodeSlash: boolean = true) {
	// AWS SigV4: percent-encode per RFC3986, spaces as %20.
	// IMPORTANT: encodeURIComponent will encode '%' to '%25', so callers must ensure
	// already-encoded triplets are not double-encoded.
	let result = encodeURIComponent(input).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	if (!encodeSlash) result = result.replace(/%2F/g, "/");
	return result;
}

function canonicalize(req: Request) {
	const url = new URL(req.url);

	// canonical URI
	let canonicalUri = url.pathname;
	if (canonicalUri === "") canonicalUri = "/";

	const preservePctEncoded = (s: string) =>
		s.replace(/%[0-9A-Fa-f]{2}/g, (m) => m.toUpperCase());

	canonicalUri = canonicalUri
		.split("/")
		.map((segment) => {
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

	// canonical query
	const rawSearch = url.search.startsWith("?")
		? url.search.slice(1)
		: url.search;
	const pairs: Array<[string, string]> = rawSearch
		? rawSearch.split("&").map((kv) => {
				const i = kv.indexOf("=");
				const k = i === -1 ? kv : kv.slice(0, i);
				const v = i === -1 ? "" : kv.slice(i + 1);
				const decode = (s: string) =>
					decodeURIComponent(s.replace(/\+/g, "%20"));
				return [decode(k), decode(v)] as [string, string];
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

	const headers = req.headers;

	// Pull auth details
	const authHeader =
		headers.get("Authorization") ?? headers.get("authorization") ?? "";
	if (!authHeader.startsWith("AWS4-HMAC-SHA256"))
		throw new Error("No SigV4 Authorization header");

	const params = authHeader.slice("AWS4-HMAC-SHA256".length).trim();
	const pairs2 = params.split(",").map((p) => p.trim());
	let credential = "";
	let signedHeadersStr = "";
	let signature = "";
	for (const pair of pairs2) {
		const [k, v] = pair.split("=");
		if (k === "Credential") credential = v ?? "";
		if (k === "SignedHeaders") signedHeadersStr = v ?? "";
		if (k === "Signature") signature = v ?? "";
	}

	const amzDate =
		headers.get("X-Amz-Date") ??
		headers.get("x-amz-date") ??
		headers.get("Date") ??
		"";

	const signedHeaders = signedHeadersStr.split(";");
	const canonicalHeaders = `${signedHeaders
		.map((h) => {
			const value = headers.get(h) || "";
			return `${h.toLowerCase()}:${value.trim().replace(/\s+/g, " ")}`;
		})
		.join("\n")}\n`;

	// payload hash
	let hashedPayload = "UNSIGNED-PAYLOAD";
	// For header-signed requests, this header is signed but can differ from the body.
	// We just reflect what the signer told us.
	if (headers.has("x-amz-content-sha256"))
		hashedPayload = headers.get("x-amz-content-sha256") || "";
	else if (headers.has("X-Amz-Content-Sha256"))
		hashedPayload = headers.get("X-Amz-Content-Sha256") || "";

	const canonicalRequest = [
		req.method,
		canonicalUri,
		canonicalQueryString,
		canonicalHeaders,
		signedHeadersStr,
		hashedPayload,
	].join("\n");

	return { canonicalRequest, credential, signature, amzDate };
}

function sha256Hex(s: string) {
	return createHash("sha256").update(s).digest("hex");
}

function hmac(key: Buffer | string, data: string) {
	return createHmac("sha256", key).update(data).digest();
}

async function main() {
	const endpoint = process.env.SIGV4_ENDPOINT ?? "https://silo.deployor.dev";
	const bucket = process.env.SIGV4_BUCKET ?? "testprivbucket";
	const accessKeyId = process.env.SIGV4_ACCESS_KEY;
	const secretAccessKey = process.env.SIGV4_SECRET_KEY;
	if (!accessKeyId || !secretAccessKey)
		throw new Error("Need SIGV4_ACCESS_KEY and SIGV4_SECRET_KEY");

	const aws = new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: "s3",
		region: "auto",
	});

	const url = `${endpoint}/${bucket}/space%20key.txt`;
	const signed = await aws.sign(url, { method: "PUT" });

	console.log("signed url:", signed.url);
	console.log("authorization:", signed.headers.get("authorization"));
	console.log("x-amz-date:", signed.headers.get("x-amz-date"));
	console.log(
		"x-amz-content-sha256:",
		signed.headers.get("x-amz-content-sha256"),
	);

	const req = new Request(signed.url, {
		method: "PUT",
		headers: signed.headers,
		body: "hello",
	});

	const { canonicalRequest, credential, signature, amzDate } =
		canonicalize(req);
	const hashedCanonicalRequest = sha256Hex(canonicalRequest);

	const parts = credential.split("/");
	const dateStamp = parts[1];
	const regionScope = parts[2];
	const serviceScope = parts[3];
	const requestType = parts[4];
	const credentialScope = `${dateStamp}/${regionScope}/${serviceScope}/${requestType}`;

	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		hashedCanonicalRequest,
	].join("\n");

	const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
	const kRegion = hmac(kDate, regionScope);
	const kService = hmac(kRegion, serviceScope);
	const kSigning = hmac(kService, "aws4_request");

	const calc = createHmac("sha256", kSigning)
		.update(stringToSign)
		.digest("hex");

	console.log("\n--- canonicalRequest ---\n" + canonicalRequest);
	console.log("\n--- stringToSign ---\n" + stringToSign);
	console.log("\n--- signature compare ---");
	console.log("expected:", signature);
	console.log("calculated:", calc);
	console.log("match:", calc === signature);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
