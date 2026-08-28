---
name: Claude Code setup-token auth contract
description: The exact Anthropic OAuth request shape long-lived `claude setup-token` credentials require, and the traps that produce misleading 401/400s.
---

# Claude Code setup-token authentication

**Rule:** All Anthropic requests using a `claude setup-token` credential must be built from the single shared contract module (one header builder + one system-block builder) — never hand-rolled headers.

**Why:** Anthropic only accepts these tokens when the request looks like the Claude Code CLI, and each deviation fails with a misleading error:
- `Authorization: Bearer` (never `x-api-key`), `anthropic-version: 2023-06-01`, and BOTH betas `claude-code-20250219,oauth-2025-04-20` — dropping either beta turns a valid token into HTTP 401.
- CLI identity headers matter: `user-agent: claude-cli/x.y.z (external, cli)` and `x-app: cli`; keep the version a current CLI release.
- OAuth tokens go to the BETA messages surface `/v1/messages?beta=true` (what the CLI itself uses). The plain path can refuse a Claude-Code-scoped credential; `GET /v1/models` returns 401 even with a perfect token. Health checks must probe with a real minimal message (Haiku, `max_tokens: 1`).
- For non-Haiku models the `system` array's ENTIRE first block must be exactly `You are Claude Code, Anthropic's official CLI for Claude.` — concatenating it with other text in the same block also fails (HTTP 400 `invalid_request_error` with message "Error").
- Token shapes: setup/access tokens start `sk-ant-oat…` (~108 chars), refresh tokens `sk-ant-ort…`, Console API keys `sk-ant-api…`. Shape-check before storing so the wrong secret gets remediation instead of a delayed 401.
- 429 arrives AFTER auth succeeds, so treat it as proof the token works, not as unhealthy.
- Not every 401 means "expired": Anthropic validates the token VALUE before the protocol, and the error body's message distinguishes causes. Verified live: `OAuth access token is invalid.` = bad/truncated token value (the CLI's printed token wraps across terminal lines, so truncated pastes are the top cause); `…expired/revoked…` = rotate; `OAuth authentication is currently not supported` / `only authorized for Claude Code` / header-validation complaints = the app's Claude Code emulation is stale — rotating cannot fix it. Classify by matching these signatures server-side into FIXED messages; never echo the body itself.
- A fake-but-well-formed token 401s identically under every protocol variation, so a live probe with a bad stored token cannot prove the contract right or wrong — only the body signature tells them apart.

**How to apply:** Any new Anthropic call path (health, execution, future chat features) imports the shared claude-oauth contract module. Never quote provider response bodies in user-facing errors — classify by status code only. Keep the literal `sk-` prefix out of user-facing message text; leak-detection tests grep status payloads for `/sk-/i`.
