---
name: GitHub connection health & failure classes
description: Conventions for verifying the per-workspace GitHub credential and classifying GitHub refusals — when to say reconnect vs. retry vs. restore repo access.
---

# GitHub connection health & failure classification

**Rule:** A stored GitHub credential row is never proof of a working connection. Status pages verify it live (GET /user, bounded timeout, ~60s cache keyed to the row's updatedAt so a reconnect invalidates instantly). Classification is conservative and evidence-based:

- Only provider evidence marks a credential broken: HTTP 401 (revoked/reset), live `X-OAuth-Scopes` missing `repo`, or an undecryptable row (SESSION_SECRET changed → tell the owner to reconnect once, never to recreate the OAuth app).
- Network failure / timeout / GitHub 5xx → "unavailable" (short cache TTL), never flips a stored credential to broken.
- An authenticated rate-limit 403/429 (`x-ratelimit-remaining: 0` or `retry-after`) proves the token WORKS → report connected/retry-later, never "reconnect".
- A plain 403 is repository/organization authorization — reconnecting will not fix it; say so explicitly.
- 404 from GitHub can mean "no access" (GitHub hides private resources), not just "does not exist".

**Why:** GitHub collapses very different problems into 401/403; a generic "expired — reconnect" message repeatedly sent the owner to recreate the OAuth app for problems reconnecting (or waiting) would have fixed, and hid SESSION_SECRET rotation as the real cause of "lost" connections after deploys.

**How to apply:** All GitHub refusal mapping lives in the pure classifier module in `src/github/` (classify + describe); the shared transport takes a provider-specific `mapFailure` hook. Logs are secret-free: workspace/action ids, status, failure class, sanitized `X-GitHub-Request-Id` — never tokens, request paths (repo names), or response bodies. A startup diagnostic proves every stored credential decrypts with the current SESSION_SECRET and logs `encryption_key_mismatch` per workspace otherwise. Any new provider integration should follow the same pattern rather than reusing the generic proxy-failure mapping.
