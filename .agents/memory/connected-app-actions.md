---
name: Connected-app action security model
description: Invariants for agent access to owner accounts (Gmail/Drive/GitHub) via Replit connectors
---

Agents act on the owner's external accounts only through a closed, server-defined operation catalog. The rules that must survive any refactor:

- Models request actions only via explicit `<app_action>` JSON blocks; prose never triggers a call, and blocks are ALWAYS stripped from stored task output — even when the agent has no grants.
- **Why:** the parser/strip pair is the entire prompt-injection boundary; a surviving block in output can be replayed or mistaken for prose.
- Authorization is server-side and re-checked at every boundary: at request time AND again immediately before executing an owner-approved write (grants, workspace enable switch, and params re-validated). Approval is necessary, never sufficient — a revoke after approval wins.
- `validateParams` drops undeclared params and rejects control chars everywhere plus CR/LF outside body/content fields. This is the header-injection gate (e.g. Bcc smuggling into an approved email); any new string param that feeds a header, URL, or path must stay single-line.
- Writes execute via a guarded `approved → executing` UPDATE (at-most-once claim). Rows stranded in `executing` by a crash are settled as unknown-outcome and never silently retried — retry-on-ambiguity is how an email sends twice. True idempotency keys are still absent.
- Metered multi-round provider loops (action results fed back to the model) must re-check the budget ceiling BEFORE each dispatch and shrink `maxOutputTokens` to what the remainder funds; a post-hoc check alone lets a round overspend.
- Connector clients come fresh per operation via the platform SDK; credentials are never stored, returned, or logged.

**How to apply:** any new app, operation, or execution path goes through the catalog + authorize + durable action-row pipeline; never hand a model a raw connector path or accept an operation name it invented.
