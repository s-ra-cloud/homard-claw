# Crustabox

Crustabox (repo name: **Homard Claw**) is a private AI office for creating,
coordinating, and supervising configurable AI agents — **Crustabots**.

Instead of juggling separate chat windows and CLIs, you staff a shared
"office": each Crustabot is a configurable agent bound to a provider
(Claude Code, Codex, or OpenRouter), given tasks, and supervised from one
dashboard. Crustabox handles scheduling, memory, approvals, and audit
history so the agents can work with real autonomy while a human stays in
control.

## What it does

- **Office Dashboard** — create and configure Crustabots, assign and track
  tasks, and watch runs progress in real time in a pixel-art office scene.
- **Multiple providers, one interface** — Claude Code, Codex (via ChatGPT
  Plus), and OpenRouter all implement the same start/continue/cancel
  contract, so the worker and UI never need to branch on vendor.
- **Teams & delegation** — group Crustabots into a team with one lead; the
  lead can split its own work into sub-tasks for teammates, within
  depth/quota limits the owner controls.
- **Task queue & scheduling** — a singleton background worker claims and
  runs tasks, with self-healing ownership so it survives restarts and scales
  safely. Schedule one-off or recurring launches (daily, weekly, or
  monthly, timezone-aware) from the Schedules page, and set per-schedule
  notification preferences.
- **Talk** — chat with your agents over text or voice in-app, or from your
  phone via a linked Telegram bot; receive task notifications and approval
  requests there too. Agents can also proactively check in once a day, and
  you can schedule recurring questions for an agent to ask you.
- **In-app help** — a designated "Documentation" Crustabot answers
  questions about how to use the app from the Documentation page.
- **Connected Apps** — link Gmail, Google Drive, or GitHub with per-user
  OAuth, or register custom, workspace-scoped REST APIs (with encrypted
  credentials) that Crustabots can call through a hardened, SSRF-safe
  executor. Every write-level action requires owner approval.
- **Memory** — per-agent memory that agents can draw on across
  conversations and tasks.
- **Approvals & audit trail** — sensitive or costly actions (like paid
  provider fallback) require explicit human approval, and every decision is
  recorded in an append-only, hash-chained audit log. The owner can
  designate a reviewer agent to auto-review pending approvals, cap failed-task
  retries, or bypass approval entirely for a workspace.
- **Bug reports** — file a bug report from any task or from the Talk
  window with one click; it captures the relevant context automatically for
  the office owner to review.
- **Usage reports** — a Reports page rolls up real cost and token usage by
  day/week/month, per agent, and per provider, plus a list of tasks waiting
  on the owner.
- **Retirement Island** — retiring a Crustabot is permanent and sends it to
  a beach or hotel scene instead of deleting its history; a temporary "day
  off" is also available and reverses automatically the next morning.
- **Per-workspace isolation** — every signed-in user gets their own
  workspace; data and provider credentials never cross workspace
  boundaries, and nothing falls back to a shared or global account.

## Key info for users

- Sign in and land on the **Office Dashboard** to create your first
  Crustabot.
- Connect a provider on the **Providers** page before assigning tasks —
  work fails closed with a clear "not configured" message until a
  credential is stored.
- Optional integrations (Telegram Talk, Web Research, Gmail/Google
  Drive/GitHub, custom Connected Apps) stay hidden until their required
  configuration is present; nothing silently degrades to a different
  behavior.
- See `replit.md` for local run/operate commands and architecture notes,
  `PRODUCTION.md` for deployment and required environment variables, and
  `docs/capability-packages.md` for how the Connected Apps extensibility
  layer (Gmail, Google Drive, GitHub, Web Research, and future packages)
  is authored and secured.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 · DB: PostgreSQL + Drizzle ORM · Validation: Zod
- API codegen: Orval (from an OpenAPI spec) · Build: esbuild
