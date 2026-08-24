---
name: Postgres advisory lock keyspace
description: Rule for choosing advisory lock keys so nothing collides with the process-lifetime worker lease
---

Advisory locks share one keyspace. The API server's task worker holds a session-scoped advisory lock for its entire process lifetime (its singleton lease), so any transaction-scoped advisory lock that reuses the lease's key blocks forever while the server runs — symptoms are silent hangs/test timeouts, not errors.

**Why:** a xact-scoped lock request queues behind the session-scoped lease and never returns.

**How to apply:** before adding any `pg_advisory_xact_lock`, grep the codebase for existing advisory lock keys (worker lease, quota locks, audit chain lock) and pick an unused key. Take such locks as the last step of a transaction to keep hold windows small and avoid lock-ordering deadlocks.
