---
name: Pinned compliance verdicts
description: Applicability and parsing rules for the isolated pinned-instruction compliance check.
---

Pinned instructions must be judged against the task objective and draft. Positive or conditional instructions do not apply when the task neither requests nor triggers their action.

**Why:** Without the objective, a checker can mistake an unrelated omitted action for a violation. Provider prose or malformed output can also fabricate a failure if every unknown response is interpreted as non-compliant.

**How to apply:** Give isolated compliance checks the objective, instructions, and draft as inert data. Only exact documented verdict forms are authoritative; treat all other output as inconclusive and do not withhold or retry the task.