# Production Deployment Guide — HomardClaw

How to publish this project safely, what it needs at runtime, and how to
verify a deployment.

## Architecture in production

- Two deployed services behind one origin (path routing): the web app is a
  static SPA served at `/`, the API server runs at `/api`. There is no Vite
  proxy — the platform router splits traffic by path, and the frontend
  always calls same-origin `/api/...` URLs.
- The API process also runs the background worker. The worker elects a
  single active instance via a session-scoped Postgres advisory lock, so
  running multiple API instances (autoscale) is safe: exactly one claims
  tasks, the rest serve HTTP and poll for the lease.
- On SIGTERM the API stops accepting connections, aborts in-flight provider
  calls without writing task state, releases the worker lease, and drains
  the DB pool. Interrupted `running` tasks are requeued by the next lease
  holder's recovery pass.

## Required environment (production)

| Variable | Purpose | Required |
| --- | --- | --- |
| `PORT` | API listen port (set by deployment config) | yes |
| `NODE_ENV=production` | JSON logging, Clerk proxy behavior | yes |
| `DATABASE_URL` | Postgres connection | yes |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Owner authentication | yes |
| `VITE_CLERK_PUBLISHABLE_KEY` | Web build-time Clerk key | yes (build) |
| `SESSION_SECRET` | Session signing + encryption key for stored per-workspace credentials | yes |
| `LOG_LEVEL` | Pino level (default `info`) | no |

AI provider credentials are **not** environment variables. Each workspace
stores its own credentials through the app, encrypted (AES-256-GCM, key
derived from `SESSION_SECRET`) in the `provider_credentials` table:

- Claude Code OAuth token and OpenRouter API key — entered on the
  Providers page.
- OpenAI API key for voice (speech-to-text / text-to-speech) — entered in
  the Talk call settings.

Without a stored credential, tasks block immediately with
`not_configured` and a message telling the user which key to add on which
page; voice endpoints report unavailable and the UI falls back to text.
Nothing crashes; features degrade explicitly. There is no shared
server-level provider key, so one workspace can never spend another
workspace's (or the operator's) allowance. Rotating `SESSION_SECRET`
makes stored credentials undecryptable: users are asked to re-enter their
keys, never silently routed to anything shared.

## Database schema strategy

- Schema source of truth: `lib/db/src/schema/`. Sync mechanism:
  `drizzle-kit push` (`pnpm --filter db push`). There is no committed
  migration directory.
- **Development**: `scripts/post-merge.sh` pushes schema after task merges.
- **Production**: schema is never synced at boot. Before publishing a
  release that changed the schema, apply it to the production database
  through Replit's database migration flow (the publish flow prompts for
  it, or ask the agent to "push the dev schema to production"). Additive
  changes (new tables/columns) are safe; destructive changes need a manual
  review of the generated statements before confirming.
- The app fails loudly if the schema is behind (Postgres errors surface as
  500s and the health probe stays green only for connectivity), so verify
  schema sync before routing traffic to a schema-dependent release.

## Security posture

- Every `/api` route except `/api/healthz` is owner-gated: 401 without a
  session, 403 for any authenticated non-owner. First authenticated caller
  becomes the owner (single-tenant by design).
- CORS only allows the deployment's own hostnames (from `REPLIT_DOMAINS` /
  `REPLIT_DEV_DOMAIN`) plus localhost; arbitrary origins are refused, so
  other websites cannot ride the owner's credentials.
- Provider HTTP error bodies are never persisted; network/SDK error
  messages pass through `src/lib/sanitize.ts` (redacts bearer tokens,
  API-key shapes, credentialed URLs, and literal secret env values) before
  reaching `tasks.errorMessage`, task logs, notifications, or reports.
- A final Express error handler returns a generic 500 JSON body; stack
  traces go only to the server log. Pino redacts authorization/cookie
  headers and logs neither request bodies nor query strings.

## Health & startup checks

- `GET /api/healthz` — unauthenticated readiness probe; verifies the
  database answers within 2.5s, returns `503 {"status":"unavailable"}`
  otherwise. Deployment health checks should target this.
- `GET /api/runtime/health` (owner-only) — queue depth, worker lease
  state, emergency-stop flag, provider configuration status.

## Verifying a deployment

1. `curl https://<prod-domain>/api/healthz` → `{"status":"ok"}`.
2. `curl https://<prod-domain>/api/agents` → `401` (auth gate live).
3. Load `/` → Clerk sign-in appears; sign in as the owner → office loads.
4. Providers page shows which credentials are configured.
5. Dispatch a small task; watch it complete (or block with a clear reason
   if no provider credential is set).

## Test & validation commands

- `pnpm run typecheck` — all packages.
- `pnpm --filter @workspace/api-server exec vitest run` — full API suite
  (integration tests hit the dev Postgres; see
  `.agents/memory/api-server-test-conventions.md`). Never point tests at
  the production database.
- `pnpm --filter @workspace/api-spec run codegen` — regenerate client/Zod
  after OpenAPI changes; commit the generated output.

## Known limits (accepted, documented)

- Only provider 429s are retried (with backoff via `notBefore`); network
  errors and 5xx are terminal per attempt by design — the owner can retry
  from the UI.
- Notifications are in-app only (no email/push).
- The frontend has no automated e2e suite; API behavior is covered by
  ~130 integration tests.
