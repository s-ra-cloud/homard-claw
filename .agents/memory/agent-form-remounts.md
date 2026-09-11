---
name: Agent form remounts
description: Browser-only dropdown clearing and stale cache hazards when reopening configuration forms.
---

Test configuration persistence through SPA save → roster → edit with a delayed detail GET, not only initial loading or a hard reload.

**Why:** Initial hydration tests passed even in WebKit, but SPA reopening reproduced blank provider and permission dropdowns despite correct saved data. Ignoring empty-string Radix change events resolved the reproduced failure. These pickers use explicit sentinel choices for clearing, so an empty event is not a legitimate selection.

**How to apply:** Keep explicit no-access/default choices. Patch caches from mutation responses, accept fresh detail while pristine, and preserve dirty drafts during refetch. One-time hydration from cached data can permanently hide the fresher response. Browser fixtures must capture mutation payloads and reopen through the actual roster link.