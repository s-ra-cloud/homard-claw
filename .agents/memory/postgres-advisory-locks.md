---
name: Postgres advisory lock keyspace
description: Rule for choosing advisory lock keys and the current inventory of locks in use
---

Advisory locks share one keyspace. The queue worker's old session-scoped singleton lock (0x484f4d41 "HOMA") is GONE — worker singleton-ness now lives in the expiring `worker_ownership` row (see worker-queue-ownership.md). Remaining advisory locks are transaction-scoped: quota locks, the audit chain lock, and the Talk-history clear/insert lock (872005).

**Why:** a xact-scoped lock request that reuses a still-held session lock's key queues forever — symptoms are silent hangs/test timeouts, not errors. The worker lock's removal ends the "0x484f4d41 is held for the whole process lifetime" hazard, but the collision rule still applies among the remaining locks.

**How to apply:** before adding any `pg_advisory_xact_lock`, grep the codebase for existing advisory lock keys and pick an unused key. Take such locks as the last step of a transaction to keep hold windows small and avoid lock-ordering deadlocks. When a "delete all X" endpoint races concurrent inserts of X, pair a DB-ordered epoch counter (bumped in the delete's transaction) with a per-entity advisory lock spanning the epoch check + insert — never compare host-clock timestamps.
