---
name: GitHub App installation auth
description: How GitHub access works now — installation-first with legacy OAuth fallback, in-memory token minting, retry-once, and setup-binding rules.
---

# GitHub App installation authentication

**Rule:** GitHub credential resolution is installation-first: when a workspace has a GitHub App installation row, it is authoritative — never silently fall back to a leftover OAuth token (different identity/authority). Workspaces without an installation keep using their stored OAuth token.

**Why:** Production OAuth tokens get revoked with no refresh path (the OAuth flow returns no refresh token), taking GitHub access down until the owner reconnects. Installation tokens are minted on demand from the deployment-level app key, so expiry is a refresh, not an outage.

**How to apply:**
- App identity lives in env config (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` — key accepts raw PEM, `\n`-escaped, or base64). Partially-set config is a loud error, not a silent absence. The GitHub App itself must have its Setup URL pointed at `/api/github/app/setup` with "Redirect on update" enabled, plus Contents/Pull requests/Issues RW and Metadata R permissions.
- Installation rows store identity + display metadata ONLY. Tokens are cached in memory until 5 min before expiry and never persisted or logged.
- Token mints are single-flight per workspace **keyed by installation row version** (installationId + updatedAt). Keying by workspace alone lets a caller that saw a new binding await a stale mint and receive the previous installation's token (real review finding). Cache lookups must also re-check the current row version.
- An installation-token 401 during an action is retried exactly once with a fresh mint (401 = refused before any work, so writes can't duplicate). OAuth 401s are never retried. A second 401 gets installation-specific wording — "reconnect" is wrong advice there.
- Installation tokens are NOT user tokens: `/user/*` endpoints fail; list repos via `/installation/repositories` (nested `repositories` array).
- Setup binding: single-use state bound to workspace + Clerk user; installation identity verified with GitHub under the app JWT (foreign apps 404); suspended installations are never persisted; a unique index prevents two workspaces claiming one installation; a stateless callback may only refresh the workspace's own already-bound installation.
- A lost setup callback may be repaired only after the legacy OAuth credential gets a provider 401, and only for a personal (`User`) installation whose immutable GitHub account id exactly matches the workspace's previously verified OAuth user id (login must agree too). Never auto-claim an organization installation. Insert conflict-do-nothing, resolve auth fresh, then retry the refused request once as the installation. **Why:** production can have the App installed at GitHub but no binding row if its setup redirect is lost; matching by display login or repo owner would be a cross-tenant credential flaw.
- App-installation discovery uses numbered `page` pagination (`per_page=100`); GitHub's `since` parameter is an ISO timestamp, not an installation-id cursor. Bound the scan and fail explicitly at the cap instead of returning a false "not found."
- Legacy OAuth reconnects must produce at most one token exchange per workspace burst. GitHub caps tokens at ten per user/app/scope and starts revoking existing tokens when reconnect loops overflow that pool. Serialize starts and callback claims with the workspace lock; one callback atomically claims its state and removes sibling states before any provider call. Block starts while the claim is live or the connection was just saved, bound provider calls with timeouts, and release the claim on every outcome.
- Health: verify as the app (installation exists / suspended). Only GitHub's own 404/suspension flips to reconnect_required; bad app credentials and outages stay "unavailable" (server problem, not the owner's).
- Disconnect must delete the legacy OAuth row too — otherwise "disconnected" quietly falls back to an old token.
