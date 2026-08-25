# Capability Packages: Authoring & Operations

Capability packages are HomardClaw's extensibility layer: signed, versioned,
**data-only** manifests that combine reusable skill instructions with tool
declarations. Shipping a new agent capability means adding a manifest to the
vetted registry — not adding a bespoke operation, executor, or catalog edit
to the application.

## Where things live

| Piece | Location |
| --- | --- |
| Manifest contract & signing | `artifacts/api-server/src/capabilities/manifest.ts` |
| Vetted registry (the only trust source) | `artifacts/api-server/src/capabilities/registry.ts` |
| Workspace resolution / install lifecycle | `artifacts/api-server/src/capabilities/service.ts` |
| MCP HTTPS client | `artifacts/api-server/src/capabilities/mcp.ts` |
| Execution bridge | `artifacts/api-server/src/capabilities/execute.ts` |
| Skill prompt assembly | `artifacts/api-server/src/capabilities/skills.ts` |
| Install rows (per workspace) | `capability_packages` table (`lib/db/src/schema/office.ts`) |
| Owner UI | Connected Apps page → Capabilities section |

## The manifest contract

A `CapabilityManifest` declares, before anything can be enabled:

- **Identity**: `id`, `displayName`, `version`, `publisher`, `description`.
- **Connection**: `gmail` / `google_drive` / `github` (OAuth built-ins),
  `mcp` (remote server), or `none`.
- **Tools** (`CapabilityToolDef`): stable namespaced name
  (`<packageId>.<tool>` — tools outside the package's namespace are ignored,
  so a package can never shadow another package's operation), description,
  **risk level** (`read` < `draft` < `write`; write always requires durable
  owner approval), param schema (`kind`, `required`, `maxLength`,
  `multiline`), human target template, **recovery class** (below),
  `resultCharLimit`, `timeoutMs`, and executor (`builtin` or
  `mcp` + `remoteName`).
- **Skills** (`CapabilitySkillDef`): trigger keywords plus instructions.
  Skills are guidance only — they are injected under a header stating they
  can never change permissions, approvals, or the sandbox, and only when a
  trigger matches the task objective, within a 4000-char budget.

### Recovery classes

Every external-effect tool must be classified:

- `retry_safe` — idempotent; after a crash mid-execution it may be re-run
  once under the SAME action id (approval-backed) or settled as
  provably-not-executed.
- `provider_verifiable` — the provider can be asked whether the write landed
  (built-in writes embed an action-id idempotency marker).
- `non_retryable` — an ambiguous interruption always settles as **unknown**;
  it is never replayed.

## Trust model

- Only manifests compiled into `registry.ts` are trusted. No fetching
  manifests from URLs, no unsigned manifests, no package code, no local
  child-process MCP servers — ever.
- Signature = SHA-256 over a registry context string plus the manifest's
  canonical fingerprint (sorted-keys JSON). Signatures are verified on every
  registry lookup; a mutated entry fails closed.
- Installs pin `version + fingerprint + full manifest snapshot` per
  workspace, and each install row carries a server-keyed HMAC (under
  `SESSION_SECRET`) binding workspace + package + version + fingerprint.
  A database actor cannot forge it: a tampered, copied, or version-swapped
  row fails signature verification on resolve and is quarantined. The
  worker resolves tools ONLY from a verified pinned snapshot.
- MCP endpoints/tokens come from server env vars referenced **by name** in
  the manifest (e.g. `WEB_RESEARCH_MCP_URL`, `WEB_RESEARCH_MCP_TOKEN`).
  HTTPS is enforced. Credentials never appear in manifests, prompts, DB
  rows, or error messages.

## Update lifecycle

On every catalog listing the install row is reconciled against the registry:

- **Same version, same fingerprint** → active, nothing to do.
- **Newer version, no permission expansion** (wording tweaks, tool
  removals, stricter recovery) → auto-applied and audited.
- **Permission-expanding update** (new tools, level escalations, loosened
  schemas, a recovery class claiming MORE retry safety, connection change)
  → parked in `update_review` with a stored diff. The pinned version keeps
  serving; the new tools stay invisible until the owner accepts the diff in
  the UI. Acceptance is rejected if the registry moved again since review.
- **Drift** (snapshot no longer matches its fingerprint, registry removed
  the package, or the registry's content changed for the same version) →
  `quarantined` with a reason. Quarantined packages serve nothing.

## Request → execution pipeline

Agents request tools with the same provider-portable `<app_action>` blocks
used by the built-in apps (works identically on Claude Code, OpenRouter,
and Codex — no provider function-calling). Every request passes:

1. Pinned-schema param validation (`validateParams`).
2. Grant check (per-agent, per-package, level ranked read/draft/write).
3. Sensitive-data sandbox cap — sandboxed agents are read-only AND denied
   every network-backed (MCP) tool outright, even at read level: a web-search
   query is an exfiltration channel for confidential content the agent has
   already read. Such tools are also hidden from the sandboxed prompt.
4. Workspace enablement + install status (`active`/pinned only).
5. Write-level → durable owner approval, audit, at-most-once claiming.
6. Execution through the vetted built-in executor or the bounded MCP client
   (timeout, char limit, control-char stripping, sanitized failures).
7. Results are UNTRUSTED external data — bounded, framed as such in the
   model prompt (the server vouches only that the action ran, never for the
   content), and remote MCP error text is logged server-side but never
   forwarded to the model or UI; nothing in a result, error, or skill can
   widen access.

## Authoring checklist for a new package

1. Write the manifest in `registry.ts` (data only). Namespace every tool
   `<packageId>.`.
2. Classify every tool's level and recovery class honestly; when unsure use
   `write` + `non_retryable` (most conservative).
3. For MCP packages: add `mcpServer.urlEnv` (+ `authTokenEnv`), then
   provision the env vars on the deployment. Unconfigured endpoints fail
   with a clear message; they never fall back to HTTP.
4. Add skills with tight trigger keywords — they are selected per objective.
5. Bump `version` on every change. Never mutate a published version's
   content: same-version content changes quarantine existing installs.
6. Cover it in `src/capabilities/capabilities.test.ts` (install, grant,
   authorize, execute, drift).

## Troubleshooting

| Symptom | Meaning | Recovery |
| --- | --- | --- |
| Package shows **Quarantined** | Pinned snapshot or registry drifted | Fix the registry (restore or bump version); the next listing re-assesses |
| **Update Needs Review** | New version expands permissions | Owner reviews the diff and accepts (or leaves the pinned version serving) |
| **Unavailable** health | MCP server unreachable or no longer advertises a pinned tool | Check the endpoint env var, server health, or ship a corrected package version |
| **Not Connected** | Endpoint env var unset / OAuth account missing | Configure the env var or connect the account |
| Tool denied at runtime | Grant, enablement, sandbox, or install state changed since the prompt | Working as intended — re-authorization is immediate-pre-execution |
| Interrupted write shows "unknown" | Non-verifiable tool crashed mid-call | Intentional: verify manually with the provider; it is never replayed |
