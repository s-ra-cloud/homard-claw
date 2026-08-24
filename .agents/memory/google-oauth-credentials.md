---
name: Per-user OAuth credentials (Google + GitHub)
description: Design rules for the in-app Gmail/Drive Google OAuth flow, the GitHub OAuth-app flow, and their encrypted credential stores.
---

# Per-user OAuth (Gmail, Drive, GitHub)

Rules:
- No connected app uses the Replit connector anymore. `gmailJson`/`driveJson`/`githubJson` in connected-apps/connections.ts resolve a fresh token per operation from the task's workspace, so disconnect blocks the very next op — including already-approved writes and crash-recovery verification.
- Gmail and Drive share ONE Google account row per workspace. Drive is an incremental consent: `/google/oauth/start` takes `{ service: "gmail" | "google_drive" }`, the state row records the service, the callback validates only that service's scopes, and `saveGoogleAccount` unions scopes when the same googleSub reconnects (a different account overwrites). Disconnecting Google ends Gmail AND Drive — UI copy says so.
- Drive scopes are `drive.readonly` + `drive.file` (never full drive write). `driveAccessToken` fails closed with not_connected when all Drive scopes are absent, reconnect_required when only some are.
- GitHub is a separate OAuth-app flow (no PKCE — OAuth apps don't support it; single-use state row bound to Clerk user + workspace is the CSRF defense), scope `repo`, token exchanged at github.com/login/oauth/access_token then identity verified via GET /user before storing. Tokens don't expire on a schedule, so only the encrypted access token is stored (github_accounts); decrypted per call, never cached.
- Refresh tokens (Google) and access tokens (GitHub) are AES-256-GCM encrypted (`v1.<iv>.<tag>.<ct>`), keys = sha256 of distinct SESSION_SECRET-derived labels (`github-credential:` vs Google's) — deliberately duplicated crypto, never shared helpers.
- Google rotation is revision-fenced: token refresh updates `googleAccountsTable` `where revision = loaded`, so a concurrent reconnect can never be overwritten by a stale rotation.
- Google flow: auth-code + PKCE; single-use state row consumed by guarded UPDATE (`usedAt is null`), 10-min TTL; nonce/aud checked on the ID token; `prompt=consent&access_type=offline` guarantees a refresh token; `include_granted_scopes=true` keeps prior grants on incremental consent.
- Config: GOOGLE_OAUTH_CLIENT_ID/SECRET and GITHUB_OAUTH_CLIENT_ID/SECRET env; redirect URIs derived from x-forwarded host as `https://<host>/api/{google,github}/oauth/callback`, overridable via *_OAUTH_REDIRECT_URI. Missing config = 503 at start, graceful degradation.
- Callback redirect params on /connected-apps are `?gmail=`, `?google_drive=`, `?github=` (connected | error:<reason>).

**Why:** credentials must bind to the durable task owner, not the browser session or an ambient workspace connector; fail closed on revocation/under-scoping.

**How to apply:** tests stub global fetch for oauth2.googleapis.com/token + gmail.googleapis.com + www.googleapis.com + api.github.com, insert googleAccountsTable/githubAccountsTable rows with `encryptRefreshToken(...)`/`encryptGithubToken(...)`, stubEnv the client ids/secrets, and call `clearGoogleTokenCache()` in beforeEach (see src/connected-apps/actions.recovery.test.ts and src/google/oauth.test.ts).
