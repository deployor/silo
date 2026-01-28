import type { buckets, users } from "../../db/schema";
import { s3Client } from "../../lib/s3-client";
import { S3Errors } from "../../lib/s3-errors";
import {
	rewriteDeleteObjectsResponse,
	rewriteMultipartUploadResponse,
} from "../../lib/xml-rewriter";
import { filterUpstreamHeaders, getInternalPath } from "./utils";

export async function handlePostRequest(
	req: Request,
	user: typeof users.$inferSelect | null,
	bucket: typeof buckets.$inferSelect,
	internalPath: string,
	url: URL,
) {
	const query = url.searchParams;

	if (query.has("delete")) {
		const bodyText = await req.text();
		const rootPrefix = getInternalPath("", user || undefined, bucket);

		const rewrittenBody = bodyText.replace(
			/<Key>(.*?)<\/Key>/g,
			(_match, p1) => {
				return `<Key>${rootPrefix}${p1}</Key>`;
			},
		);

		const md5 = new Bun.CryptoHasher("md5")
			.update(rewrittenBody)
			.digest("base64");

		const headers = filterUpstreamHeaders(req.headers);
		headers.set("Content-MD5", md5);
		headers.delete("Content-Length");

		const response = await s3Client.fetch(`?delete`, {
			method: "POST",
			headers: headers,
			body: rewrittenBody,
		});

		const resText = await response.text();
		const rewrittenRes = rewriteDeleteObjectsResponse(resText, rootPrefix);

		return new Response(rewrittenRes, {
			status: response.status,
			headers: { "Content-Type": "application/xml" },
		});
	}

	if (query.has("uploads")) {
		const response = await s3Client.fetch(`${internalPath}?uploads`, {
			method: "POST",
			headers: filterUpstreamHeaders(req.headers),
		});
		const resText = await response.text();
		const rootPrefix = getInternalPath("", user || undefined, bucket);
		const rewrittenRes = rewriteMultipartUploadResponse(resText, rootPrefix);

		return new Response(rewrittenRes, {
			status: response.status,
			headers: { "Content-Type": "application/xml" },
		});
	}

	if (query.has("uploadId")) {
		const uploadId = query.get("uploadId");
		const response = await s3Client.fetch(
			`${internalPath}?uploadId=${uploadId}`,
			{
				method: "POST",
				headers: filterUpstreamHeaders(req.headers),
				body: req.body,
			},
		);

		const resText = await response.text();
		const rootPrefix = getInternalPath("", user || undefined, bucket);
		const rewrittenRes = rewriteMultipartUploadResponse(resText, rootPrefix);

		return new Response(rewrittenRes, {
			status: response.status,
			headers: { "Content-Type": "application/xml" },
		});
	}

	return S3Errors.NotImplemented().toResponse();
}
