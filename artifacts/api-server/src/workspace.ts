import { clerkClient, getAuth } from "@clerk/express";
import {
  agentsTable,
  auditEventsTable,
  connectedAppSettingsTable,
  db,
  knowledgeFilesTable,
  memoriesTable,
  notificationsTable,
  schedulesTable,
  systemStateTable,
  tasksTable,
  teamsTable,
  workspaceConnectedAppsTable,
  workspaceSettingsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

/**
 * Personal workspaces: every Clerk user owns exactly one workspace, created
 * on their first authenticated request. All user-owned data is scoped by
 * workspace id; nothing ever crosses the boundary, and the workspace id is
 * always resolved server-side from the authenticated session — never taken
 * from the client.
 *
 * Legacy single-owner data: the office used to be one global room gated on
 * `system_state.owner_clerk_id`. The startup backfill assigns every
 * pre-workspace row to that owner's workspace (the "legacy workspace").
 * OWNER_EMAIL keeps its old meaning: the legacy workspace follows the
 * account whose *verified* email matches it, which is what lets the same
 * human keep their data across Clerk's separate dev/prod user stores.
 */

const LEGACY_WORKSPACE_KEY = "legacy_workspace_id";
const BACKFILL_DONE_KEY = "workspace_backfill_done";

/** Global (pre-workspace) settings keys migrated into workspace settings. */
const MIGRATED_SETTINGS_KEYS = [
  "emergency_stop",
  "voice_transcripts_enabled",
  "provider.default",
  "provider.claude_max.default_model",
  "provider.openrouter.default_model",
  "provider.codex_chatgpt.default_model",
  "provider.codex_chatgpt.default_reasoning",
  "provider.fallback.order",
  "provider.fallback.paid_consent",
  "provider.fallback.paid_limit_cents",
] as const;

const configuredOwnerEmail = (): string | null =>
  process.env.OWNER_EMAIL?.trim().toLowerCase() || null;

/**
 * Only refusals are remembered, and only briefly, so a non-matching account
 * cannot amplify into a Clerk lookup per request. A match is never cached —
 * moving the legacy workspace always rests on a fresh verified lookup.
 */
const DENIAL_TTL_MS = 60_000;
const DENIAL_LIMIT = 500;
const denials = new Map<string, { at: number }>();

async function verifiedEmail(
  req: Request,
  userId: string,
): Promise<string | null> {
  try {
    const user = await clerkClient.users.getUser(userId);
    const address = user.primaryEmailAddress ?? user.emailAddresses?.[0];
    // An unverified address proves nothing: anyone could sign up claiming
    // the owner's email and take the legacy data with it.
    if (address?.verification?.status !== "verified") return null;
    return address.emailAddress?.trim().toLowerCase() ?? null;
  } catch (error) {
    // A Clerk outage must not move data to the wrong account: fail closed.
    req.log?.warn({ userId, err: error }, "Could not resolve signed-in email");
    return null;
  }
}

async function readSystemValue(key: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, key))
    .limit(1);
  return row?.value;
}

async function upsertSystemValue(key: string, value: string): Promise<void> {
  await db
    .insert(systemStateTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: systemStateTable.key, set: { value } });
}

/** Get-or-create the workspace row owned by a Clerk user. */
export async function workspaceForUser(clerkUserId: string): Promise<string> {
  const [existing] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.clerkUserId, clerkUserId))
    .limit(1);
  if (existing) return existing.id;
  await db
    .insert(workspacesTable)
    .values({ clerkUserId })
    .onConflictDoNothing();
  const [created] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.clerkUserId, clerkUserId))
    .limit(1);
  if (!created) throw new Error("Workspace creation failed");
  return created.id;
}

/** The workspace holding pre-multi-tenant data, if any. */
export async function legacyWorkspaceId(): Promise<string | null> {
  return (await readSystemValue(LEGACY_WORKSPACE_KEY)) ?? null;
}

/**
 * When the signed-in account has no workspace yet but its verified email
 * matches OWNER_EMAIL, the legacy workspace (with all its data) follows the
 * account instead of starting an empty one. Compare-and-set on the previous
 * Clerk id so two simultaneous hand-overs cannot interleave.
 */
async function maybeAdoptLegacyWorkspace(
  req: Request,
  userId: string,
): Promise<string | null> {
  const ownerEmail = configuredOwnerEmail();
  if (!ownerEmail) return null;
  const legacyId = await legacyWorkspaceId();
  if (!legacyId) return null;
  const [legacy] = await db
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.id, legacyId))
    .limit(1);
  if (!legacy || legacy.clerkUserId === userId) return legacy?.id ?? null;

  const denied = denials.get(userId);
  if (denied && Date.now() - denied.at < DENIAL_TTL_MS) return null;
  const email = await verifiedEmail(req, userId);
  if (email !== ownerEmail) {
    if (denials.size >= DENIAL_LIMIT) denials.clear();
    denials.set(userId, { at: Date.now() });
    return null;
  }
  const moved = await db
    .update(workspacesTable)
    .set({ clerkUserId: userId })
    .where(
      and(
        eq(workspacesTable.id, legacy.id),
        eq(workspacesTable.clerkUserId, legacy.clerkUserId),
      ),
    )
    .returning({ id: workspacesTable.id });
  if (moved.length > 0) {
    // Keep the legacy owner marker in step so old tooling stays truthful.
    await upsertSystemValue("owner_clerk_id", userId);
    req.log?.warn(
      { userId },
      "Legacy workspace moved to the configured owner account",
    );
    return legacy.id;
  }
  const [settled] = await db
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.id, legacy.id))
    .limit(1);
  return settled?.clerkUserId === userId ? settled.id : null;
}

