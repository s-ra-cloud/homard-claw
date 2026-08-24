---
name: API server integration testing conventions
description: How lifecycle/integration tests for the office API are set up and the safety rules they must follow
---

The api-server uses vitest + supertest suites (e.g. src/routes/office.lifecycle.test.ts) that run against the real development Postgres. Rules for any new suite:

- Mock @clerk/express getAuth via vi.hoisted state; in beforeAll, impersonate the *existing* `owner_clerk_id` from system_state so requireOwner passes without mutating ownership.
- If no owner row exists, the suite may let its test identity claim it, but teardown must delete the row only where key AND value match the test identity — never unconditionally.
- **Why:** requireOwner claims first-seen identity as permanent owner; a careless test could lock out or delete the real owner.
- Tag all created records with a unique run tag (e.g. `HC Test <timestamp>`) in names/summaries, track created ids, and clean up agents/tasks/approvals in afterAll; end with pool.end().
- NEVER delete or durably mutate audit_events rows in tests: the audit log is hash-chained and append-only, so any edit/delete makes chain verification report tampering forever. Tamper probes must run inside a transaction that always rolls back; test audit rows just accumulate.
- Policy gating runs before every provider call, so tests exercising other mechanics must opt out of it (autonomous agents, generous limits, priced tasks) or their tasks park for approval instead of running.
- vitest.config.ts sets fileParallelism: false because suites share DB tables.
- Manual vite builds of the web app need PORT and BASE_PATH env vars (workflows provide them; shell builds must pass e.g. PORT=5000 BASE_PATH=/).
- The package-management install tool fails at the pnpm workspace root (ERR_PNPM_ADDING_TO_ROOT); install per-package with `pnpm --filter <pkg> add`.

## Testing the persistent task worker

The dev API server runs a live queue worker (advisory-lock singleton) against the same Postgres the tests use, so tests must never leave claimable `queued` rows or call unscoped claim functions — they would steal or mutate real work.

**How to apply:** keep test agents paused (the worker skips paused agents), use the worker's test-only claim scope (`agentIds` + `includePausedAgents`) for ordering assertions, insert `running` rows directly to exercise execution paths, and cancel/block every row a test leaves behind. All provider traffic goes through a stubbed global fetch — never the network.
