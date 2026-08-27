import { Router, type IRouter } from "express";
import {
  agentAppGrantsTable,
  agentsTable,
  db,
  workspaceConnectedAppsTable,
  type CapabilityPackageRecord,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  UpdateCapabilityBody,
  UpdateCapabilityParams,
} from "@workspace/api-zod";
import { recordAudit } from "../audit";
import { publish } from "../events";
import { connectionStatus } from "../connected-apps/connections";
import type { ConnectedAppId } from "../connected-apps/catalog";
import {
  isCapabilityManifest,
  type CapabilityManifest,
} from "../capabilities/manifest";
import {
  findRegistryEntry,
  isBuiltinPackageId,
  listRegistryEntries,
} from "../capabilities/registry";
import {
  applyPendingUpdate,
  installPackage,
  listInstallRows,
  refreshInstallRow,
  uninstallPackage,
} from "../capabilities/service";
import { mcpListTools, resolveMcpEndpoint } from "../capabilities/mcp";
import { nativeWebConfigured } from "../capabilities/web";

const router: IRouter = Router();

/**
 * The Capabilities surface: every vetted package the registry offers, with
 * this workspace's install state, pinned version, tool inventory (identity,
 * risk level, recovery class), connection health, and any pending
 * permission-expanding update awaiting the owner's review.
 */

type PackageHealth = {
  status:
    "connected" | "expired" | "not_connected" | "unavailable" | "none_required";
  detail: string | null;
};

async function packageHealth(
  manifest: CapabilityManifest,
  workspaceId: string,
): Promise<PackageHealth> {
  if (
    manifest.tools.some(
      (tool) =>
        tool.executor.kind === "native" &&
        tool.executor.handler.startsWith("web."),
    )
  ) {
    return nativeWebConfigured()
      ? { status: "connected", detail: null }
      : {
          status: "not_connected",
          detail:
            "Web Research is not configured on this deployment (WEB_SEARCH_API_KEY is missing).",
        };
  }
  if (manifest.connection === "none") {
    return { status: "none_required", detail: null };
  }
  if (manifest.connection === "mcp") {
    let endpoint;
    try {
      endpoint = resolveMcpEndpoint(manifest.mcpServer);
    } catch (error) {
      return {
        status: "unavailable",
        detail:
          error instanceof Error ? error.message : "Misconfigured endpoint.",
      };
    }
    if (!endpoint) {
      return {
        status: "not_connected",
        detail:
          "The package's server endpoint is not configured on this deployment yet.",
      };
    }
    const listed = await mcpListTools(endpoint);
    if (!listed.ok) return { status: "unavailable", detail: listed.message };
    // Schema drift check: every pinned remote tool must still be advertised.
    const remoteNames = new Set(listed.tools.map((t) => t.name));
    const missing = manifest.tools
      .filter(
        (t) =>
          t.executor.kind === "mcp" && !remoteNames.has(t.executor.remoteName),
      )
      .map((t) => t.name);
    if (missing.length > 0) {
      return {
        status: "unavailable",
        detail: `The server no longer advertises: ${missing.join(", ")}. These tools will fail until the package is updated.`,
      };
    }
    return { status: "connected", detail: null };
  }
  const status = await connectionStatus(
    manifest.connection as ConnectedAppId,
    workspaceId,
  );
  return { status: status.status, detail: status.detail ?? null };
}

function toolJson(manifest: CapabilityManifest) {
  return manifest.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    level: tool.level,
    recovery: tool.recovery,
    needsApproval: tool.level === "write",
  }));
}

function skillJson(manifest: CapabilityManifest) {
  return manifest.skills.map((skill) => ({
    id: skill.id,
    title: skill.title,
    triggers: skill.triggers,
  }));
}

