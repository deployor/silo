import { db } from "../../db";
import { users, buckets } from "../../db/schema";
import { eq, sql } from "drizzle-orm";
import { config } from "../../config";

const landingTemplate = await Bun.file(
  "src/features/landing/templates/landing.html",
).text();
const dashboardTemplate = await Bun.file(
  "src/features/landing/templates/dashboard.html",
).text();
const docsTemplate = await Bun.file(
  "src/features/landing/templates/docs.html",
).text();

async function getCurrentUser(req: Request) {
  const cookieHeader = req.headers.get("Cookie");
  if (cookieHeader) {
    const cookies = cookieHeader.split(";").reduce(
      (acc, cookie) => {
        const [key, value] = cookie.trim().split("=");
        acc[key] = value;
        return acc;
      },
      {} as Record<string, string>,
    );

    if (cookies["cargo_user_id"]) {
      const user = await db
        .select()
        .from(users)
        .where(eq(users.id, cookies["cargo_user_id"]))
        .limit(1);
      if (user.length > 0) return user[0];
    }
  }

  return null;
}

export async function handleDashboardRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/docs" || path === "/docs/") {
    const finalDocs = docsTemplate.replace(
      /https:\/\/cargo\.hackclub\.com/g,
      `https://${config.s3Domain}`,
    );
    return new Response(finalDocs, {
      headers: { "Content-Type": "text/html" },
    });
  }

  if (path.startsWith("/auth/")) {
    if (path === "/auth/login") {
      const authUrl = `https://auth.hackclub.com/oauth/authorize?client_id=${config.hcAuth.clientId}&redirect_uri=${encodeURIComponent(config.hcAuth.redirectUri)}&response_type=code&scope=openid%20profile%20email`;
      return Response.redirect(authUrl);
    }

    if (path === "/auth/callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400 });

      try {
        const params = new URLSearchParams();
        params.append("client_id", config.hcAuth.clientId);
        params.append("client_secret", config.hcAuth.clientSecret);
        params.append("code", code);
        params.append("grant_type", "authorization_code");
        params.append("redirect_uri", config.hcAuth.redirectUri);

        const tokenRes = await fetch("https://auth.hackclub.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params,
        });

        if (!tokenRes.ok) {
          const text = await tokenRes.text();
          console.error("Token Exchange Failed:", text);
          throw new Error(`Token exchange failed: ${tokenRes.status}`);
        }

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          console.error("Token Error:", tokenData);
          throw new Error("Failed to get token");
        }

        const userRes = await fetch(
          "https://auth.hackclub.com/oauth/userinfo",
          {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          },
        );
        const userData = await userRes.json();

        const userId = userData.sub;

        await db
          .insert(users)
          .values({
            id: userId,
            email: userData.email,
          })
          .onConflictDoUpdate({
            target: users.id,
            set: { email: userData.email },
          });

        const headers = new Headers();
        headers.set(
          "Set-Cookie",
          `cargo_user_id=${userId}; Path=/; HttpOnly; SameSite=Lax`,
        );
        headers.set("Location", "/");

        return new Response(null, { status: 302, headers });
      } catch (e) {
        console.error("Auth Error:", e);
        return new Response("Authentication Failed", { status: 500 });
      }
    }

    if (path === "/auth/logout") {
      const headers = new Headers();
      headers.set(
        "Set-Cookie",
        `cargo_user_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      );
      headers.set("Location", "/");
      return new Response(null, { status: 302, headers });
    }
  }

  if (path.startsWith("/api/dashboard/")) {
    const user = await getCurrentUser(req);
    if (!user) return new Response("Unauthorized", { status: 401 });

    if (path === "/api/dashboard/stats") {
      const userBuckets = await db
        .select()
        .from(buckets)
        .where(eq(buckets.userId, user.id));

      return new Response(
        JSON.stringify({
          user: {
            id: user.id,
            storageUsage: user.storageUsageBytes,
            storageLimit: user.storageLimitBytes,
            ingressBytes: user.ingressBytes,
            egressBytes: user.egressBytes,
            totalBytes: user.ingressBytes + user.egressBytes,
            totalRequests: user.totalRequests,
          },
          buckets: userBuckets.map((b) => ({
            name: b.name,
            accessKey: b.accessKey,
            createdAt: b.createdAt,
            totalBytes: b.totalBytes,
            totalRequests: b.totalRequests,
          })),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    if (path === "/api/dashboard/buckets" && req.method === "POST") {
      try {
        const body = await req.json();
        const name = body.name;

        if (!name || !/^[a-z0-9-]+$/.test(name)) {
          return new Response("Invalid bucket name", { status: 400 });
        }

        const userBuckets = await db
          .select()
          .from(buckets)
          .where(eq(buckets.userId, user.id));
        if (userBuckets.length >= 50) {
          return new Response("Bucket limit reached", { status: 403 });
        }

        const existing = await db
          .select()
          .from(buckets)
          .where(eq(buckets.name, name))
          .limit(1);
        if (existing.length > 0) {
          return new Response("Bucket name already taken", { status: 409 });
        }

        const accessKey =
          "CK" +
          Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) =>
            b.toString(16).padStart(2, "0"),
          )
            .join("")
            .toUpperCase();
        const secretKey = Array.from(
          crypto.getRandomValues(new Uint8Array(20)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");

        await db.insert(buckets).values({
          name,
          userId: user.id,
          accessKey,
          secretKey,
          isPublic: false,
        });

        return new Response(JSON.stringify({ accessKey, secretKey }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        console.error(e);
        return new Response("Internal Error", { status: 500 });
      }
    }

    if (path.startsWith("/api/dashboard/buckets/") && req.method === "DELETE") {
      const bucketName = path.split("/").pop();
      if (!bucketName)
        return new Response("Invalid bucket name", { status: 400 });

      const bucket = await db
        .select()
        .from(buckets)
        .where(eq(buckets.name, bucketName))
        .limit(1);
      if (bucket.length === 0)
        return new Response("Bucket not found", { status: 404 });
      if (bucket[0].userId !== user.id)
        return new Response("Unauthorized", { status: 403 });

      await db.delete(buckets).where(eq(buckets.name, bucketName));

      return new Response("Deleted", { status: 200 });
    }
  }

  const user = await getCurrentUser(req);
  if (!user) {
    return new Response(landingTemplate, {
      headers: { "Content-Type": "text/html" },
    });
  }

  const finalDashboard = dashboardTemplate.replace(
    "https://cargo.deployor.dev",
    `https://${config.s3Domain}`,
  );
  return new Response(finalDashboard, {
    headers: { "Content-Type": "text/html" },
  });
}
