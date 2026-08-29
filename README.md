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
  tasks, and watch runs progress in real time.
- **Multiple providers, one interface** — Claude Code, Codex (via ChatGPT
  Plus), and OpenRouter all implement the same start/continue/cancel
  contract, so the worker and UI never need to branch on vendor.
- **Task queue & scheduling** — a singleton background worker claims and
  runs tasks, with self-healing ownership so it survives restarts and scales
  safely; recurring work can be scheduled ahead of time.
- **Talk (Telegram)** — chat with your agents and receive task
  notifications and approval requests from your phone.
- **Connected Apps** — register custom, workspace-scoped REST APIs (with
  encrypted credentials) that Crustabots can call through a hardened,
  SSRF-safe executor.
- **Memory** — per-agent memory that agents can draw on across
  conversations and tasks.
- **Approvals & audit trail** — sensitive or costly actions (like paid
  provider fallback) require explicit human approval, and every decision is
  recorded in an append-only, hash-chained audit log.
- **Per-workspace isolation** — every signed-in user gets their own
  workspace; data and provider credentials never cross workspace
  boundaries, and nothing falls back to a shared or global account.

## Key info for users

- Sign in and land on the **Office Dashboard** to create your first
  Crustabot.
- Connect a provider on the **Providers** page before assigning tasks —
  work fails closed with a clear "not configured" message until a
  credential is stored.
- Optional integrations (Telegram Talk, Web Research, custom Connected
  Apps) stay hidden until their required configuration is present; nothing
  silently degrades to a different behavior.
- See `replit.md` for local run/operate commands and architecture notes,
  and `PRODUCTION.md` for deployment and required environment variables.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 · DB: PostgreSQL + Drizzle ORM · Validation: Zod
- API codegen: Orval (from an OpenAPI spec) · Build: esbuild
