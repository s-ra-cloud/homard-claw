---
name: Per-user Google OAuth credentials
description: Design rules for the in-app Gmail OAuth flow and encrypted credential store.
---

# Per-user Google OAuth (Gmail)

Rules:
- Gmail never uses the Replit connector: `gmailJson` in connected-apps/connections.ts resolves a fresh access token per operation from the task's workspace via `gmailAccessToken(workspaceId)` (src/google/credentials.ts), so disconnect blocks the very next op — including already-approved writes and crash-recovery verification (same mailbox that executed).
- Refresh tokens are AES-256-GCM encrypted (`v1.<iv>.<tag>.<ct>`, key = sha256 of SESSION_SECRET-derived string) and never returned/logged; status APIs expose only email/scopes metadata.
- Rotation is revision-fenced: token refresh updates `googleAccountsTable` `where revision = loaded`, so a concurrent reconnect (new revision) can never be overwritten by a stale rotation.
- OAuth flow: auth-code + PKCE; single-use state row consumed by guarded UPDATE (`usedAt is null`), bound to Clerk user + workspace, 10-min TTL; nonce/aud checked on the ID token from the direct TLS exchange; `prompt=consent&access_type=offline` guarantees a refresh token on reconnect.
- Drive/GitHub still ride the Replit connector but only for the legacy workspace (`requireLegacyWorkspace` guard on executors AND verifiers); everyone else sees not_connected.
- Config: GOOGLE_OAUTH_CLIENT_ID/SECRET env; redirect URI derived from x-forwarded host as `https://<host>/api/google/oauth/callback`, overridable via GOOGLE_OAUTH_REDIRECT_URI.

**Why:** credentials must bind to the durable task owner, not the browser session or an ambient workspace connector; fail closed on revocation/under-scoping.

**How to apply:** tests stub fetch for oauth2.googleapis.com/token + gmail.googleapis.com, insert a googleAccountsTable row with `encryptRefreshToken(...)`, stubEnv the client id/secret, and call `clearGoogleTokenCache()` in beforeEach (see src/connected-apps/actions.recovery.test.ts and src/google/oauth.test.ts).
