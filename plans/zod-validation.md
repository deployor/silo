# Zod Input Validation Implementation Plan

## Objective
Replace manual type checking and validation in API endpoints with `zod` schemas to ensure type safety and robust input validation.

## Components

### 1. Validation Schemas (`src/lib/validation.ts`)
Create a new file to export reusable Zod schemas.

**Schemas:**
- **Bucket Name:** Regex validation for lowercase, numbers, and hyphens.
- **Create Bucket:** `{ name: bucketNameSchema }`
- **Update Visibility:** `{ isPublic: boolean }`
- **CORS Rule:**
  ```typescript
  z.object({
    AllowedOrigins: z.array(z.string()),
    AllowedMethods: z.array(z.string()),
    AllowedHeaders: z.array(z.string()).optional(),
    ExposeHeaders: z.array(z.string()).optional(),
    MaxAgeSeconds: z.number().optional(),
    ID: z.string().optional()0
  })
  ```
- **Update CORS:** `{ rules: z.array(corsRuleSchema) }`

### 2. API Refactoring

#### `src/web/dashboard/api/buckets.ts`
- **POST (Create):** Validate body against `createBucketSchema`.
- **PATCH (Update):** Validate body against `updateBucketVisibilitySchema`.

#### `src/web/dashboard/api/cors.ts`
- **PUT (Update):** Validate body against `updateCorsSchema`.

#### `src/web/dashboard/api/keys.ts`
- No body validation needed for current endpoints (POST is empty body, DELETE is URL param).

## Implementation Steps

1.  **Create File:** `src/lib/validation.ts`
2.  **Define Schemas:** Implement the schemas listed above.
3.  **Refactor Buckets API:** Update `handleBuckets` and `handleBucketOperations`.
4.  **Refactor CORS API:** Update `handleCors`.

## Example Usage
```typescript
import { createBucketSchema } from "../../../lib/validation";

// ... inside handler
const body = await req.json();
const result = createBucketSchema.safeParse(body);

if (!result.success) {
  return errorResponse(result.error.issues[0].message, 400);
}

const { name } = result.data;
// ... proceed
```
