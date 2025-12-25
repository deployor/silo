# Code Quality Issues & Improvement Plan

## 🚨 Critical Issues (Security & Stability)

1.  **Hardcoded Secrets & Magic Strings**:
    *   `src/web/dashboard/index.ts`: Contains `if (code === "1beans")`. This is a hardcoded backdoor/bypass code.
    *   `src/web/dashboard/index.ts`: "wip_bypass" string used for HMAC generation.
    *   **Fix**: Move all secrets to environment variables. Remove hardcoded backdoors.

2.  **Manual XML Generation**:
    *   `src/core/s3/index.ts`: XML is constructed using string concatenation (e.g., `rule += "<CORSRule>";`).
    *   **Risk**: XML Injection if user input isn't properly escaped.
    *   **Fix**: Use a proper XML builder library or a helper function that handles escaping.

3.  **Fragile HTML Templating**:
    *   `src/web/dashboard/index.ts` & `src/web/admin/index.ts`: Uses `string.replace()` on HTML files.
    *   **Risk**: Prone to errors and hard to maintain. No XSS protection for injected values.
    *   **Fix**: Use a lightweight template engine (e.g., Handlebars, EJS) or at least a robust tagged template literal system with escaping.

4.  **Monolithic Route Handlers**:
    *   `src/index.ts`: The `fetch` handler is a massive `if/else` chain.
    *   `src/web/dashboard/index.ts`: Over 1200 lines handling UI, Auth, API, and File Proxying.
    *   **Fix**: Implement a proper router (Hono is already in the project name "fast-deploy-hono" but not used? Or just use a better router pattern with Bun). *Correction: Project name implies Hono but `package.json` doesn't list it. We should probably stick to Bun's native router or a simple custom one, but split the files.*

## ⚠️ High Priority (Maintainability & Architecture)

5.  **Code Duplication**:
    *   `getCurrentUser` is repeated in `src/web/admin/index.ts` and `src/web/dashboard/index.ts`.
    *   CORS handling logic is scattered.
    *   S3 Error XML generation is repeated.

6.  **Direct Database Access in Controllers**:
    *   Route handlers directly query `db`.
    *   **Fix**: Move DB logic to a Service layer (e.g., `UserService`, `BucketService`).

7.  **Type Safety**:
    *   Usage of `any` in `src/web/admin/index.ts` (`updateData: any`) and `src/core/s3/index.ts`.

8.  **Error Handling**:
    *   `console.error` used everywhere.
    *   Inconsistent error responses (sometimes JSON, sometimes XML, sometimes plain text).

## 📝 Improvement Plan

### Phase 1: Refactoring & Organization
- [ ] **Split `src/web/dashboard/index.ts`**: Break into `routes/auth.ts`, `routes/api.ts`, `routes/ui.ts`.
- [ ] **Split `src/core/s3/index.ts`**: Separate GET, PUT, DELETE, POST logic into separate files.
- [ ] **Centralize Utilities**: Move `getCurrentUser` to `src/lib/auth-utils.ts`.

### Phase 2: Security Hardening
- [ ] Remove "1beans" hardcoded password.
- [ ] Implement proper XML builder for S3 responses.
- [ ] Audit all user inputs used in SQL queries (Drizzle handles most, but check `sql` tag usage).

### Phase 3: Architecture
- [ ] Create a `services/` directory for business logic.
- [ ] Standardize API responses.

---

## Specific "Insane" Things Noticed
- `src/index.ts`: The `isDashboardRequest` logic is very complex and mixes domain checks with path checks.
- `src/lib/s3-client.ts`: The `HetznerS3Client` manually constructs URLs and handles retries in a way that might be better handled by the AWS SDK middleware if possible, or at least simplified.
- `src/web/dashboard/index.ts`: The `handleDashboardRequest` function is doing too much. It handles OAuth callbacks, serving static HTML, and JSON APIs.