router.get("/capabilities", async (req, res): Promise<void> => {
  const wsId = req.workspaceId!;
  const [rows, enabledRows, grantCounts] = await Promise.all([
    listInstallRows(wsId),
    db
      .select()
      .from(workspaceConnectedAppsTable)
      .where(eq(workspaceConnectedAppsTable.workspaceId, wsId)),
    db
      .select({
        app: agentAppGrantsTable.app,
        count: sql<number>`count(*)::int`,
      })
      .from(agentAppGrantsTable)
      .innerJoin(agentsTable, eq(agentAppGrantsTable.agentId, agentsTable.id))
      .where(
        and(
          eq(agentsTable.workspaceId, wsId),
          eq(agentsTable.retired, false),
          eq(agentsTable.archived, false),
        ),
      )
      .groupBy(agentAppGrantsTable.app),
  ]);
  const disabled = new Set(
    enabledRows.filter((row) => !row.enabled).map((row) => row.app),
  );
  const grants = new Map(grantCounts.map((row) => [row.app, row.count]));
  const installByPackage = new Map<string, CapabilityPackageRecord>(
    rows.map((row) => [row.packageId, row]),
  );

  const packages = await Promise.all(
    listRegistryEntries().map(async (entry) => {
      const registry = entry.manifest;
      let row = installByPackage.get(registry.id) ?? null;
      if (row && !registry.builtin) {
        // Reconcile against the registry on every listing: quarantine on
        // drift, park expanding updates, apply harmless ones.
        row = await refreshInstallRow(row);
      }
      const installed = registry.builtin || row !== null;
      const pinned: CapabilityManifest =
        !registry.builtin && row && isCapabilityManifest(row.manifest)
          ? (row.manifest as unknown as CapabilityManifest)
          : registry;
      const status = registry.builtin
        ? "active"
        : (row?.status ?? "not_installed");
      const usable = installed && status === "active";
      const health = usable
        ? await packageHealth(pinned, wsId)
        : { status: "not_connected" as const, detail: null };
      return {
        packageId: registry.id,
        displayName: registry.displayName,
        description: registry.description,
        publisher: registry.publisher,
        builtin: registry.builtin,
        connection: registry.connection,
        installed,
        installedVersion: registry.builtin
          ? registry.version
          : (row?.installedVersion ?? null),
        registryVersion: registry.version,
        status,
        enabled: !disabled.has(registry.id),
        quarantineReason: row?.quarantineReason ?? null,
        pendingVersion: row?.pendingVersion ?? null,
        pendingDiff:
          (row?.pendingDiff as Record<string, unknown> | null) ?? null,
        health: health.status,
        healthDetail: health.detail,
        grantedAgents: grants.get(registry.id) ?? 0,
        tools: toolJson(pinned),
        skills: skillJson(pinned),
      };
    }),
  );
  res.json({ packages });
});

router.post(
  "/capabilities/:packageId/install",
  async (req, res): Promise<void> => {
    const wsId = req.workspaceId!;
    const packageId = req.params.packageId;
    const outcome = await installPackage(wsId, packageId);
    if (!outcome.ok) {
      const message =
        outcome.error === "unknown_package"
          ? "This package is not in the vetted registry."
          : outcome.error === "builtin"
            ? "Built-in packages are always installed."
            : "This package is already installed.";
      res
        .status(outcome.error === "unknown_package" ? 404 : 409)
        .json({ error: message });
      return;
    }
    publish(wsId, "agents", "overview");
    res.status(201).json({ installed: true });
  },
);

router.post(
  "/capabilities/:packageId/update",
  async (req, res): Promise<void> => {
    const wsId = req.workspaceId!;
    const outcome = await applyPendingUpdate(wsId, req.params.packageId);
    if (!outcome.ok) {
      const message =
        outcome.error === "not_installed"
          ? "This package is not installed."
          : outcome.error === "no_pending_update"
            ? "There is no update awaiting review."
            : "The registry changed since this update was offered — review it again.";
      res
        .status(outcome.error === "not_installed" ? 404 : 409)
        .json({ error: message });
      return;
    }
    publish(wsId, "agents", "overview");
    res.json({ updated: true });
  },
);

router.post(
  "/capabilities/:packageId/uninstall",
  async (req, res): Promise<void> => {
    const wsId = req.workspaceId!;
    if (isBuiltinPackageId(req.params.packageId)) {
      res
        .status(409)
        .json({ error: "Built-in packages cannot be uninstalled." });
      return;
    }
    const outcome = await uninstallPackage(wsId, req.params.packageId);
    if (!outcome.ok) {
      res.status(404).json({ error: "This package is not installed." });
      return;
    }
    publish(wsId, "agents", "overview");
    res.json({ uninstalled: true });
  },
);

/** Enable/disable a package for every agent at once (same switch as apps). */
router.patch("/capabilities/:packageId", async (req, res): Promise<void> => {
  const wsId = req.workspaceId!;
  const params = UpdateCapabilityParams.safeParse(req.params);
  const body = UpdateCapabilityBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const packageId = params.data.packageId;
  if (!findRegistryEntry(packageId)) {
    res.status(404).json({ error: "Unknown package" });
    return;
  }
  const enabled = body.data.enabled;
  await db
    .insert(workspaceConnectedAppsTable)
    .values({ workspaceId: wsId, app: packageId, enabled })
    .onConflictDoUpdate({
      target: [
        workspaceConnectedAppsTable.workspaceId,
        workspaceConnectedAppsTable.app,
      ],
      set: { enabled, updatedAt: new Date() },
    });
  await recordAudit(
    wsId,
    enabled ? "capability.enabled" : "capability.disabled",
    `The "${packageId}" capability package was ${enabled ? "enabled" : "disabled"} for all agents.`,
  );
  publish(wsId, "agents", "overview");
  res.json({ packageId, enabled });
});

export default router;
