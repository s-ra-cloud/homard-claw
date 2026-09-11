---
name: API server integration testing conventions
description: How lifecycle/integration tests for the office API are set up and the safety rules they must follow
---

The api-server uses vitest + supertest suites (e.g. src/routes/office.lifecycle.test.ts) that run against the real development Postgres. Rules for any new suite:

- Mock Clerk auth and pre-create isolated workspaces for synthetic users before any authenticated request, including synthetic owners with matching verified emails.
- **Why:** a matching owner email with no existing workspace can adopt the legacy workspace; cleanup by synthetic user ID can then attempt to delete real data. Owner-only authorization is now verified-email based, not a first-seen owner claim.
- **How to apply:** seed both owner and non-owner workspace fixtures before requests, restore temporary owner-email configuration, and delete only those isolated fixtures.
- Tag all created records with a unique run tag (e.g. `HC Test <timestamp>`) in names/summaries, track created ids, and clean up agents/tasks/approvals in afterAll; end with pool.end().
- NEVER delete or durably mutate audit_events rows in tests: the audit log is hash-chained and append-only, so any edit/delete makes chain verification report tampering forever. Tamper probes must run inside a transaction that always rolls back; test audit rows just accumulate.
- Policy gating runs before every provider call, so tests exercising other mechanics must opt out of it (autonomous agents, generous limits, priced tasks) or their tasks park for approval instead of running.
- A metered task with no cost estimate and no budget **always** parks for owner approval, whatever the agent's autonomy. Any worker fixture must set an estimate or a budget, or it will assert against an approval it did not expect.
- vitest.config.ts sets fileParallelism: false because suites share DB tables.
- Manual vite builds of the web app need PORT and BASE_PATH env vars (workflows provide them; shell builds must pass e.g. PORT=5000 BASE_PATH=/).
- The package-management install tool fails at the pnpm workspace root (ERR_PNPM_ADDING_TO_ROOT); install per-package with `pnpm --filter <pkg> add`.

## Browser e2e against the web app

Fresh signed-in users have isolated workspaces; they do not see the existing office's data. Use an isolated, pre-created workspace for browser fixtures. Only administrative review surfaces require the configured owner's verified email.

**Why:** browser fixtures must not adopt or mutate the legacy workspace to gain access to test data.

Also give the tester a *conversable* agent: retired agents still exist in `agents` but are filtered out of Talk and other rosters, so picking one looks like a missing-contact bug.

## Testing the persistent task worker

The dev API server runs a live queue worker (advisory-lock singleton) against the same Postgres the tests use, so tests must never leave claimable `queued` rows or call unscoped claim functions — they would steal or mutate real work.

A test that hand-writes a row to simulate a state the real code would have reached must reproduce *everything* that transition clears, not just the fields it sets. Outcome paths tend to write only what they own, so any stale field the real path would have reset survives into the final row and quietly fools assertions.

**How to apply:** keep test agents paused (the worker skips paused agents), use the worker's test-only claim scope (`agentIds` + `includePausedAgents`) for ordering assertions, insert `running` rows directly to exercise execution paths, and cancel/block every row a test leaves behind. All provider traffic goes through a stubbed global fetch — never the network.

## Concurrent suite runs are not safe — now serialized by an advisory lock

All test files share the owner's workspace rows in the dev Postgres, so two
vitest invocations at once (manual + validation gate + the completion
reviewer's own verification run — the reviewer DOES run the suite in the same
workspace) interleave on provider-credential rows, queue recovery, and codex
leases, producing phantom 503s, duplicate-key restore failures, and stolen
tasks that never reproduce in a lone run.
A vitest globalSetup now holds a session-scoped advisory lock for the life of
each suite run, so concurrent runs queue instead of interleaving ("waiting for
another suite run" in the output). The live dev API server also shares the DB
and can still flake schedules/lifecycle/memory tests (~1 per run).
**How to apply:** trust the suite lock, keep it when touching vitest config;
a failure that passes in isolation is interference, not a regression. If a
run seems hung at startup, another suite run is holding the lock.

- The dev Postgres does not auto-sync with merged schema changes; push the schema before blaming tests for "missing relation" errors.


## Fake verified owners must have a workspace before their first request

Pre-create isolated workspaces for synthetic accounts whose verified email
matches OWNER_EMAIL. Clean up only workspace IDs returned by those inserts,
never rows discovered by the synthetic user ID after a request.
**Why:** first-request legacy adoption can transfer the real office to the
fake owner; deleting by that user ID then attempts to cascade-delete real data.
**How to apply:** owner-role route tests should seed their workspace before
HTTP setup, retain insert-returned IDs, and create terminal task fixtures
directly when the behavior under test does not require queue dispatch.
