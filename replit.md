# Crustabox (Homard Claw)

A private AI office where you create, configure, and supervise Crustabots —
AI agents bound to a provider (Claude Code, Codex, or OpenRouter) — from one
shared dashboard that handles scheduling, memory, approvals, and audit
history.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run test` — API integration tests (uses the dev Postgres)
- Required env: `DATABASE_URL` — Postgres connection string
- Optional Web Research env: `WEB_SEARCH_API_KEY` — a Brave Search API key.
  When unset, the package remains visible but reports **not configured**; it
  never falls back to plain HTTP or an unconfigured remote server.
- Optional Telegram channel: set both `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_WEBHOOK_SECRET` to enable phone Talk, task notifications, and
  approval buttons. `TELEGRAM_BOT_USERNAME` adds a convenient bot link in the
  UI. The server derives its webhook from the Replit domain; set
  `TELEGRAM_WEBHOOK_URL=https://<your-domain>/api/telegram/webhook` when it
  cannot.
- Optional Connected Apps: `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`
  (or `GITHUB_APP_ID`/`GITHUB_APP_SLUG`/`GITHUB_APP_PRIVATE_KEY` for the
  preferred GitHub App path) enable the GitHub Connected App;
  `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` enable Gmail and
  Google Drive. See `docs/capability-packages.md`.
- Manual frontend builds (`pnpm run build` / a bare `vite build`) need `PORT`
  and `BASE_PATH` set — the Replit workflow provides them, but a shell build
  must pass them explicitly, e.g. `PORT=5000 BASE_PATH=/`.
- `OWNER_EMAIL` (optional in dev): pins the single office owner to a verified
  email instead of the first-authenticated Clerk account. Matters most in
  production (see `PRODUCTION.md`).

### Telegram webhook (optional)

On startup, a configured server calls Telegram `setWebhook` when it can derive
a public HTTPS URL. To register it manually instead, make this request with the
same secret stored in `TELEGRAM_WEBHOOK_SECRET`:

```sh
curl -X POST "https://api.telegram.org/bot<bot-token>/setWebhook" \
  -H "content-type: application/json" \
  --data '{"url":"https://<your-domain>/api/telegram/webhook","secret_token":"<webhook-secret>","allowed_updates":["message","callback_query"]}'
```

Then open **Connected Apps**, choose the default Talk agent, create a one-time
code, and send `/start <code>` to the bot. Codes expire after ten minutes and
work once. The database schema must be pushed before using this feature.

### Codex via ChatGPT Plus (optional third provider)

Codex is off unless its required variables are set. Sign-ins are **per
account**: each signed-in user connects their own ChatGPT session (encrypted
in Postgres, keyed by Clerk id), and every run must resolve that account
explicitly. There is no fallback identity.

