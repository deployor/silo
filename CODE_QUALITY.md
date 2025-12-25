# Code Quality & Refactoring Report

## 🚨 Critical Issues (Insane Practices)

### 1. **God Functions & Mixed Responsibilities**
- **`src/core/s3/index.ts`**: The `handleS3Request` function is a massive "God Function". It handles:
    - URL parsing
    - Domain-based vs. Path-based routing
    - Authentication (Signature V4 & Presigned URLs)
    - Bucket resolution
    - User validation
    - Request dispatching
    - Error handling
- **`src/core/s3/get.ts`**: Handles **5 different things**:
    1. Get Object
    2. List Objects (v2)
    3. List Multipart Uploads
    4. Get CORS Configuration
    5. Get Location Constraint
- **`src/core/s3/put.ts`**: Handles:
    1. Put Object
    2. Put CORS Configuration
    3. Copy Object

### 2. **Manual XML Manipulation**
- **String Concatenation for XML**: In `get.ts`, XML is built using template literals and loops (e.g., `<CORSRule>...`). This is fragile, error-prone, and hard to read.
- **Inconsistent Parsing**: `put.ts` uses `fast-xml-parser` with verbose manual validation, while other parts might do it differently.

### 3. **Duplicate Logic**
- **CORS Handling**: Logic for parsing and validating CORS rules is duplicated or split weirdly between `put.ts` and `cors.ts`.
- **Path/Key Resolution**: Logic to extract keys and internal paths is scattered.
- **User ID Sanitization**: `user.id.replace(/[^a-zA-Z0-9-]/g, "_")` is repeated in multiple places.

### 4. **Global State in Modules**
- **`src/core/s3/utils.ts`**: Uses global variables `logQueue` and `flushTimer` for request logging.
    - **Risk**: In a serverless environment (like Cloudflare Workers or AWS Lambda), this state might be lost. In a long-running server, it makes testing difficult and hides dependencies.

### 5. **Hardcoded Values & "Magic Strings"**
- **Internal URLs**: `new URL("http://localhost/?...")` is used to construct internal requests to the S3 client.
- **Header Lists**: Lists of allowed headers and query parameters to strip are hardcoded in `utils.ts`.

## 🛡️ Security Concerns

1.  **Broad Error Catching**: `try { ... } catch (_e) { return S3Errors.InternalError().toResponse(); }` in `get.ts` swallows original errors, making debugging production issues a nightmare.
2.  **Input Validation**: While there is some validation, the manual XML parsing in `put.ts` relies on a lot of `any` casting and manual checks which could be bypassed or fail unexpectedly.

## 🛠️ Refactoring Plan

### Phase 1: Architecture & Organization
- [ ] **Extract Middleware**: Move Authentication and Bucket/User resolution out of `handleS3Request`.
- [ ] **Split Handlers**: Break `get.ts` and `put.ts` into specific handlers:
    - `handlers/object-get.ts`
    - `handlers/object-put.ts`
    - `handlers/bucket-list.ts`
    - `handlers/cors.ts` (Unified get/put)
- [ ] **Centralize Constants**: Move header lists, reserved names, and config constants to a dedicated config/constants file.

### Phase 2: Code Quality & DRY
- [ ] **Unified XML Helper**: Create a robust XML builder/parser wrapper to replace manual string concatenation.
- [ ] **Service Layer**: Create a `StorageService` or similar to encapsulate the logic for interacting with the underlying S3 client and DB, separating it from the HTTP layer.
- [ ] **Logger Class**: Refactor the logging utility into a proper class or singleton that can be properly initialized and potentially mocked for tests.

### Phase 3: Cleanup
- [ ] **Remove `any`**: strict type checking for CORS rules and other data structures.
- [ ] **Standardize Error Handling**: Use a middleware or wrapper to catch errors and convert them to S3 responses consistently.

## Immediate Action Items
1.  Refactor `src/core/s3/index.ts` to use a "Router" pattern or simple dispatch map.
2.  Extract CORS logic into a dedicated `CorsManager`.
3.  Fix the Global State in `utils.ts`.
