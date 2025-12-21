import { s3Client } from "../../lib/s3-client";
import {
  rewriteListObjectsV2Response,
  rewriteDeleteObjectsResponse,
  rewriteMultipartUploadResponse,
} from "../../lib/xml-rewriter";
import {
  getKeyFromRequest,
  getInternalPath,
  rewriteCopySourceHeader,
  stripAuthQueryParams,
  filterUpstreamHeaders,
} from "./utils";
import { db } from "../../db";
import { users, buckets } from "../../db/schema";
import { eq, sql } from "drizzle-orm";
import { config } from "../../config";

export async function handleS3Request(
  req: Request,
  user: typeof users.$inferSelect,
  bucket: typeof buckets.$inferSelect,
  mode: "authenticated" | "public",
): Promise<Response> {
  const method = req.method;

  // console.log(`[S3] ${method} ${req.url}`);
  // console.log("[S3] Headers:", JSON.stringify(Object.fromEntries(req.headers.entries())));

  if (mode === "public" && method !== "GET" && method !== "HEAD") {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>AccessDenied</Code>
    <Message>Access Denied</Message>
    <RequestId>0000000000000000</RequestId>
</Error>`,
      { status: 403, headers: { "Content-Type": "application/xml" } },
    );
  }
  const url = new URL(req.url);
  const S3_DOMAIN = config.s3Domain;
  const host = req.headers.get("host") || "";
  const key = getKeyFromRequest(req, bucket.name);

  // Handle ListBuckets on root domain OR on bucket domain if the path is empty
  // Some clients (like AWS SDK) might call ListBuckets on the bucket endpoint if configured that way,
  // though standard S3 behavior is usually on the root.
  // We'll support it if the key is empty and it looks like a service-level request,
  // BUT for virtual-host style, the bucket is in the host, so it's technically a bucket-level request.
  // However, if the user asks for "ListBuckets", they expect a list of buckets.
  // Since we only have one bucket per user, we can return that.
  if (
    (host === S3_DOMAIN && url.pathname === "/") ||
    (key === "" &&
      method === "GET" &&
      !url.searchParams.has("list-type") &&
      !url.searchParams.has("uploads") &&
      !url.searchParams.has("location"))
  ) {
    // If it's a bucket-specific request (virtual host), standard S3 treats GET / as ListObjects.
    // But if the client explicitly sends a ListBuckets style request (which is just GET / on the service),
    // it's ambiguous when using virtual hosts.
    // However, our logic below handles ListObjects if list-type is 2 OR if key is empty and no other params.
    // Let's refine:
    // If host is S3_DOMAIN (path style root), it's definitely ListBuckets.
    // If host is bucket.s3.domain, GET / is ListObjects.

    if (host === S3_DOMAIN) {
      if (method === "GET") {
        const userBuckets = await db
          .select()
          .from(buckets)
          .where(eq(buckets.userId, user.id));

        const bucketsXml = userBuckets
          .map(
            (b) => `
    <Bucket>
      <Name>${b.name}</Name>
      <CreationDate>${b.createdAt ? new Date(b.createdAt).toISOString() : new Date().toISOString()}</CreationDate>
    </Bucket>`,
          )
          .join("");

        return new Response(
          `
<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
  <Owner>
    <ID>${user.id}</ID>
    <DisplayName>${user.id}</DisplayName>
  </Owner>
  <Buckets>${bucketsXml}
  </Buckets>
</ListAllMyBucketsResult>`.trim(),
          {
            headers: { "Content-Type": "application/xml" },
          },
        );
      }
      return new Response("Method Not Allowed", { status: 405 });
    }
  }
  const internalPath = getInternalPath(key, user, bucket);

  if (key === "") {
    if (method === "PUT") {
      return new Response(
        `
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>AccessDenied</Code>
  <Message>Bucket creation is not allowed. Please use the dashboard.</Message>
  <Resource>/</Resource>
  <RequestId>0000000000000000</RequestId>
</Error>`.trim(),
        { status: 403, headers: { "Content-Type": "application/xml" } },
      );
    }
    if (method === "DELETE") {
      return new Response(
        `
<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>AccessDenied</Code>
    <Message>Bucket deletion is not allowed. Please use the dashboard.</Message>
    <Resource>/</Resource>
    <RequestId>0000000000000000</RequestId>
</Error>`.trim(),
        { status: 403, headers: { "Content-Type": "application/xml" } },
      );
    }
  }

  if (method === "GET") {
    if (key === "" && url.searchParams.has("location")) {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">eu-central-1</LocationConstraint>`,
        {
          headers: { "Content-Type": "application/xml" },
        },
      );
    }


    const listType = url.searchParams.get("list-type");
    const isListObjects =
      listType === "2" ||
      (key === "" &&
        !url.searchParams.has("uploads") &&
        !url.searchParams.has("location"));

    if (isListObjects) {
      const query = url.searchParams;
      const userPrefix = query.get("prefix") || "";
      const internalPrefix = getInternalPath(userPrefix, user, bucket);

      const newQuery = new URLSearchParams(query);
      newQuery.set("prefix", internalPrefix);

      if (query.has("start-after")) {
        newQuery.set(
          "start-after",
          getInternalPath(query.get("start-after")!, user, bucket),
        );
      }

      const cleanUrl = stripAuthQueryParams(
        new URL(`http://localhost/?${newQuery.toString()}`),
      );

      const response = await s3Client.fetch(
        `?${cleanUrl.searchParams.toString()}`,
        {
          method: "GET",
          headers: filterUpstreamHeaders(req.headers),
        },
      );

      const xml = await response.text();
      const rootPrefix = getInternalPath("", user, bucket);
      const rewrittenXml = rewriteListObjectsV2Response(xml, rootPrefix);

      return new Response(rewrittenXml, {
        status: response.status,
        headers: { "Content-Type": "application/xml" },
      });
    }

    if (key === "" && url.searchParams.has("uploads")) {
      const query = url.searchParams;
      const userPrefix = query.get("prefix") || "";
      const internalPrefix = getInternalPath(userPrefix, user, bucket);

      const newQuery = new URLSearchParams(query);
      newQuery.set("prefix", internalPrefix);

      if (query.has("key-marker")) {
        newQuery.set(
          "key-marker",
          getInternalPath(query.get("key-marker")!, user, bucket),
        );
      }

      const cleanUrl = stripAuthQueryParams(
        new URL(`http://localhost/?${newQuery.toString()}`),
      );

      const response = await s3Client.fetch(
        `?${cleanUrl.searchParams.toString()}`,
        {
          method: "GET",
          headers: filterUpstreamHeaders(req.headers),
        },
      );

      const xml = await response.text();
      const rootPrefix = getInternalPath("", user, bucket);
      const rewrittenXml = rewriteMultipartUploadResponse(xml, rootPrefix);

      return new Response(rewrittenXml, {
        status: response.status,
        headers: { "Content-Type": "application/xml" },
      });
    }

    try {
      const cleanUrl = stripAuthQueryParams(url);
      const queryStr = cleanUrl.searchParams.toString();
      const pathWithQuery = queryStr
        ? `${internalPath}?${queryStr}`
        : internalPath;

      const response = await s3Client.fetch(pathWithQuery, {
        method: "GET",
        headers: filterUpstreamHeaders(req.headers),
      });

      if (url.searchParams.has("uploadId")) {
        const xml = await response.text();
        const rootPrefix = getInternalPath("", user, bucket);
        const rewrittenXml = rewriteMultipartUploadResponse(xml, rootPrefix);
        return new Response(rewrittenXml, {
          status: response.status,
          headers: { "Content-Type": "application/xml" },
        });
      }

      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (e) {
      return new Response("Internal Error", { status: 500 });
    }
  }

  if (method === "PUT") {
    const contentLength = parseInt(req.headers.get("content-length") || "0");
    const limit = user.storageLimitBytes;
    if (contentLength > 0 && limit !== null) {
      if (
        BigInt(user.storageUsageBytes) + BigInt(contentLength) >
        BigInt(limit)
      ) {
        return new Response(
          `
<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>QuotaExceeded</Code>
    <Message>You have exceeded your storage quota.</Message>
    <Resource>${key}</Resource>
    <RequestId>0000000000000000</RequestId>
</Error>`.trim(),
          { status: 403, headers: { "Content-Type": "application/xml" } },
        );
      }
    }

    const upstreamHeaders = filterUpstreamHeaders(req.headers);

    if (contentLength > 0) {
      upstreamHeaders.set("Content-Length", contentLength.toString());
    }

    // If the client provided a SHA256 checksum, pass it through.
    // Otherwise, default to UNSIGNED-PAYLOAD.
    if (!upstreamHeaders.has("x-amz-content-sha256")) {
      upstreamHeaders.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
    }

    const copySource = req.headers.get("x-amz-copy-source");

    if (copySource) {
      const rewrittenSource = await rewriteCopySourceHeader(
        req,
        copySource,
        user,
      );
      if (!rewrittenSource) {
        return new Response("Access Denied", { status: 403 });
      }
      upstreamHeaders.set("x-amz-copy-source", rewrittenSource);
    }

    try {
      const cleanUrl = stripAuthQueryParams(url);
      const queryStr = cleanUrl.searchParams.toString();
      const pathWithQuery = queryStr
        ? `${internalPath}?${queryStr}`
        : internalPath;

      // Use 0 retries for PUT to avoid consuming the streaming body
      const response = await s3Client.fetch(
        pathWithQuery,
        {
          method: "PUT",
          headers: upstreamHeaders,
          body: req.body,
          duplex: "half",
        } as any,
        1,
      );

      if (response.ok && contentLength > 0 && !copySource) {
        await db
          .update(users)
          .set({
            storageUsageBytes: sql`${users.storageUsageBytes} + ${contentLength}`,
          })
          .where(eq(users.id, user.id));
      }

      if (copySource && response.ok) {
        const xml = await response.text();
        return new Response(xml, {
          status: response.status,
          headers: response.headers,
        });
      }

      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (e: any) {
      console.error("PUT Error:", e);
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>InternalError</Code>
    <Message>${e.message}</Message>
    <Resource>/</Resource>
    <RequestId>0000000000000000</RequestId>
</Error>`,
        { status: 500, headers: { "Content-Type": "application/xml" } },
      );
    }
  }

  if (method === "DELETE") {
    try {
      const cleanUrl = stripAuthQueryParams(url);
      const queryStr = cleanUrl.searchParams.toString();
      const pathWithQuery = queryStr
        ? `${internalPath}?${queryStr}`
        : internalPath;

      const response = await s3Client.fetch(pathWithQuery, {
        method: "DELETE",
        headers: filterUpstreamHeaders(req.headers),
      });

      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (e) {
      return new Response("Internal Error", { status: 500 });
    }
  }

  if (method === "HEAD") {
    if (key === "") {
      return new Response(null, { status: 200 });
    }

    try {
      const cleanUrl = stripAuthQueryParams(url);
      const queryStr = cleanUrl.searchParams.toString();
      const pathWithQuery = queryStr
        ? `${internalPath}?${queryStr}`
        : internalPath;

      const response = await s3Client.fetch(pathWithQuery, {
        method: "HEAD",
        headers: filterUpstreamHeaders(req.headers),
      });

      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    } catch (e) {
      return new Response("Internal Error", { status: 500 });
    }
  }

  if (method === "POST") {
    const query = url.searchParams;

    if (query.has("delete")) {
      const bodyText = await req.text();
      const rootPrefix = getInternalPath("", user, bucket);

      const rewrittenBody = bodyText.replace(
        /<Key>(.*?)<\/Key>/g,
        (match, p1) => {
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
      const rootPrefix = getInternalPath("", user, bucket);
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
      const rootPrefix = getInternalPath("", user, bucket);
      const rewrittenRes = rewriteMultipartUploadResponse(resText, rootPrefix);

      return new Response(rewrittenRes, {
        status: response.status,
        headers: { "Content-Type": "application/xml" },
      });
    }

    return new Response("Not Implemented", { status: 501 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}
