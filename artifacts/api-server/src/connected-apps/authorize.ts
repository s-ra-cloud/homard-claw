import {
  agentAppGrantsTable,
  agentsTable,
  db,
  workspaceConnectedAppsTable,
  workspaceSkillsTable,
  type AppAccessLevel,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  builtinCapabilities,
  loadWorkspaceCapabilities,
  capabilityTarget,
  type ResolvedCapabilityTool,
  type WorkspaceCapabilities,
} from "../capabilities/service";
import { buildSkillsPromptSection } from "../capabilities/skills";
import { isNetworkBackedExecutor } from "../capabilities/manifest";
import { buildAppsPromptSection, levelAllows, validateParams } from "./catalog";

/** Everything the worker needs to know about one agent's app access. */
export type AgentAppAccess = {
  /** package/app id → granted level, only for packages the workspace has enabled. */
  grants: Map<string, AppAccessLevel>;
  /** System-prompt section, or null when the agent can use nothing. */
  promptSection: string | null;
  /**
   * Sensitive-data sandbox flag, loaded fresh alongside the grants so a
   * toggle applies to the very next authorization decision. When true,
   * only read-level operations survive — drafts and writes are denied
   * even if the stored grant is broader, and even for actions the owner
   * approved before the sandbox was switched on.
   */
  sensitiveDataSandbox: boolean;
  /**
   * The workspace's resolved capability catalog (built-in packages plus
   * pinned, active installs), loaded in the same breath as the grants so
   * authorization always judges requests against the exact tool set the
   * prompt advertised.
   */
  capabilities: WorkspaceCapabilities;
};

/**
 * Load an agent's effective app access: explicit grants minus packages the
 * owner has switched off workspace-wide, resolved against the workspace's
 * installed capability catalog. Loaded fresh per task attempt so a revoked
 * grant or a quarantined package applies to the very next action, not the
 * next task. Pass the task objective to also select relevant package skills
 * into the prompt section.
 */
export async function loadAgentAppAccess(
  agentId: string,
  workspaceId: string | null,
  options?: { objective?: string },
): Promise<AgentAppAccess> {
  const [grantRows, settingRows, agentRows, capabilities, workspaceSkills] =
    await Promise.all([
      db
        .select({
          app: agentAppGrantsTable.app,
          accessLevel: agentAppGrantsTable.accessLevel,
        })
        .from(agentAppGrantsTable)
        .innerJoin(agentsTable, eq(agentAppGrantsTable.agentId, agentsTable.id))
        .where(
          and(
            eq(agentAppGrantsTable.agentId, agentId),
            eq(agentsTable.workspaceId, workspaceId ?? ""),
          ),
        ),
      workspaceId
        ? db
            .select()
            .from(workspaceConnectedAppsTable)
            .where(eq(workspaceConnectedAppsTable.workspaceId, workspaceId))
        : Promise.resolve(
            [] as (typeof workspaceConnectedAppsTable.$inferSelect)[],
          ),
      db
        .select({ sensitiveDataSandbox: agentsTable.sensitiveDataSandbox })
        .from(agentsTable)
        .where(
          and(
            eq(agentsTable.id, agentId),
            eq(agentsTable.workspaceId, workspaceId ?? ""),
          ),
        )
        .limit(1),
      loadWorkspaceCapabilities(workspaceId),
      workspaceId
        ? db
            .select({
              title: workspaceSkillsTable.title,
              triggers: workspaceSkillsTable.triggers,
              instructions: workspaceSkillsTable.instructions,
              enabled: workspaceSkillsTable.enabled,
            })
            .from(workspaceSkillsTable)
            .where(
              and(
                eq(workspaceSkillsTable.workspaceId, workspaceId),
                eq(workspaceSkillsTable.enabled, true),
              ),
            )
            .orderBy(workspaceSkillsTable.createdAt)
        : Promise.resolve([]),
    ]);
  // Fail closed: an agent row we cannot read is treated as sandboxed.
  const sensitiveDataSandbox = agentRows[0]?.sensitiveDataSandbox ?? true;
  const disabled = new Set(
    settingRows.filter((row) => !row.enabled).map((row) => row.app),
  );
  const grants = new Map<string, AppAccessLevel>();
  // Fail closed: an agent without a workspace has no app access at all —
  // there is no owner whose credentials it could legitimately use. A grant
  // only counts when its package actually resolves for THIS workspace: a
  // stale grant to an uninstalled or quarantined package is dead weight.
  if (workspaceId) {
    for (const row of grantRows) {
      if (!capabilities.packages.has(row.app)) continue;
      if (disabled.has(row.app)) continue;
      grants.set(row.app, row.accessLevel as AppAccessLevel);
    }
  }
  const appsSection = buildAppsPromptSection(grants, {
    sensitiveDataSandbox,
    tools: [...capabilities.tools.values()].map((tool) => ({
      name: tool.name,
      packageId: tool.packageId,
      level: tool.level,
      description: tool.description,
      external: isNetworkBackedExecutor(tool.def.executor),
    })),
  });
  const skillsSection = options?.objective
    ? buildSkillsPromptSection(
        capabilities.packages.values(),
        new Set(grants.keys()),
        options.objective,
        // Workspace skills are shared owner-authored context and therefore
        // never enter a sensitive-data agent's prompt.
        sensitiveDataSandbox ? [] : workspaceSkills,
      )
    : null;
  const promptSection =
    appsSection && skillsSection
      ? `${appsSection}\n\n${skillsSection}`
      : (appsSection ?? skillsSection ?? null);
  return {
    grants,
    promptSection,
    sensitiveDataSandbox,
    capabilities,
  };
}

