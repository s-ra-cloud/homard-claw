---
name: Agent delegation and runtime seam
description: How lead-to-member delegation is authorized in HomardClaw, and the stance on OpenClaw as an execution runtime
---

## Delegation authority is structural, never request-supplied

An agent may hand work to another agent only when it **leads a team** and the
target is a **member of that same team**. Depth and sub-task caps come from the
lead's effective permissions. The client never states a team or a depth — the
server derives all of it from the parent task and the team graph.

**Why:** the owner-facing API is the only caller, so any limit expressed in the
request body would be trivially forgeable; team structure is the only thing the
owner actually curates.

**How to apply:** authorization, the sub-task quota count, and the child insert
must happen in **one transaction with the parent task row locked**. Evaluating
the limit before the transaction lets concurrent hand-offs each see spare
capacity and both insert, overshooting the cap. Also re-check inside that
transaction that the parent is still live work and the lead still works here —
a completed task must not act as a standing licence to queue more work.

## OpenClaw is a seam, not a dependency

OpenClaw is deliberately **not installed** (it needs Node ≥ 24.15, its own API
key, and a persistent process the autoscale deployment cannot host). It is
registered as a known-but-uninstalled runtime adapter that reports
`not_installed`, refuses work, and throws if executed.

**Why:** the owner asked for "native now, OpenClaw-ready" — the product must
never imply an external orchestrator is running when it is not.

**How to apply:** never let an unrecognized or unavailable runtime id fall back
to the native adapter — resolve strictly and block the task
(`runtime_unavailable`) instead. Blocking on an unavailable runtime must not
consume a retry attempt, since nothing was actually attempted.
