---
name: Workspace tenancy model
description: How per-Clerk-user workspaces scope every API/worker path and how legacy single-owner data is adopted.
---

# Workspace tenancy

Rule: every route sits behind `requireWorkspace` (src/workspace.ts) which resolves the Clerk user to a workspaces row (auto-created on first request) and sets `req.workspaceId`. All user data tables carry a nullable `workspaceId`; queries scope by it, so foreign or null rows read as 404 — never 403 (no existence leaks). Owner IDs are never accepted from the client; workers/schedulers resolve credentials from the task's durable `workspaceId`.

**Why:** multi-tenant isolation replaced the single-owner gate; a 403 would confirm a guessed ID exists.

**How to apply:** direct DB inserts in tests MUST stamp `workspaceId` or routes/retrieval won't see the rows; resolve it after one authenticated request via `workspacesTable.clerkUserId`. Emergency stop, provider settings, voice transcripts, and connected-app enable switches live in `workspaceSettingsTable` / `workspaceConnectedAppsTable`, not systemState. OWNER_EMAIL adoption moves the legacy workspace (CAS on prior clerkUserId) only for a *verified* matching email; denials are cached briefly, matches never.