export type AppActionDecision =
  | { kind: "deny"; reason: string }
  | {
      kind: "allow" | "needs_approval";
      op: { app: string; name: string; level: AppAccessLevel };
      tool: ResolvedCapabilityTool;
      params: Record<string, unknown>;
      targetSummary: string;
    };

/**
 * The server-side gate every requested action passes through, regardless of
 * what any prompt claimed. Pure over its inputs so the deny matrix is
 * directly testable: unknown operations, unassigned packages, and requests
 * broader than the grant all die here; externally visible writes survive
 * only as approval requests. Neither an MCP/native description nor a skill
 * text can widen anything: the decision reads only the pinned catalog, the
 * grants, and the sandbox flag.
 */
export function authorizeAppAction(
  access: Pick<AgentAppAccess, "grants" | "sensitiveDataSandbox"> & {
    capabilities?: WorkspaceCapabilities;
  },
  operationName: string,
  rawParams: unknown,
): AppActionDecision {
  // Without an explicit catalog (older callers/tests), judge against the
  // built-in packages alone — exactly the pre-package behavior.
  const catalog = access.capabilities ?? builtinCapabilities();
  const tool = catalog.tools.get(operationName) ?? null;
  if (!tool) {
    return {
      kind: "deny",
      reason: `"${operationName}" is not a supported operation.`,
    };
  }
  const granted = access.grants.get(tool.packageId);
  if (granted === undefined) {
    return {
      kind: "deny",
      reason: `This agent has no access to ${tool.packageDisplayName}. The owner must grant it (and the package must be enabled) first.`,
    };
  }
  // The sensitive-data sandbox caps every grant at read, regardless of the
  // stored level and regardless of any prior approval: this check runs both
  // when a request first arrives and when the worker re-authorizes an
  // approved action just before execution, so enabling the sandbox stops
  // pending drafts/writes too.
  if (
    access.sensitiveDataSandbox &&
    isNetworkBackedExecutor(tool.def.executor)
  ) {
    // The sandbox's no-internet guarantee: MCP/native network-backed tools are
    // denied outright, even at read level — a web-search query is an
    // exfiltration channel for whatever confidential content the agent
    // has already read.
    return {
      kind: "deny",
      reason: `This agent is in the sensitive data sandbox: it cannot use network-backed capability tools like ${tool.name}.`,
    };
  }
  if (access.sensitiveDataSandbox && tool.level !== "read") {
    return {
      kind: "deny",
      reason: `This agent is in the sensitive data sandbox: it may only read from connected apps, and ${tool.name} would ${tool.level === "write" ? "take an external action" : "create content"}.`,
    };
  }
  if (!levelAllows(granted, tool.level)) {
    return {
      kind: "deny",
      reason: `This agent's ${tool.packageDisplayName} access is "${granted}", but ${tool.name} needs "${tool.level}".`,
    };
  }
  const validated = validateParams({ params: tool.def.params }, rawParams);
  if (!validated.ok) {
    return { kind: "deny", reason: `Invalid request: ${validated.error}` };
  }
  const targetSummary = capabilityTarget(tool, validated.params);
  // Externally visible writes never run on the agent's own authority: the
  // owner sees exactly what would happen and decides.
  return {
    kind: tool.level === "write" ? "needs_approval" : "allow",
    op: { app: tool.packageId, name: tool.name, level: tool.level },
    tool,
    params: validated.params,
    targetSummary,
  };
}
