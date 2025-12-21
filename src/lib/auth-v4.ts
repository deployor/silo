import { createHmac, createHash } from "node:crypto";

export async function verifyAwsV4Signature(
  req: Request,
  secretKey: string,
  service: string = "s3",
  region: string = "auto",
): Promise<boolean> {
  const url = new URL(req.url);
  const method = req.method;
  const headers = req.headers;

  // 1. Extract Signature and Components
  let signature = "";
  let signedHeadersStr = "";
  let credential = "";
  let date = "";
  let algorithm = "AWS4-HMAC-SHA256";

  const authHeader = headers.get("Authorization");
  const query = url.searchParams;

  if (authHeader && authHeader.startsWith("AWS4-HMAC-SHA256")) {
    // Header Auth
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
    // Query Auth (Presigned URL)
    signature = query.get("X-Amz-Signature") || "";
    credential = query.get("X-Amz-Credential") || "";
    signedHeadersStr = query.get("X-Amz-SignedHeaders") || "";
    date = query.get("X-Amz-Date") || "";
    algorithm = query.get("X-Amz-Algorithm") || "AWS4-HMAC-SHA256";
  } else {
    return false; // No signature found
  }

  if (!signature || !credential || !date || !signedHeadersStr) {
    return false;
  }

  // 2. Canonical Request
  // CanonicalURI
  // We need to determine if the user signed the path-style or virtual-host style URI.
  // The `req.url` we get here is the full URL as received by the server.
  // If the host header indicates a bucket subdomain, the user likely signed the path relative to that bucket.
  // If it's the root domain, they signed the full path.
  
  // However, standard S3 proxies often normalize this.
  // Let's assume the URI in the request line is what was signed.
  // In Bun/Hono, url.pathname is the path.
  let canonicalUri = url.pathname;
  
  // If the path is empty, it's "/"
  if (canonicalUri === "") canonicalUri = "/";
  
  // URL Encode - S3 requires specific encoding
  // But usually url.pathname is already decoded. We need to encode it back, but keep slashes.
  // AWS expects each path segment to be URI-encoded.
  canonicalUri = canonicalUri.split('/').map(encodeURIComponent).join('/');
  if (canonicalUri.startsWith("//")) canonicalUri = canonicalUri.slice(1); // Fix double slash from split/join if leading slash
  
  // CanonicalQueryString
  const searchParams = new URLSearchParams(url.search);
  searchParams.delete("X-Amz-Signature"); // Remove signature from query
  
  const sortedKeys = Array.from(searchParams.keys()).sort();
  const canonicalQueryString = sortedKeys
    .map((key) => {
      const value = searchParams.get(key)!;
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join("&");

  // CanonicalHeaders
  const signedHeaders = signedHeadersStr.split(";");
  const canonicalHeaders = signedHeaders
    .map((header) => {
      const value = headers.get(header) || "";
      return `${header.toLowerCase()}:${value.trim().replace(/\s+/g, " ")}`;
    })
    .join("\n") + "\n";

  // HashedPayload
  let hashedPayload = "UNSIGNED-PAYLOAD";
  if (headers.has("X-Amz-Content-Sha256")) {
    hashedPayload = headers.get("X-Amz-Content-Sha256")!;
  } else if (headers.has("x-amz-content-sha256")) {
    hashedPayload = headers.get("x-amz-content-sha256")!;
  } else if (query.has("X-Amz-Signature")) {
    // Presigned URLs usually don't include payload hash in calculation unless specified
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

  // 3. String to Sign
  const [accessKey, dateStamp, regionScope, serviceScope, requestType] = credential.split("/");
  const credentialScope = `${dateStamp}/${regionScope}/${serviceScope}/${requestType}`;

  const stringToSign = [
    algorithm,
    date,
    credentialScope,
    hashedCanonicalRequest,
  ].join("\n");

  // 4. Calculate Signature
  const kDate = createHmac("sha256", `AWS4${secretKey}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(regionScope).digest();
  const kService = createHmac("sha256", kRegion).update(serviceScope).digest();
  const kSigning = createHmac("sha256", kService).update(requestType).digest();

  const calculatedSignature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");

  return calculatedSignature === signature;
}
