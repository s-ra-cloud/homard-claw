---
name: Claude Code setup-token auth contract
description: The exact Anthropic OAuth request shape long-lived `claude setup-token` credentials require, and the traps that produce misleading 401/400s.
---

# Claude Code setup-token authentication

**Rule:** All Anthropic requests using a `claude setup-token` credential must be built from the single shared contract module (one header builder + one system-block builder) — never hand-rolled headers.

**Why:** Anthropic only accepts these tokens when the request looks like the Claude Code CLI, and each deviation fails with a misleading error:
- `Authorization: Bearer` (never `x-api-key`), `anthropic-version: 2023-06-01`, and BOTH betas `oauth-2025-04-20,claude-code-20250219` — dropping either beta turns a valid token into HTTP 401.
- CLI identity headers matter: `user-agent: claude-cli/x.y.z (external, cli)` and `x-app: cli`.
- Only the `/v1/messages` family accepts OAuth tokens. `GET /v1/models` returns 401 even with a perfect token — this was the original "correct token, offline provider" bug. Health checks must probe with a real minimal message (Haiku, `max_tokens: 1`).
- For non-Haiku models the `system` array's ENTIRE first block must be exactly `You are Claude Code, Anthropic's official CLI for Claude.` — concatenating it with other text in the same block also fails (HTTP 400 `invalid_request_error` with message "Error").
- Token shapes: setup/access tokens start `sk-ant-oat…`, refresh tokens `sk-ant-ort…`, Console API keys `sk-ant-api…`. Shape-check before storing so the wrong secret gets remediation instead of a delayed 401.
- 429 arrives AFTER auth succeeds, so treat it as proof the token works, not as unhealthy.

**How to apply:** Any new Anthropic call path (health, execution, future chat features) imports the shared claude-oauth contract module. Never quote provider response bodies in user-facing errors — classify by status code only. Keep the literal `sk-` prefix out of user-facing message text; leak-detection tests grep status payloads for `/sk-/i`.
