import { Router, type IRouter } from "express";
import {
  agentAppGrantsTable,
  agentsTable,
  db,
  workspaceConnectedAppsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  ListConnectedAppsResponse,
  UpdateConnectedAppBody,
  UpdateConnectedAppParams,
  UpdateConnectedAppResponse,
} from "@workspace/api-zod";
import {
  APP_CATALOG,
  CONNECTED_APP_IDS,
  isConnectedAppId,
} from "../connected-apps/catalog";
import { connectionStatus } from "../connected-apps/connections";
import { recordAudit } from "../audit";
import { publish } from "../events";

const router: IRouter = Router();

/**
 * Inventory of every supported app for the signed-in user's workspace: live
 * connection state of that user's account, the workspace enable switch, and
 * how many of their active agents hold a grant. Status is looked up fresh on
 * every request — connection state belongs to the credential store, and
 * caching it here would let a revoked account look connected.
 */
router.get("/connected-apps", async (req, res): Promise<void> => {
  const wsId = req.workspaceId!;
  const [settings, grantCounts, statuses] = await Promise.all([
    db
      .select()
      .from(workspaceConnectedAppsTable)
      .where(
        and(
          eq(workspaceConnectedAppsTable.workspaceId, wsId),
          inArray(workspaceConnectedAppsTable.app, [...CONNECTED_APP_IDS]),
        ),
      ),
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
    Promise.all(CONNECTED_APP_IDS.map((app) => connectionStatus(app, wsId))),
  ]);
  const enabledByApp = new Map(settings.map((row) => [row.app, row.enabled]));
  const countByApp = new Map(grantCounts.map((row) => [row.app, row.count]));
  res.json(
    ListConnectedAppsResponse.parse({
      apps: CONNECTED_APP_IDS.map((app, index) => ({
        app,
        displayName: APP_CATALOG[app].displayName,
        enabled: enabledByApp.get(app) ?? true,
        status: statuses[index].status,
        statusDetail: statuses[index].detail,
        accountLabel: statuses[index].accountLabel,
        grantedAgents: countByApp.get(app) ?? 0,
      })),
    }),
  );
});

router.patch("/connected-apps/:app", async (req, res): Promise<void> => {
  const params = UpdateConnectedAppParams.safeParse(req.params);
  const body = UpdateConnectedAppBody.safeParse(req.body);
  if (!params.success || !body.success || !isConnectedAppId(params.data.app)) {
    res.status(400).json({ error: "Invalid connected-app update" });
    return;
  }
  const wsId = req.workspaceId!;
  const app = params.data.app;
  const enabled = body.data.enabled;
  await db.transaction(async (tx) => {
    await tx
      .insert(workspaceConnectedAppsTable)
      .values({ workspaceId: wsId, app, enabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [
          workspaceConnectedAppsTable.workspaceId,
          workspaceConnectedAppsTable.app,
        ],
        set: { enabled, updatedAt: new Date() },
      });
    await recordAudit(
      wsId,
      enabled ? "connected_app.enabled" : "connected_app.disabled",
      `${APP_CATALOG[app].displayName} was ${enabled ? "enabled" : "disabled"} for all agents in this workspace.`,
      tx,
    );
  });
  publish(wsId, "agents", "overview");
  const [status, grantCount] = await Promise.all([
    connectionStatus(app, wsId),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentAppGrantsTable)
      .innerJoin(agentsTable, eq(agentAppGrantsTable.agentId, agentsTable.id))
      .where(
        and(
          eq(agentAppGrantsTable.app, app),
          eq(agentsTable.workspaceId, wsId),
          eq(agentsTable.retired, false),
          eq(agentsTable.archived, false),
        ),
      ),
  ]);
  res.json(
    UpdateConnectedAppResponse.parse({
      app,
      displayName: APP_CATALOG[app].displayName,
      enabled,
      status: status.status,
      statusDetail: status.detail,
      accountLabel: status.accountLabel,
      grantedAgents: grantCount[0]?.count ?? 0,
    }),
  );
});

export default router;
