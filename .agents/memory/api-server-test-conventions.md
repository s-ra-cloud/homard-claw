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
- A metered task with no cost estimate and no budget **always** parks for owner approval, whatever the agent's autonomy. Any worker fixture must set an estimate or a budget, or it will assert against an approval it did not expect.
- vitest.config.ts sets fileParallelism: false because suites share DB tables.
- Manual vite builds of the web app need PORT and BASE_PATH env vars (workflows provide them; shell builds must pass e.g. PORT=5000 BASE_PATH=/).
- The package-management install tool fails at the pnpm workspace root (ERR_PNPM_ADDING_TO_ROOT); install per-package with `pnpm --filter <pkg> add`.

## Browser e2e against the web app

The same owner gate applies to the UI: a Playwright/testing subagent that signs in as a freshly created Clerk user gets 403 on every `/api` call and sees an empty app. Read the current `owner_clerk_id` from `system_state` and tell the tester to impersonate exactly that Clerk identity (look its email up through the Clerk backend API with `CLERK_SECRET_KEY`).

**Why:** the owner gate is permanent and first-come; a test identity must never claim or replace it.

Also give the tester a *conversable* agent: retired agents still exist in `agents` but are filtered out of Talk and other rosters, so picking one looks like a missing-contact bug.

## Testing the persistent task worker

The dev API server runs a live queue worker (advisory-lock singleton) against the same Postgres the tests use, so tests must never leave claimable `queued` rows or call unscoped claim functions — they would steal or mutate real work.

A test that hand-writes a row to simulate a state the real code would have reached must reproduce *everything* that transition clears, not just the fields it sets. Outcome paths tend to write only what they own, so any stale field the real path would have reset survives into the final row and quietly fools assertions.

**How to apply:** keep test agents paused (the worker skips paused agents), use the worker's test-only claim scope (`agentIds` + `includePausedAgents`) for ordering assertions, insert `running` rows directly to exercise execution paths, and cancel/block every row a test leaves behind. All provider traffic goes through a stubbed global fetch — never the network.

## Concurrent suite runs are not safe

The API vitest suite runs files serially (`fileParallelism: false`) but all
files share the owner's workspace rows in the dev Postgres. Two vitest
invocations running at once (manual run + validation run + a reviewer's run)
race on provider-credential rows — one suite deletes `openai_voice`/`openrouter`
while another expects them seeded — producing phantom 503 failures.
The live dev API server also shares the DB: its worker/scheduler can fire
test schedules and create/read notifications, flaking the schedules,
lifecycle, and memory suites (~1 test per full run). A failure in those areas
that passes in isolation is interference, not a regression.
**How to apply:** run one suite at a time; verify suspected flakes by running
the file alone before debugging.
