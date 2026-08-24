---
name: Durable schedule firing
description: How scheduled work fires exactly once across crashes, and how the scheduler coexists with the live dev worker and owner edits
---

Schedule firing is two-phase: claim (stamp `claimedAt` under a row lock, leave the due `nextRunAt` untouched) → dispatch outside the lock → finalize (advance `nextRunAt` strictly past the claim time, clear the claim, re-reading the row under a lock so a mid-dispatch owner edit wins).

**Why:** advancing `nextRunAt` before dispatch silently loses the occurrence if the process crashes in between; advancing after dispatch without a claim double-fires on retry. A stale claim is recovered by evidence — if a task row linked to the schedule exists after the claim time, only finalize; otherwise refire. Never both.

**How to apply:**
- Any new "launch something on a timer" feature must follow the same claim/evidence/finalize shape; do not add a second ad-hoc scheduler.
- Owner edits (PATCH) do their read-modify-write inside a transaction with `FOR UPDATE` on the schedule row so they serialize with claim/finalize and cannot resurrect an already-fired `nextRunAt`.
- Catch-up is single-shot by construction: next occurrence is computed strictly after "now", never one task per missed slot.
- Paused agents defer their schedules (occurrence stays due, catches up once on resume). This is also what keeps the live dev worker's scheduler off test schedules: tests pause their agents and call the scheduler with a test-only scope (`scheduleIds` + `includePausedAgents`), mirroring the worker's `agentIds` claim scope.
- Tasks blocked at dispatch time never reach the worker's transition hooks — their notifications/publishes must be emitted from the dispatch path itself. Route-driven transitions (cancel, retry, approval decisions, emergency stop) must publish invalidation events too, or SSE clients go stale.