/**
 * Authenticated workspace resolution. Replaces the old single-owner gate:
 * any signed-in user gets (or creates) their own private workspace. 401
 * when unauthenticated; never 403 — there is nothing global left to guard.
 */
export async function requireWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getAuth(req)?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const [existing] = await db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(eq(workspacesTable.clerkUserId, userId))
      .limit(1);
    let workspaceId = existing?.id ?? null;
    if (!workspaceId) {
      // First request from this account: adopt the legacy workspace when
      // OWNER_EMAIL says so, otherwise start a fresh isolated workspace.
      workspaceId =
        (await maybeAdoptLegacyWorkspace(req, userId)) ??
        (await workspaceForUser(userId));
    }
    req.workspaceId = workspaceId;
    req.workspaceUserId = userId;
    next();
  } catch (error) {
    next(error);
  }
}

/** Per-workspace settings helpers. */
export async function getWorkspaceSetting(
  workspaceId: string,
  key: string,
): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, workspaceId),
        eq(workspaceSettingsTable.key, key),
      ),
    )
    .limit(1);
  return row?.value;
}

export async function getWorkspaceSettings(
  workspaceId: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select()
    .from(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, workspaceId),
        inArray(workspaceSettingsTable.key, [...keys]),
      ),
    );
  return new Map(rows.map((row) => [row.key, row.value]));
}

export async function setWorkspaceSetting(
  workspaceId: string,
  key: string,
  value: string,
): Promise<void> {
  await db
    .insert(workspaceSettingsTable)
    .values({ workspaceId, key, value })
    .onConflictDoUpdate({
      target: [workspaceSettingsTable.workspaceId, workspaceSettingsTable.key],
      set: { value },
    });
}

/**
 * One-time startup migration: create the legacy workspace for the recorded
 * single owner and hand every pre-workspace row to it. Idempotent — each
 * step only touches rows that still have no workspace — and re-run cheaply
 * on every boot until it completes once.
 */
export async function ensureWorkspaceBackfill(): Promise<void> {
  if ((await readSystemValue(BACKFILL_DONE_KEY)) === "true") return;
  const ownerClerkId = await readSystemValue("owner_clerk_id");
  if (ownerClerkId) {
    const workspaceId = await workspaceForUser(ownerClerkId);
    await upsertSystemValue(LEGACY_WORKSPACE_KEY, workspaceId);
    const ws = sql`${workspaceId}::uuid`;
    // Root tables with their own workspace column.
    await db.execute(
      sql`update ${agentsTable} set workspace_id = ${ws} where workspace_id is null`,
    );
    await db.execute(
      sql`update ${teamsTable} set workspace_id = ${ws} where workspace_id is null`,
    );
    await db.execute(
      sql`update ${tasksTable} set workspace_id = ${ws} where workspace_id is null`,
    );
    await db.execute(
      sql`update ${schedulesTable} set workspace_id = ${ws} where workspace_id is null`,
    );
    await db.execute(
      sql`update ${notificationsTable} set workspace_id = ${ws} where workspace_id is null`,
    );
    await db.execute(
      sql`update ${memoriesTable} set workspace_id = ${ws} where workspace_id is null`,
    );
    await db.execute(
      sql`update ${knowledgeFilesTable} set workspace_id = ${ws} where workspace_id is null`,
    );
    await db.execute(
      sql`update ${auditEventsTable} set workspace_id = ${ws} where workspace_id is null`,
    );
    // Formerly-global preferences move into the owner's workspace settings.
    const globals = await db
      .select()
      .from(systemStateTable)
      .where(inArray(systemStateTable.key, [...MIGRATED_SETTINGS_KEYS]));
    for (const row of globals) {
      await db
        .insert(workspaceSettingsTable)
        .values({ workspaceId, key: row.key, value: row.value })
        .onConflictDoNothing();
    }
    // Per-app enable switches follow too.
    const legacyApps = await db.select().from(connectedAppSettingsTable);
    for (const row of legacyApps) {
      await db
        .insert(workspaceConnectedAppsTable)
        .values({ workspaceId, app: row.app, enabled: row.enabled })
        .onConflictDoNothing();
    }
  }
  await upsertSystemValue(BACKFILL_DONE_KEY, "true");
}

/** Guard that a nullable stored workspace id matches the caller's. */
export function isSameWorkspace(
  rowWorkspaceId: string | null,
  workspaceId: string,
): boolean {
  return rowWorkspaceId === workspaceId;
}

/** Predicate for scoping a table by its workspace column. */
export function inWorkspace<
  T extends { workspaceId: unknown },
>(table: T, workspaceId: string) {
  return eq(
    table.workspaceId as Parameters<typeof eq>[0],
    workspaceId,
  );
}

/** True when rows with a null workspace can never be seen (post-backfill). */
export const notNullWorkspace = isNull;
