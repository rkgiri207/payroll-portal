---
name: OpenAPI Zod naming collision
description: Orval generates Zod schemas named {operationId}Body for request bodies AND {componentName} for components; collisions cause TS2308 ambiguity errors
---

# OpenAPI Zod Naming Collision Rule

## The Rule
Component schema names in `lib/api-spec/openapi.yaml` must NOT match the body schema name Orval auto-generates for any operation.

**Why:** Orval generates two separate exports:
1. `{ComponentName}` — from `components/schemas`  
2. `{operationId}Body` — from the operation's requestBody

When these are the same name, `lib/api-zod/src/index.ts` re-exports both from different generated files, causing `error TS2308: Module has already exported a member named X`.

## How to Apply
- Orval body schema name = `{camelCase(operationId)}Body` (e.g., operationId `requestUploadUrl` → `RequestUploadUrlBody`)
- If you need a component schema for the same shape, give it a different name (e.g., `UploadUrlRequest` instead of `RequestUploadUrlBody`)
- In route files, import the OPERATION-level Zod schema (e.g., `RequestUploadUrlBody`) not the component schema type (`UploadUrlRequest`) when you need a `.parse()` / `.safeParse()` call — the component schema in api-zod is a TypeScript type only when Orval inlines it

## Known Renamed Schemas
- `RequestUploadUrlBody` → `UploadUrlRequest` (component)
- `RequestUploadUrlResponse` → `UploadUrlResponse` (component)
(route files import `RequestUploadUrlBody` / `RequestUploadUrlResponse` which are the operation-level Zod instances)
