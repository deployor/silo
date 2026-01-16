# Security Audit Report

**Date:** 2026-01-15
**Target:** Silo Codebase (S3 Gateway & Dashboard)
**Auditor:** Roo

## 1. Executive Summary

This audit is an update to the previous report (2025-12-25). It incorporates a fresh dependency vulnerability scan and a targeted static review of the highest-risk paths: session/cookie handling, auth callbacks, SigV4 verification, CORS behavior, security headers/CSP, and rate limiting.

**Overall Security Posture:** **Strong**, with actionable hardening work in dependencies and a few defense-in-depth improvements.

Key changes since the last audit:
- **Dependency vulnerabilities detected via `npm audit`** (1 high, 4 moderate). The high severity finding is in [`hono`](src/middleware/security-headers.ts:1) (indirect risk depends on whether JWT/JWK middleware is used).
- Several **defense-in-depth items** remain relevant: explicit CSRF protection for browser endpoints, tightening CSP, and improving rate limiting accuracy behind proxies.

## 2. Methodology

The audit was conducted through:
- Static code review
- `npm audit --audit-level=low`

Focus areas:
- **Authentication:** [`src/lib/auth-v4.ts`](src/lib/auth-v4.ts:1), [`src/web/dashboard/auth.ts`](src/web/dashboard/auth.ts:1)
- **Sessions/Cookies:** [`src/lib/session.ts`](src/lib/session.ts:1)
- **Web security headers / CSP:** [`src/middleware/security-headers.ts`](src/middleware/security-headers.ts:1)
- **CORS:** [`src/core/s3/cors.ts`](src/core/s3/cors.ts:1), [`src/web/dashboard/api/cors.ts`](src/web/dashboard/api/cors.ts:1)
- **Rate limiting:** [`src/middleware/rate-limit.ts`](src/middleware/rate-limit.ts:1)
- **Env/config:** [`src/config.ts`](src/config.ts:1)

## 3. Automated Findings (Dependencies)

Command executed:
- `npm audit --audit-level=low`

Findings:

### 3.1 High Severity

- **hono <= 4.11.3** – JWT/JWK algorithm confusion vulnerabilities (token forgery/auth bypass) per advisories.
  - `npm audit` indicates a fix is available via `npm audit fix`.
  - **Impact in this codebase:** a repo-wide search did not show direct usage of JWT/JWK middleware, but the dependency is still present. If added later (or used indirectly), this becomes high risk.

### 3.2 Moderate Severity

- **esbuild <= 0.24.2** – dev server request/response exposure advisory.
  - `npm audit` indicates a fix is available via `npm audit fix --force` but it would upgrade `drizzle-kit` with breaking changes.
  - **Impact:** primarily affects developer workstations / dev server usage, not prod runtime, but should still be remediated to reduce supply-chain/developer-env exposure.

## 4. Manual Review Findings

### 4.1 Authentication & Sessions

- Session cookies are issued with `HttpOnly; Secure; SameSite=Lax` in [`handleAuthRequest()`](src/web/dashboard/auth.ts:8), which is a solid baseline.
- Token refresh logic in [`getCurrentUser()`](src/lib/session.ts:7) is server-side and does not expose secrets to the browser.

**Risk / hardening:**
- Cookie parsing is implemented via naive `split("=")` logic in multiple places (e.g. [`getCurrentUser()`](src/lib/session.ts:7), [`handleAuthRequest()`](src/web/dashboard/auth.ts:8)). This can mis-parse cookie values containing `=` and can lead to inconsistent auth behavior. This is more reliability than exploitability, but auth-adjacent parsing should be robust.

### 4.2 Rate Limiting

- [`rateLimit()`](src/middleware/rate-limit.ts:25) uses `x-forwarded-for` directly or falls back to `127.0.0.1`.

**Risk / hardening:**
- If the app is deployed behind a proxy/CDN, `x-forwarded-for` can contain a comma-separated list of IPs; using the full header value as a key can break limiting.
- If the service is *not* behind a trusted proxy, accepting client-controlled `x-forwarded-for` allows trivial bypass.

### 4.3 CORS

- S3 preflight handling in [`handleCorsPreflight()`](src/core/s3/cors.ts:38) and response header inference in [`getCorsHeaders()`](src/core/s3/cors.ts:119) are generally correct.

**Risk / hardening:**
- If a bucket’s CORS config allows `AllowedOrigins: ["*"]`, responses may be readable cross-origin. That is expected S3 behavior, but it should be clearly documented as user-configurable risk.

### 4.4 Security Headers / CSP

- [`securityHeaders()`](src/middleware/security-headers.ts:1) sets HSTS, nosniff, frame protection and a CSP.

**Risk / hardening:**
- CSP currently allows `'unsafe-inline'` for scripts. This preserves compatibility but reduces XSS blast-radius. Moving to nonces/hashes would provide more meaningful protection.
- `X-XSS-Protection` is legacy and can be removed or left; it’s not harmful, but not relied upon.

### 4.5 Origin Validation

- [`validateOrigin()`](src/lib/security.ts:3) exists and restricts origins/referers to `config.s3Domain` or `localhost`, but it is not obviously applied as a global check.

## 5. Recommendations

### High Priority

1) **Remediate `hono` high severity vulnerability**
   - Run `npm audit fix` and confirm the locked version of `hono` is patched.
   - Ensure no JWT/JWK features are enabled with unsafe defaults.

### Medium Priority

1) **Address `esbuild` moderate vulnerability**
   - Prefer upgrading `drizzle-kit` / the esbuild chain; validate `drizzle-kit` breaking changes in CI.
   - If postponing, document a policy: do not expose dev servers to untrusted networks.

2) **Implement explicit CSRF protection for dashboard state-changing endpoints**
   - `SameSite=Lax` is helpful but not a full CSRF strategy. Add CSRF tokens (synchronizer token or double-submit).

3) **Harden rate limiting behind proxies**
   - Parse `x-forwarded-for` safely (take the left-most IP only when behind trusted proxy).
   - Consider using a trusted header from your edge (e.g. `CF-Connecting-IP`) and ignore untrusted forwarded headers.

### Low Priority

1) **Tighten CSP**
   - Reduce/avoid `'unsafe-inline'` for scripts; use nonces/hashes for inline blocks.

2) **Apply origin validation consistently**
   - Apply [`validateOrigin()`](src/lib/security.ts:3) (or a stricter equivalent) to the dashboard API surface if the threat model expects browser-only access.

## 6. Conclusion

The codebase remains in good shape overall. The main actionable items are dependency remediation (notably `hono`) and incremental hardening around CSRF, CSP, and proxy-aware rate limiting.
