---
name: Connected-app action security model
description: Invariants for agent access to owner accounts (Gmail/Drive/GitHub) via Replit connectors
---

Agents act on the owner's external accounts only through a closed, server-defined operation catalog. The rules that must survive any refactor:

- Models request actions only via explicit `<app_action>` JSON blocks; prose never triggers a call, and blocks are ALWAYS stripped from stored task output — even when the agent has no grants.
- **Why:** the parser/strip pair is the entire prompt-injection boundary; a surviving block in output can be replayed or mistaken for prose.
- Authorization is server-side and re-checked at every boundary: at request time AND again immediately before executing an owner-approved write (grants, workspace enable switch, and params re-validated). Approval is necessary, never sufficient — a revoke after approval wins.
- `validateParams` drops undeclared params and rejects control chars everywhere plus CR/LF outside body/content fields. This is the header-injection gate (e.g. Bcc smuggling into an approved email); any new string param that feeds a header, URL, or path must stay single-line.
- Writes execute via a guarded `approved → executing` UPDATE (at-most-once claim). Every write embeds an idempotency marker derived from the action row id (Gmail custom Message-ID searchable via rfc822msgid:, GitHub hidden HTML-comment in bodies, Drive appProperties). Rows stranded in `executing` by a crash are VERIFIED against the provider before settling: provably-landed → executed, provably-absent + approved → requeued for ONE retry (durable `recovery_requeued_at` fence; same marker), inconclusive → unknown-outcome and never retried. Gmail/Drive indexes are eventually consistent — absence only counts as proof once the attempt is minutes old; GitHub REST lists are read-after-write safe. Drive's two-step create is completed (idempotent media PATCH) when recovery finds the file empty. Never retry on ambiguity — that is how an email sends twice.
- Metered multi-round provider loops (action results fed back to the model) must re-check the budget ceiling BEFORE each dispatch and shrink `maxOutputTokens` to what the remainder funds; a post-hoc check alone lets a round overspend.
- Connector clients come fresh per operation via the platform SDK; credentials are never stored, returned, or logged.
- Exhausting the bounded action rounds with well-formed requests remaining must NOT complete the task: it parks `waiting_approval` with a durable approval of kind `task_continuation`. Each owner-approved segment re-runs the full pipeline (fresh grants/sandbox, per-write approvals) against only the REMAINING budget — prior `actualCostCents` is subtracted from task-level ceilings at preflight, failing closed when unmeasured — and the usage ledger stays cumulative via a baseline read from the task row when `continuationSegments > 0`. Malformed-only final rounds keep the honest failure path; rejection cancels with `continuation_rejected` and preserved output.
- Malformed `<app_action>` blocks are never guessed at: the precise parse error goes back to the model for bounded corrective rounds, and a run in which EVERY request stayed malformed (and no prior action ever settled) must end as a failed task — the model's prose alone can never turn "nothing ran" into a success.

**How to apply:** any new app, operation, or execution path goes through the catalog + authorize + durable action-row pipeline; never hand a model a raw connector path or accept an operation name it invented.