| Variable                     | Required | Purpose                                                                                                                                                      |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CODEX_ENABLED`              | yes      | Server-side feature flag. Unset ⇒ Codex is hidden and refuses to run.                                                                                        |
| `CODEX_HOME`                 | yes      | Absolute private scratch root. Each account gets a hashed subdirectory and temporary 0600 `auth.json`; the durable credential remains encrypted in Postgres. |
| `CODEX_WORKSPACE_ROOT`       | yes      | Absolute root for isolated agent/conversation working directories.                                                                                           |
| `CODEX_AUTH_JSON`            | optional | One-time seed for the office owner's account only when no credential is stored. Never applies to another account.                                            |
| `CODEX_MODELS`               | no       | `id:name:context,…` model catalog override.                                                                                                                  |
| `CODEX_DEFAULT_MODEL`        | no       | Defaults to `gpt-5.6-terra`.                                                                                                                                 |
| `CODEX_REASONING_LEVELS`     | no       | Supported reasoning levels.                                                                                                                                  |
| `CODEX_DEFAULT_REASONING`    | no       | Defaults to `medium`.                                                                                                                                        |
| `CODEX_AUTH_MAX_AGE_DAYS`    | no       | Session staleness threshold.                                                                                                                                 |
| `CODEX_HEALTH_CHECK_MINUTES` | no       | Local credential health-check throttle.                                                                                                                      |
| `CODEX_LEASE_TTL_SECONDS`    | no       | Maximum credential-lease duration.                                                                                                                           |
| `CODEX_ALLOW_NETWORK`        | no       | Network/web search only for `operator` + `autonomous` agents.                                                                                                |

Autoscale is supported because Postgres is the credential source of truth.
The plaintext working copy is created just for a run, refreshed contents are
folded back into the same account's encrypted row, and the file is removed.

**Manual login (one time, not automatable).** There is no supported
programmatic ChatGPT sign-in, and Crustabox deliberately implements none.

1. On a machine with a browser: `npx @openai/codex login` (or `codex login`).
2. Copy the resulting `~/.codex/auth.json`.
3. Paste it into Providers → Codex → **Connect** while signed in as the account
   that should own it. The office owner may instead use `CODEX_AUTH_JSON` and
   **Bootstrap**; the seed is refused for every other account.
4. Confirm with Providers → Codex → **Test connection**. That check is
   entirely local — it reads stored sign-in metadata and resolves the SDK/CLI,
   and never calls OpenAI, so it cannot spend allowance.

Re-run steps 1–3 whenever the status reports authentication expired. Only
Codex's own SDK refresh path may rewrite `auth.json`; Crustabox never does.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/` — Express API + background worker.
  - `routes/` — one file per resource (`office.ts` is the largest: agents,
    tasks, teams, approvals, island/leave, voice, documentation settings).
  - `capabilities/` — the Connected Apps / capability-package extensibility
    layer (manifest, registry, install lifecycle, execution). See
    `docs/capability-packages.md`.
  - `github/`, `google/` — OAuth + GitHub App credential flows backing the
    GitHub, Gmail, and Google Drive Connected Apps.
  - `codex/`, `execution.ts` — provider adapters (Claude Code, Codex,
    OpenRouter) behind one start/continue/cancel contract.
  - `scheduler.ts`, `chat-question-scheduler.ts`,
    `daily-talk-checkin-scheduler.ts` — three sibling claim/finalize
    schedulers (task launches, proactive chat questions, one daily
    unprompted Talk check-in), all ticked from `worker.ts`.
  - `worker.ts`, `worker-ownership.ts` — the singleton task-queue worker and
    its self-healing ownership lease.
- `artifacts/homardclaw/src/` — the React office UI (`pages/`, `components/`).
- `lib/db/src/schema/` — Drizzle schema; the source of truth for the DB
  (`office.ts` holds nearly every table).
- `lib/api-spec/openapi.yaml` — API contract; `pnpm --filter @workspace/api-spec run codegen` regenerates the Zod schemas and React Query client from it.
- `docs/capability-packages.md` — how to author a new Connected App package.
- `.agents/memory/*.md` — durable engineering notes on non-obvious
  invariants (scheduling, auth, tenancy, sandboxing); read before touching
  the area a note names.

## Architecture decisions

