# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run test` — API integration tests (uses the dev Postgres)
- Required env: `DATABASE_URL` — Postgres connection string

### Codex via ChatGPT Plus (optional third provider)

Codex is off unless every variable below is set. Sign-ins are **per
account**: each signed-in user connects their own ChatGPT session (encrypted
in Postgres, keyed by their Clerk id), and every run — queued tasks, retries,
recovery, Talk — executes as the account that owns the task's workspace,
resolved server-side. There is no fallback identity: work whose owner cannot
be resolved is refused rather than billed to someone else.

| Variable | Required | Purpose |
| --- | --- | --- |
| `CODEX_ENABLED` | yes | Server-side feature flag. Unset ⇒ Codex is hidden in the UI and refuses to run. |
| `CODEX_HOME` | yes | Absolute path to a **private** root; each account gets its own hashed subdirectory holding a temporary working copy of `auth.json` during runs (created 0700, file 0600). The credential itself lives encrypted in Postgres. Refused outright under `/tmp`, `/var/tmp`, `/dev/shm`, `/run`, or the OS temp dir. |
| `CODEX_HOME_IS_PERSISTENT` | yes | Your attestation that `CODEX_HOME` is on a volume that survives a redeploy. Nothing inside the container can tell a Reserved VM disk from an instance disk, so Codex refuses to guess and stays off until this is set. |
| `CODEX_WORKSPACE_ROOT` | yes | Absolute path under which each agent/conversation gets its own isolated working directory. |
| `CODEX_AUTH_JSON` | optional | Contents of an existing `auth.json`, used **once** to seed the **office owner's** account when it has no sign-in stored. It is never applied to any other account and never overwrites a stored sign-in. |
| `CODEX_MODELS` | no | `id:name:context,…` override of the model catalog. |
| `CODEX_DEFAULT_MODEL` | no | Defaults to `gpt-5.6-terra`. |
| `CODEX_REASONING_LEVELS` | no | Subset of `low,medium,high`. |
| `CODEX_DEFAULT_REASONING` | no | Defaults to `medium`. |
| `CODEX_AUTH_MAX_AGE_DAYS` | no | Age past which a session is treated as expired. |
| `CODEX_HEALTH_CHECK_MINUTES` | no | Throttle for the local credential health check. |
| `CODEX_LEASE_TTL_SECONDS` | no | How long one Codex run may hold the credential lease. |
| `CODEX_ALLOW_NETWORK` | no | Allows network/web search **only** for `operator` + `autonomous` agents. |

**Deployment target must be a Reserved VM.** `.replit` currently declares
`deploymentTarget = "autoscale"`, whose filesystem is not durable. Codex
rewrites `auth.json` on every token refresh, so on Autoscale the refreshed
credential is lost on the next deploy and the session dies. Switch the
deployment to a Reserved VM with persistent storage, point `CODEX_HOME` at it,
and set `CODEX_HOME_IS_PERSISTENT=1` before enabling the flag. Setting that
flag on a deployment whose disk is *not* persistent will lose the session at
the next deploy — it is an attestation, not a fix. Without durable writable
storage the provider fails closed and says so.

**Manual login (one time, not automatable).** There is no supported
programmatic ChatGPT sign-in, and HomardClaw deliberately implements none.

1. On a machine with a browser: `npx @openai/codex login` (or `codex login`).
2. Copy the resulting `~/.codex/auth.json`.
3. Paste its contents into Providers → Codex → **Connect** while signed in
   as the account that should own it (it is stored encrypted against that
   account). The office owner may instead set `CODEX_AUTH_JSON` and press
   **Bootstrap** — the seed only ever lands on the owner's own account.
4. Confirm with Providers → Codex → **Test connection**. That check is
   entirely local — it reads the stored sign-in's metadata and resolves the
   SDK/CLI, and never calls OpenAI, so it cannot spend allowance.

Re-run steps 1–3 whenever the status reports authentication expired. Only
Codex's own SDK refresh path may rewrite `auth.json`; HomardClaw never does.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

- **Providers go through one adapter contract** (`artifacts/api-server/src/execution.ts`). Claude Code, Codex, and OpenRouter each implement start/continue/cancel, streaming progress, usage, and sanitized errors, so the worker never branches on a vendor.
- **`claude_max` is the persisted id for Claude Code.** Renaming it would break existing agents and tasks; the friendly name lives in `PROVIDER_LABELS` only.
- **Providers are classified `subscription` vs `metered`.** Budget ceilings, pricing lookups, and paid-fallback consent all key off that, not off the provider id.
- **A subscription run records no cost.** Neither Claude Code nor Codex publishes a per-token price, and no plan exposes a remaining balance, so cost is `null` and the UI says "covered by plan". A `$0.00` would be an invented figure.
- **Codex is serialized with a durable `provider_leases` row, not an advisory lock.** The worker singleton already holds advisory lock `0x484f4d41` for its whole life; a second lock in the same connection would deadlock. The lease is keyed by a hash of the auth *file path*, so one credential can never run two Codex jobs even across processes, and it survives a restart.
- **Fallbacks are never silent.** On a Codex auth/allowance failure the task stops and the owner picks wait / cancel / approve-paid-fallback. Approval only records consent; the spend policy is re-evaluated at execution time and the reason and destination are written to the audit chain.

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- OpenAPI: use `type: number` (never `integer`) and union-type nullable enums, or Orval's generated Zod fails to compile. Run `pnpm --filter @workspace/api-spec run codegen` after editing `lib/api-spec/openapi.yaml`.
- Never `console.log` in server code — use `req.log` / `logger`.
- API tests hit the **dev** Postgres. Impersonate the existing owner row, tag every inserted row, clean it up, and never clobber `owner_clerk_id`. Audit rows are hash-chained and append-only, so tests leave them in place.
- `@openai/codex-sdk` and `@openai/codex` are esbuild externals: the SDK only wraps a platform-specific native binary, and bundling it produces an opaque spawn failure at run time. The Codex connection test resolves the CLI explicitly to catch this.
- `pnpm run build` needs `PORT` and `BASE_PATH` set for the mockup-sandbox Vite config.

### Codex limitations worth knowing

- **Durability:** on non-persistent storage the refreshed credential is lost. The provider fails closed rather than half-working.
- **Security:** the Codex CLI is launched from an explicit env allowlist with every OpenAI/Codex/Anthropic/OpenRouter/Clerk/DB variable removed, so an agent's prompt or tools can never read a HomardClaw secret. Adding a secret to the server does not leak it into Codex.
- **Isolation:** each agent/conversation gets its own working directory and its own SDK thread id. HomardClaw stays authoritative for identity, memory, permissions, files, and task history — Codex only sees the turn it is given.
- **Allowance:** no API exposes how much ChatGPT Codex allowance is left, so none is displayed. Point at the official ChatGPT usage dashboard instead.
- **Verification:** everything is covered by mocked-SDK tests (`artifacts/api-server/src/routes/office.codex.test.ts`). A real ChatGPT login has **not** been exercised — that step needs the owner's own credential and must be done manually after deployment.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
