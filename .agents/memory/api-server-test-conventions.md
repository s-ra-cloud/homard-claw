---
name: API server integration testing conventions
description: How lifecycle/integration tests for the office API are set up and the safety rules they must follow
---

The api-server uses vitest + supertest suites (e.g. src/routes/office.lifecycle.test.ts) that run against the real development Postgres. Rules for any new suite:

- Mock @clerk/express getAuth via vi.hoisted state; in beforeAll, impersonate the *existing* `owner_clerk_id` from system_state so requireOwner passes without mutating ownership.
- If no owner row exists, the suite may let its test identity claim it, but teardown must delete the row only where key AND value match the test identity — never unconditionally.
- **Why:** requireOwner claims first-seen identity as permanent owner; a careless test could lock out or delete the real owner.
- Tag all created records with a unique run tag (e.g. `HC Test <timestamp>`) in names/summaries, track created ids, and clean up agents/tasks/approvals plus audit events LIKE the tag in afterAll; end with pool.end().
- vitest.config.ts sets fileParallelism: false because suites share DB tables.
- Manual vite builds of the web app need PORT and BASE_PATH env vars (workflows provide them; shell builds must pass e.g. PORT=5000 BASE_PATH=/).
- The package-management install tool fails at the pnpm workspace root (ERR_PNPM_ADDING_TO_ROOT); install per-package with `pnpm --filter <pkg> add`.
