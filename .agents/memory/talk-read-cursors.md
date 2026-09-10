---
name: Talk read cursors
description: Defines the stable ordering required when advancing per-agent Talk read state.
---

Talk read cursors must use the same total ordering as rendered Talk history: creation timestamp, user-before-agent author role, then message UUID.

**Why:** A stored user/agent exchange can share one timestamp. Comparing timestamp and random UUID alone can treat the user turn as later than its reply, regress a read cursor, or miscount the reply.

**How to apply:** Any unread query, cursor acknowledgement, or history pagination involving Talk messages must keep this ordering tuple in lockstep.