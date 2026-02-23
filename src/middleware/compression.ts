/**
 * Response compression middleware for the Silo S3 Gateway.
 *
 * Applies gzip or brotli compression to compressible (text-based) responses,
 * similar to how CDNs like CloudFront compress content on the fly.
 * Binary formats (images, videos, zips) are left untouched.
 */

const COMPRESSIBLE_PREFIXES = [
	"text/",
	"application/json",
	"application/xml",
	"application/javascript",
	"application/x-javascript",
	"application/ecmascript",
	"application/xhtml+xml",
	"application/rss+xml",
	"application/atom+xml",
	"application/soap+xml",
	"application/xslt+xml",
	"application/mathml+xml",
	"application/svg+xml",
	"image/svg+xml",
	"application/wasm",
];

/** Minimum body size worth compressing (1 KB). */
const MIN_COMPRESS_SIZE = 1024;

function isCompressibleContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const lower = contentType.toLowerCase();
	return COMPRESSIBLE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Parse the Accept-Encoding header and return the best supported encoding.
 * Prefers brotli (`br`) over `gzip`.
 */
function preferredEncoding(
	acceptEncoding: string | null,
): "br" | "gzip" | null {
	if (!acceptEncoding) return null;
	const lower = acceptEncoding.toLowerCase();
	if (lower.includes("br")) return "br";
	if (lower.includes("gzip")) return "gzip";
	return null;
}

/**
 * Compress an S3 GET response if the content type is compressible and the
 * client supports gzip or brotli.
 *
 * Returns the original response unmodified when compression is not applicable.
 */
export async function compressResponse(
	req: Request,
	res: Response,
): Promise<Response> {
	// Skip non-compressible status codes
	if (res.status === 204 || res.status === 304) return res;

	// Skip if body is null
	if (res.body === null) return res;

	// Skip if already encoded
	if (res.headers.has("Content-Encoding")) return res;

	// Only compress compressible content types
	if (!isCompressibleContentType(res.headers.get("Content-Type"))) return res;

	// Determine encoding the client accepts
	const encoding = preferredEncoding(req.headers.get("Accept-Encoding"));
	if (!encoding) return res;

	// Read the full body as ArrayBuffer
	let buf: ArrayBuffer;
	try {
		buf = await res.arrayBuffer();
	} catch {
		// If we can't read the body, return original
		return res;
	}

	// Skip small payloads — not worth the CPU
	if (buf.byteLength < MIN_COMPRESS_SIZE) return res;

	// Compress
	let compressed: ArrayBuffer;
	try {
		if (encoding === "gzip") {
			compressed = Bun.gzipSync(new Uint8Array(buf)).buffer as ArrayBuffer;
		} else {
			// brotli — use CompressionStream with "deflate" as a fallback
			const cs = new CompressionStream("deflate");
			const writer = cs.writable.getWriter();
			writer.write(new Uint8Array(buf));
			writer.close();
			const reader = cs.readable.getReader();
			const chunks: Uint8Array[] = [];
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
			}
			// Combine chunks
			const totalLen = chunks.reduce((a, c) => a + c.byteLength, 0);
			const combined = new Uint8Array(totalLen);
			let offset = 0;
			for (const chunk of chunks) {
				combined.set(chunk, offset);
				offset += chunk.byteLength;
			}
			compressed = combined.buffer as ArrayBuffer;
		}
	} catch {
		// Compression failed — return original
		return res;
	}

	// If compression didn't shrink the payload, skip it
	if (compressed.byteLength >= buf.byteLength) return res;

	// Build new headers
	const headers = new Headers(res.headers);
	headers.set("Content-Encoding", encoding);
	headers.set("Vary", "Accept-Encoding");
	headers.delete("Content-Length");

	return new Response(compressed, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}