- **Providers go through one adapter contract** (`artifacts/api-server/src/execution.ts`). Claude Code, Codex, and OpenRouter each implement start/continue/cancel, streaming progress, usage, and sanitized errors, so the worker never branches on a vendor.
- **`claude_max` is the persisted id for Claude Code.** Renaming it would break existing agents and tasks; the friendly name lives in `PROVIDER_LABELS` only.
- **Providers are classified `subscription` vs `metered`.** Budget ceilings, pricing lookups, and paid-fallback consent all key off that, not off the provider id.
- **A subscription run records no cost.** Neither Claude Code nor Codex publishes a per-token price, and no plan exposes a remaining balance, so cost is `null` and the UI says "covered by plan". A `$0.00` would be an invented figure.
- **Codex is serialized with a durable `provider_leases` row, not an advisory lock.** The lease is keyed by a hash of the auth _file path_, so one credential can never run two Codex jobs even across processes, and it survives a restart.
- **The queue worker is a singleton via an expiring, heartbeated `worker_ownership` row** (`artifacts/api-server/src/worker-ownership.ts`), not an advisory lock: the holder renews every 10s, ownership expires after 30s of missed heartbeats, and any standby instance takes over the expired row (Autoscale self-healing). Renewal failure aborts local provider calls; the per-attempt fence in `finishIfStillRunning` blocks a stale instance's results. Clean shutdown deletes the row for instant handoff. `/api/runtime/health` reports active/standby state plus the ownership row's staleness.
- **Fallbacks are never silent.** On a Codex auth/allowance failure the task stops and the owner picks wait / cancel / approve-paid-fallback. Approval only records consent; the spend policy is re-evaluated at execution time and the reason and destination are written to the audit chain.
- **GitHub prefers its App installation over legacy OAuth.** Both auth paths can be configured at once; a workspace with an active GitHub App installation always uses it (self-renewing tokens) and OAuth is only consulted as a fallback. Gmail and Google Drive instead share a single Google account per workspace via incremental OAuth consent (declining Drive's broader organize scope still allows reads and app-created files).
- **The office owner's identity is `OWNER_EMAIL`, not a stored Clerk id.** Clerk user stores are per-environment, so a cached id from development means nothing in production. A verified-email match takes over the stored owner row; a mismatch or missing `OWNER_EMAIL` never overrides an existing owner.
- **Chat-question and daily-Talk-check-in schedulers are siblings of the task scheduler, not variants of it.** Each reuses the same claim → dispatch/fire → finalize discipline (see `.agents/memory/durable-scheduling.md`) but owns its own table, so a bug in one can't regress task-schedule firing.

## Product

See `README.md` for the user-facing feature list. Notable areas with more
depth than the README covers:

- **Teams & delegation** — a team has one lead; only the lead can split its
  own task into sub-tasks for teammates, gated by depth/quota checks
  evaluated inside the same transaction as the parent-task lock so
  concurrent hand-offs can't overshoot the cap.
- **Talk** — text or voice chat with an agent, backed by a per-workspace
  OpenAI key (Talk voice settings), independent of which provider runs the
  agent's tasks. Chat can only *propose* a task; it never queues one
  directly. A daily proactive check-in (one random eligible agent, random
  time, no configuration) and owner-scheduled recurring chat questions are
  both separate from task scheduling and ride the same Talk history.
- **Retirement Island vs. day off** — retiring an agent
  (`POST /agents/:id/retire`) is permanent: it can never be deleted, paused,
  or resumed again, and appears forever on the Island (beach or, up to 10
  at a time, hotel). A "day off" is a separate, temporary, reversible pause
  the owner grants conversationally; the agent returns automatically the
  next morning.
- **Approval preferences** — per workspace, the owner can name a reviewer
  agent to auto-review pending approvals, cap automatic failed-task
  retries (1-3), or flip an "always approve everything" bypass. All three
  live-sync over the same SSE topic as the approval board.
- **Bug reports & usage reports** — bug reports are owner-only, filed from
  a task or the Talk window, and auto-attach the relevant context (task
  state, or the last 10 Talk turns). The Reports page aggregates real
  (never estimated) cost/token usage — no feature here creates cost data
  that didn't come from a completed provider call.

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
- **Security:** the Codex CLI is launched from an explicit env allowlist with every OpenAI/Codex/Anthropic/OpenRouter/Clerk/DB variable removed, so an agent's prompt or tools can never read a Crustabox secret. Adding a secret to the server does not leak it into Codex.
- **Isolation:** each agent/conversation gets its own working directory and its own SDK thread id. Crustabox stays authoritative for identity, memory, permissions, files, and task history — Codex only sees the turn it is given.
- **Allowance:** no API exposes how much ChatGPT Codex allowance is left, so none is displayed. Point at the official ChatGPT usage dashboard instead.
- **Verification:** everything is covered by mocked-SDK tests (`artifacts/api-server/src/routes/office.codex.test.ts`). A real ChatGPT login has **not** been exercised — that step needs the owner's own credential and must be done manually after deployment.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
