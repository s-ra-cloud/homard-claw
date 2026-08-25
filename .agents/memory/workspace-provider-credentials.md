---
name: Workspace provider credentials
description: Per-workspace encrypted AI credentials — no env fallback, fail-closed rules, test seeding pattern
---

Claude, OpenRouter, and voice-OpenAI credentials are per-workspace rows (encrypted AES-256-GCM under a SESSION_SECRET-derived key with its own label), never server environment variables. Every execution path resolves the key from the durable workspace id of the task/agent — never from client input, and never from a shared operator key (none exists).

**Why:** a shared env key would let any workspace spend the operator's (or another tenant's) allowance. The isolation property is enforced structurally: `credentialFor(workspaceId, provider)` is the only way execution gets a key.

**How to apply:**
- Missing credential → fail closed with `not_configured` and a message naming the page where the user adds their own key. Undecryptable credential (rotated SESSION_SECRET, corrupt row) → "enter the key again", never a fallback.
- Readiness/dispatch only check existence; only execution decrypts. A corrupt row passes readiness and fails at use — deliberate, so the precise re-enter error surfaces.
- Health probes send decrypted workspace keys in request headers, so health/status payloads must use fixed failure classifications — never echo raw transport error messages, which can contain echoed headers.
- Integration tests must seed workspace credentials (not env stubs) and restore any rows they touch on the real dev owner workspace.
- Keep the two-workspace isolation test suite green when touching credential resolution.
- Codex/ChatGPT sessions have their own store and remain outside this table.
