---
name: Drizzle queries are lazy thenables
description: A built drizzle query never executes unless awaited or .then()'d — fire-and-forget with `void` silently does nothing.
---

Rule: `db.delete(...).where(...)` (and every other drizzle builder chain) is a lazy thenable. It only hits Postgres when awaited or when `.then()` is called. `void db.delete(...)...` discards the thenable without executing it — no error, no query.

**Why:** A Talk-lease test scheduled `void db.delete(...)` inside a `setTimeout` to free a lease mid-wait; the delete never ran and the test looked like a lease bug. Attaching `.then()` "fixed" it, revealing the laziness.

**How to apply:** For intentional fire-and-forget drizzle calls (timers, background cleanup), always attach `.then(() => {}, handleErr)` or wrap in an async IIFE with await. Never rely on `void query` to execute anything.
