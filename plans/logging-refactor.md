# Request Logging Refactoring Plan

## Objective
Replace the current ad-hoc logging implementation in `src/core/s3/utils.ts` with a robust, middleware-based solution using `AsyncLocalStorage` for context tracking and dedicated services for logging and stats aggregation.

## Components

### 1. Request Context (`src/lib/context.ts`)
Use `AsyncLocalStorage` to store request-scoped data that can be accessed anywhere in the call stack without passing arguments.
- **Store:** `{ requestId: string, startTime: number, user?: User, bucket?: Bucket, mode?: 'authenticated' | 'public' }`

### 2. Log Service (`src/services/log-service.ts`)
Handles buffering and flushing of request logs to the database.
- **Methods:** `logRequest(response: Response)`, `flush()`
- **Logic:**
  - Extracts context from `AsyncLocalStorage`.
  - Calculates latency.
  - Buffers logs in memory.
  - Flushes to `request_logs` table periodically or when batch size is reached.

### 3. Stats Service (`src/services/stats-service.ts`)
Handles aggregation of usage statistics (ingress, egress, request counts).
- **Methods:** `recordUsage(ingress: number, egress: number)`
- **Logic:**
  - Updates `users` and `buckets` tables.
  - Uses atomic increments (SQL `+`).

### 4. Middleware Integration (`src/index.ts`)
Wrap the main `fetch` handler to:
1.  Initialize `AsyncLocalStorage` context.
2.  Generate a Request ID.
3.  Call `next()`.
4.  Intercept the response.
5.  Call `LogService.logRequest()`.
6.  Call `StatsService.recordUsage()`.

### 5. Context Population
- **S3 Requests:** Update `handleS3Request` to set `user` and `bucket` in the context after authentication.
- **Dashboard Requests:** Update `handleDashboardRequest` to set `user` in the context.

## Implementation Steps

1.  **Create Context:** `src/lib/context.ts`
2.  **Create Services:** `src/services/log-service.ts`, `src/services/stats-service.ts`
3.  **Refactor Entry Point:** Update `src/index.ts` to use the new middleware pattern.
4.  **Update Handlers:** Modify `src/core/s3/index.ts` and `src/web/dashboard/index.ts` to populate context.
5.  **Cleanup:** Remove `updateStats` and `logQueue` from `src/core/s3/utils.ts`.

## Benefits
- **Decoupling:** Logging logic is separated from business logic.
- **Consistency:** All requests (S3, API, Dashboard) are logged uniformly.
- **Performance:** Batched writes reduce database load.
- **Maintainability:** Centralized logic is easier to update and debug.
