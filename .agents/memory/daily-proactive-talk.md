---
name: Daily proactive Talk
description: Durable rules for spontaneous agent-authored daily Talk check-ins.
---

Daily proactive Talk uses one retained occurrence per workspace and UTC day. The selected agent is persisted before generation, and the resulting Talk message links directly to that occurrence as exact crash-recovery evidence.

**Why:** deleting occurrence rows allows duplicate sends on the next worker tick, broad timestamp-based evidence can mistake unrelated chat for a completed send, and replaying an uncertain provider failure can duplicate output or spend allowance twice.

**How to apply:** keep the workspace/day uniqueness row after completion; never use unrelated messages as evidence; exclude paused, retired, archived, and on-leave agents; abort in-flight generation on emergency stop; keep provider calls shorter than the claim timeout; and retry only when provider metadata proves the turn never started.