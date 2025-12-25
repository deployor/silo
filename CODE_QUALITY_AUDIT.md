# Code Quality Audit & Improvement Plan

## 🚨 Critical / "Insane" Issues

1.  **Manual XML Construction (`src/core/s3/get.ts`)**
    *   **Issue:** XML responses (CORS config, LocationConstraint, ListBuckets) are built using template literals and string concatenation.
    *   **Why it's insane:** This is extremely error-prone, hard to read, and susceptible to injection attacks if data isn't perfectly sanitized. It makes maintaining the XML structure a nightmare.
    *   **Fix:** Use an XML builder library (like `fast-xml-parser`'s builder or similar) to generate XML from objects.

2.  **Inefficient CORS Handling (`src/core/s3/cors.ts`)**
    *   **Issue:** `bucket.corsConfig` (stored as a JSON string in DB) is `JSON.parse()`'d on *every single request* in `handleCorsPreflight` and `getCorsHeaders`.
    *   **Why it's insane:** This is a significant performance hit for high-throughput S3 compatible endpoints.
    *   **Fix:** Implement caching for parsed CORS configs or refactor the DB schema to store rules in a separate table (though caching is easier given the current setup).

3.  **"God File" Routing (`src/index.ts`)**
    *   **Issue:** `src/index.ts` contains a massive `Bun.serve` handler that manually routes between Dashboard, Admin, Slack, and S3 logic using complex if/else blocks and string matching.
    *   **Why it's insane:** It makes the entry point hard to understand and test. Adding new routes is risky.
    *   **Fix:** Extract routing logic into a dedicated router or middleware chain (e.g., using Hono since the project name implies it, or just cleaner function composition).

4.  **Manual URL Construction (`src/core/s3/get.ts`)**
    *   **Issue:** `new URL('http://localhost/?${newQuery.toString()}')` is used to strip params.
    *   **Why it's insane:** It's a hacky way to manipulate query parameters.
    *   **Fix:** Operate directly on `URLSearchParams` or use a proper utility.

5.  **Security: Bypassing Payload Signing (`src/core/s3/put.ts`)**
    *   **Issue:** `upstreamHeaders.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");` is set if missing.
    *   **Why it's insane:** While this might be necessary for the proxying architecture, it blindly disables integrity checks for the upstream connection.
    *   **Fix:** Verify if this is strictly required or if we can pass through the client's signature/hash if provided. At minimum, document *why* this is safe in this context.

## ⚠️ Code Quality & Organization

6.  **Type Safety & `any` Usage**
    *   **Issue:** `src/core/s3/put.ts` and `src/core/s3/cors.ts` use `any` for iterating over CORS rules.
    *   **Fix:** Define proper TypeScript interfaces for the CORS configuration structure.

7.  **Code Duplication (`src/core/s3/get.ts`)**
    *   **Issue:** Logic for `isListObjects` and `uploads` (Multipart List) is nearly identical but copy-pasted.
    *   **Fix:** Refactor into a shared `proxyS3Request` or similar helper function.

8.  **Middleware Responsibilities (`src/middleware/auth.ts`)**
    *   **Issue:** The `authenticate` function also handles business logic like checking storage limits, paused states, and account locking.
    *   **Fix:** Split into `authenticate` (identity) and `authorize` (permissions/limits) middleware/functions.

9.  **Hardcoded Magic Strings**
    *   **Issue:** "AWS4-HMAC-SHA256", "s3", and various header names are hardcoded throughout.
    *   **Fix:** Move constants to a `constants.ts` file.

## 📝 Plan of Action

1.  **Fix Immediate Test Failure:** Investigate and fix the CORS `GET` method mismatch in `scripts/test-prod-comprehensive.ts`.
2.  **Refactor XML Generation:** Replace string concatenation in `get.ts` with a proper XML builder.
3.  **Optimize CORS:** Reduce JSON parsing overhead.
4.  **Cleanup `index.ts`:** Extract routing logic.
5.  **Type Definitions:** Add types for CORS config and remove `any`.
