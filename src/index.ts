import { authenticate } from "./middleware/auth";
import { handleS3Request } from "./features/s3-api";
import { updateStats } from "./features/s3-api/utils";
import { handleDashboardRequest } from "./features/landing";
import { config } from "./config";

const S3_DOMAIN = config.s3Domain;

Bun.serve({
  port: process.env.PORT || 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get("host") || "";

    let isDashboard = false;

    if (
      host === S3_DOMAIN ||
      (S3_DOMAIN === "localhost:3000" && host.startsWith("localhost"))
    ) {
      const path = url.pathname;
      const hasAuthHeader = req.headers.has("authorization");
      const hasAmzParams =
        url.searchParams.has("X-Amz-Algorithm") ||
        url.searchParams.has("x-amz-algorithm");

      // If it looks like an S3 request (Auth header or params), treat as S3
      if (hasAuthHeader || hasAmzParams) {
        isDashboard = false;
      } else {
        // Otherwise, check if it matches dashboard paths
        if (
          path === "/" ||
          path.startsWith("/auth/") ||
          path.startsWith("/api/dashboard/") ||
          path.startsWith("/docs")
        ) {
          isDashboard = true;
        } else {
          // If it's not a known dashboard path and has no auth,
          // it might be an unauthenticated S3 request (which will fail auth)
          // OR a static asset for dashboard (if we had any).
          // For now, default to S3 to let auth middleware handle the denial.
          isDashboard = false;
        }
      }
    } else {
      isDashboard = false;
    }

    if (isDashboard) {
      return handleDashboardRequest(req);
    }

    try {
      const authResult = await authenticate(req);

      if (authResult instanceof Response) {
        return authResult;
      }

      const { user, bucket } = authResult;
      const response = await handleS3Request(req, user, bucket);

      updateStats(user, bucket, req, response);

      return response;
    } catch (e) {
      console.error("S3 Request Error:", e);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
});

console.log(`Cargo S3 Gateway running on port ${process.env.PORT || 3000}`);
