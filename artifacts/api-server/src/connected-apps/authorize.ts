import {
  agentAppGrantsTable,
  connectedAppSettingsTable,
  db,
  type AppAccessLevel,
  type ConnectedAppId,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  APP_CATALOG,
  CONNECTED_APP_IDS,
  buildAppsPromptSection,
  findOperation,
  isConnectedAppId,
  levelAllows,
  validateParams,
  type AppOperation,
} from "./catalog";

/** Everything the worker needs to know about one agent's app access. */
export type AgentAppAccess = {
  /** app → granted level, only for apps the workspace has enabled. */
  grants: Map<ConnectedAppId, AppAccessLevel>;
  /** System-prompt section, or null when the agent can use nothing. */
  promptSection: string | null;
};

/**
 * Load an agent's effective app access: explicit grants minus apps the
 * owner has switched off workspace-wide. Loaded fresh per task attempt so
 * a revoked grant applies to the very next action, not the next task.
 */
export async function loadAgentAppAccess(
  agentId: string,
): Promise<AgentAppAccess> {
  const [grantRows, settingRows] = await Promise.all([
    db
      .select()
      .from(agentAppGrantsTable)
      .where(eq(agentAppGrantsTable.agentId, agentId)),
    db
      .select()
      .from(connectedAppSettingsTable)
      .where(
        inArray(connectedAppSettingsTable.app, [...CONNECTED_APP_IDS]),
      ),
  ]);
  const disabled = new Set(
    settingRows.filter((row) => !row.enabled).map((row) => row.app),
  );
  const grants = new Map<ConnectedAppId, AppAccessLevel>();
  for (const row of grantRows) {
    if (!isConnectedAppId(row.app)) continue;
    if (disabled.has(row.app)) continue;
    grants.set(row.app, row.accessLevel as AppAccessLevel);
  }
  return { grants, promptSection: buildAppsPromptSection(grants) };
}

export type AppActionDecision =
  | { kind: "deny"; reason: string }
  | {
      kind: "allow" | "needs_approval";
      op: AppOperation;
      params: Record<string, unknown>;
      targetSummary: string;
    };

/**
 * The server-side gate every requested action passes through, regardless of
 * what any prompt claimed. Pure over its inputs so the deny matrix is
 * directly testable: unknown operations, unassigned apps, and requests
 * broader than the grant all die here; externally visible writes survive
 * only as approval requests.
 */
export function authorizeAppAction(
  access: Pick<AgentAppAccess, "grants">,
  operationName: string,
  rawParams: unknown,
): AppActionDecision {
  const op = findOperation(operationName);
  if (!op) {
    return {
      kind: "deny",
      reason: `"${operationName}" is not a supported operation.`,
    };
  }
  const granted = access.grants.get(op.app);
  if (granted === undefined) {
    return {
      kind: "deny",
      reason: `This agent has no access to ${APP_CATALOG[op.app].displayName}. The owner must grant it (and the app must be enabled) first.`,
    };
  }
  if (!levelAllows(granted, op.level)) {
    return {
      kind: "deny",
      reason: `This agent's ${APP_CATALOG[op.app].displayName} access is "${granted}", but ${op.name} needs "${op.level}".`,
    };
  }
  const validated = validateParams(op, rawParams);
  if (!validated.ok) {
    return { kind: "deny", reason: `Invalid request: ${validated.error}` };
  }
  const targetSummary = op.target(validated.params).slice(0, 300);
  // Externally visible writes never run on the agent's own authority: the
  // owner sees exactly what would happen and decides.
  return {
    kind: op.level === "write" ? "needs_approval" : "allow",
    op,
    params: validated.params,
    targetSummary,
  };
}
