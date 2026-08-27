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
- Optional Web Research env: `WEB_SEARCH_API_KEY` — a Brave Search API key.
  When unset, the package remains visible but reports **not configured**; it
  never falls back to plain HTTP or an unconfigured remote server.
- Optional Telegram channel: set both `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_WEBHOOK_SECRET` to enable phone Talk, task notifications, and
  approval buttons. `TELEGRAM_BOT_USERNAME` adds a convenient bot link in the
  UI. The server derives its webhook from the Replit domain; set
  `TELEGRAM_WEBHOOK_URL=https://<your-domain>/api/telegram/webhook` when it
  cannot.

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
programmatic ChatGPT sign-in, and HomardClaw deliberately implements none.

1. On a machine with a browser: `npx @openai/codex login` (or `codex login`).
2. Copy the resulting `~/.codex/auth.json`.
3. Paste it into Providers → Codex → **Connect** while signed in as the account
   that should own it. The office owner may instead use `CODEX_AUTH_JSON` and
   **Bootstrap**; the seed is refused for every other account.
4. Confirm with Providers → Codex → **Test connection**. That check is
   entirely local — it reads stored sign-in metadata and resolves the SDK/CLI,
   and never calls OpenAI, so it cannot spend allowance.

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
- **Codex is serialized with a durable `provider_leases` row, not an advisory lock.** The worker singleton already holds advisory lock `0x484f4d41` for its whole life; a second lock in the same connection would deadlock. The lease is keyed by a hash of the auth _file path_, so one credential can never run two Codex jobs even across processes, and it survives a restart.
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
