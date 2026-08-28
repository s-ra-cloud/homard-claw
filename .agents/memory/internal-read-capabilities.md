---
name: Internal read capabilities
description: Policy for agent-facing internal reads (office task-record search) that bypass the connected-app catalog.
---

# Internal read capabilities

Rule: internal, read-only agent capabilities reuse the existing `<app_action>` request channel for the model interface but are executed by their own server-side executor, bypassing the connected-app catalog — no grants, no approvals, no action rows.

**Why:** the catalog is a closed list of external operations with grant/approval/audit machinery; internal reads forced through it would either pollute the catalog or require fake grants. One request channel keeps one untrusted-data framing.

**How to apply:**
- Caller identity (workspace, sandbox flag) is always server-supplied and the executor re-checks it; forged or stale requests fail closed.
- Sandbox state must be read LIVE at execution time on every surface. Talk turns are the trap: the agent row loaded at request start can be minutes stale by the time a lookup runs, so re-query before executing (the worker already refreshes access mid-run).
- The sandbox promise cuts both ways: sandboxed callers get no office-wide reads, and results produced by a currently sandboxed agent are hidden from everyone.
- Foreign, missing, and ineligible records all read identically as "not found" — no cross-workspace existence leaks.
- Responses stay bounded and paginated; expose only owner-visible fields, never hidden prompts, credentials, or audit rows.
