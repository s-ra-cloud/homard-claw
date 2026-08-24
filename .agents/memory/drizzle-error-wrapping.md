---
name: Drizzle wraps driver errors
description: Postgres error codes live on the cause chain, not the thrown error — naive code checks silently miss them.
---

# Drizzle wraps driver errors

Drizzle ORM (0.45+) wraps failed queries in `DrizzleQueryError`; the raw pg
error — including `code` like `23505` (unique violation) — sits on
`error.cause`, possibly nested.

**Why:** A duplicate-name retry loop checked `error.code === "23505"`
directly, never matched the wrapped error, and surfaced 500s under
concurrent inserts. It passed in isolation and only failed under full-suite
timing, which made it look flaky.

**How to apply:** Any constraint-violation or SQLSTATE check against a
Drizzle query error must walk the `cause` chain (bounded depth). Grep for
raw `"23505"`-style comparisons when adding new ones.

Related: persisted error messages (tasks.errorMessage, logs, notifications)
must pass through the sanitizer in the API server's lib (redacts bearer
tokens, key shapes, credentialed URLs, literal secret env values) — provider
response bodies are never persisted at all, status codes only.
