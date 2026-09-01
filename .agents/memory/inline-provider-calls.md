---
name: Inline provider calls from API routes
description: Convention for routes that need a synchronous model call (approval review, manual memory refresh) instead of dispatching a task
---

Some flows need a bounded, synchronous provider call from a request handler rather than a queued task (approval review and manual memory refresh are the exemplars). The durable rules:

- Codex never goes through the generic provider path. **Why:** it runs on the owner's ChatGPT allowance with its own lease/serialization rules. Inline codex turns must run under the strictest execution profile — forced sensitive-data sandbox, fresh conversation — and be ephemeral: destroy the conversation row and work folder on every exit path, or repeated clicks fill the disk (a known failure mode).
- A maintenance call must never inherit the agent's own relaxed permissions; force the strict profile explicitly, because live settings reloads inside the turn will otherwise overwrite what the caller passed.
- Demand a strict structured reply and reject the whole reply on any malformed or out-of-scope element — never partially apply a model-proposed change set. Apply accepted changes in one transaction under the relevant advisory lock with SQL-level tenancy guards as defense in depth.
- Map failures to HTTP deliberately: routing/config → 422, rate limit/allowance → 429, malformed or provider error → 502, transient/timeout/busy → 503, emergency stop/quota → 409. Check agent existence, retirement, and the emergency stop before spending any provider budget.
- CodexTalkError kinds are stable but its `message` is NOT sanitized — it can echo raw provider/CLI detail (paths, token fragments, upstream error text). Any surface returning it to a browser must map kind → fixed message, the way the Talk/voice routes and the memory refresh do. **Why:** the refresh once forwarded `error.message` verbatim and leaked `codex login` hints and raw provider text.

**How to apply:** when adding another synchronous review/maintenance flow, copy the branching, strict-profile, ephemerality, and failure-mapping conventions from an existing exemplar instead of inventing a new path or dispatching a hidden task.
