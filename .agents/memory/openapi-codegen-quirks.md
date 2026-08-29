---
name: OpenAPI codegen quirks
description: Constraints the OpenAPI spec must respect for Orval codegen to compile in this repo.
---

- Rule: In lib/api-spec/openapi.yaml, always use `type: number` — never `type: integer` — and for nullable enums use `type: ["string", "null"]` with `null` included in the enum list.
- **Why:** Orval generates `zod.int()` for `integer`, which does not exist in this repo's Zod v3, breaking `pnpm --filter @workspace/api-spec run codegen`. Nullable enums only generate `.nullable()`/`zod.literal(null)` correctly with the union-type form.
- **How to apply:** Any time the API contract is edited, check new numeric fields and nullable enums against these forms before running codegen; the failure appears as a typecheck error inside generated files, not in the spec.
- Rule: Never name a request-body component schema `<OperationId>Body` (e.g. `CreateCustomApiBody` for operationId `createCustomApi`) — Orval auto-generates an alias with exactly that name and the duplicate identifier breaks the generated client.
- **Why:** Orval emits its own `<OperationId>Body` type alias for every request body; a component schema with the same name collides in the generated TypeScript.
- **How to apply:** Name request-body schemas after the resource intent (`CustomApiCreate`, `CustomApiUpdate`), not after the operation with a `Body` suffix.
