---
name: Published SPA route cache
description: Prevents previously visited office iframe routes from loading stale index HTML after a new static publish.
---

Office parchment iframe routes must use a fresh per-open cache token, and the static app shell must recover once when a cached document references a missing hashed asset.

**Why:** Static SPA deep links can be cached independently. After publishing replaces hashed bundles, an old route document can fail before React starts, producing a black iframe and no API request.

**How to apply:** Keep the recovery bounded to one retry and cache-bust office iframe navigations without changing the logical application route.