---
name: Queue-worker ownership lease
description: How the task queue's singleton worker is elected, heartbeated, and fenced across takeovers
---

The queue worker is a cluster singleton via an expiring, heartbeated `worker_ownership` row, not a session advisory lock. The holder renews on a timer; any standby instance atomically takes over an expired row.

**Why:** an Autoscale instance can go idle/frozen without dropping its Postgres session, so a session lock wedged the queue until redeploy. A bounded lease self-heals.

**How to apply:**
- Expiry is an epoch boundary: the generation bumps on every takeover AND on re-acquiring an expired row even by the same holder, and renewals require an unexpired row. Never let an expired lease be extended — that reopens the "frozen holder revives its old generation" hole.
- Fencing is layered (keep all three when touching the worker loop): a rejected renewal aborts all local provider calls; claiming stops once the local copy of the expiry passes (works with the DB unreachable); and the per-attempt completion fence rejects stale results after the new owner requeues and reclaims work.
- The renewal heartbeat runs on its own timer — the tick loop can be busy for minutes inside one provider call, so never rely on ticks to renew.
- Clean shutdown deletes the row (instant handoff); a crash relies on TTL expiry (bounded handoff).
- Tests must NEVER touch the production ownership key — the live dev server's worker owns it. Use run-unique keys, and drive the worker's exported ownership hooks directly instead of starting the polling loop (which would claim real queued tasks).

## Recovery-pass fencing (manual + automatic)
- The orphan requeue (`running → queued`) must run inside `withOwnershipFence`: a transaction that row-locks the ownership row and re-verifies holder + generation + expiry. A takeover UPDATE blocks on that lock, so a slow pass can never requeue work a successor epoch already claimed. Unfenced global requeues are only for boot/tests.
- Manual "Recover queue" and the tick share one single-flight pass per epoch; the fence covers only the requeue — the paused-status normalization and own-lease release before it are idempotent/instance-local by design.
- The recovery endpoint must report requeue counts scoped to the caller's workspace; the pass is global (one worker serves all workspaces) but cross-tenant counts must never be disclosed.
- Tests never run the global requeue against the shared dev DB: inject a workspace-scoped impl via the recovery-impl test seam (it still exercises the real fence).

## Tick starvation via one bad query
- `workspace_settings.value` is text; comparing it to a uuid column in SQL needs `::text` or Postgres 42883 kills the ENTIRE worker tick — the queue silently starves while ownership/heartbeat still look healthy. If the queue is stuck but health says "active", check tick logs for a failing pre-drain step first.
