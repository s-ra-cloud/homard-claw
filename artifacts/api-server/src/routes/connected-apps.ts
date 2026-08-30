import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  agentAppGrantsTable,
  agentsTable,
  customApiConnectionsTable,
  db,
  workspaceConnectedAppsTable,
  type CustomApiConnectionRecord,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  CreateCustomApiBody,
  CreateCustomApiResponse,
  DeleteCustomApiParams,
  DeleteCustomApiResponse,
  ListConnectedAppsResponse,
  ListCustomApisResponse,
  ParseCustomApiSpecBody,
  ParseCustomApiSpecResponse,
  RotateCustomApiCredentialBody,
  RotateCustomApiCredentialParams,
  RotateCustomApiCredentialResponse,
  UpdateConnectedAppBody,
  UpdateConnectedAppParams,
  UpdateConnectedAppResponse,
  UpdateCustomApiBody,
  UpdateCustomApiParams,
  UpdateCustomApiResponse,
  ValidateCustomApiParams,
  ValidateCustomApiResponse,
} from "@workspace/api-zod";
import {
  APP_CATALOG,
  CONNECTED_APP_IDS,
  isConnectedAppId,
} from "../connected-apps/catalog";
import { connectionStatus } from "../connected-apps/connections";
import { validateCustomApiConnection } from "../connected-apps/custom-api-executor";
import { expirePendingCustomApiApprovals } from "../connected-apps/custom-api-lifecycle";
import { parseOpenApiDocument } from "../connected-apps/custom-api-spec";
import {
  checkOperation,
  customApiPackageId,
  encryptCustomApiCredential,
  getCustomApiConnection,
  normalizeCustomApiDefinition,
  parseStoredOperations,
  validateCredentialInput,
  type CustomApiOperation,
} from "../connected-apps/custom-apis";
import { findRegistryEntry } from "../capabilities/registry";
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
        status: statuses[index]!.status,
        statusDetail: statuses[index]!.detail,
        accountLabel: statuses[index]!.accountLabel,
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

/* ------------------------------------------------------------------ */
/* Custom APIs: owner-whitelisted third-party REST endpoints            */
/* ------------------------------------------------------------------ */

/** Grant counts per custom package id for active agents of one workspace. */
async function customGrantCounts(
  wsId: string,
  packageIds: string[],
): Promise<Map<string, number>> {
  if (packageIds.length === 0) return new Map();
  const rows = await db
    .select({
      app: agentAppGrantsTable.app,
      count: sql<number>`count(*)::int`,
    })
    .from(agentAppGrantsTable)
    .innerJoin(agentsTable, eq(agentAppGrantsTable.agentId, agentsTable.id))
    .where(
      and(
        inArray(agentAppGrantsTable.app, packageIds),
        eq(agentsTable.workspaceId, wsId),
        eq(agentsTable.retired, false),
        eq(agentsTable.archived, false),
      ),
    )
    .groupBy(agentAppGrantsTable.app);
  return new Map(rows.map((row) => [row.app, row.count]));
}

/**
 * The displayable JSON for one row. The stored secret NEVER leaves the
 * server: only hasCredential says whether one exists.
 */
function toCustomApiJson(
  row: CustomApiConnectionRecord,
  grantedAgents: number,
) {
  return {
    id: row.id,
    slug: row.slug,
    packageId: customApiPackageId(row.slug),
    displayName: row.displayName,
    description: row.description,
    baseUrl: row.baseUrl,
    authType: row.authType,
    authHeaderName: row.authHeaderName,
    hasCredential: row.credentialEnc !== null,
    operations: parseStoredOperations(row) ?? [],
    revision: row.revision,
    enabled: row.enabled,
    validationStatus: row.validationStatus,
    validationDetail: row.validationDetail,
    validatedAt: row.validatedAt ? row.validatedAt.toISOString() : null,
    grantedAgents,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  // Drizzle wraps driver errors, so the Postgres code is on the cause chain.
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && typeof current === "object" && current !== null;
    depth += 1
  ) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

router.get("/connected-apps/custom", async (req, res): Promise<void> => {
  const wsId = req.workspaceId!;
  const rows = await db
    .select()
    .from(customApiConnectionsTable)
    .where(eq(customApiConnectionsTable.workspaceId, wsId))
    .orderBy(customApiConnectionsTable.createdAt);
  const counts = await customGrantCounts(
    wsId,
    rows.map((row) => customApiPackageId(row.slug)),
  );
  res.json(
    ListCustomApisResponse.parse({
      apis: rows.map((row) =>
        toCustomApiJson(row, counts.get(customApiPackageId(row.slug)) ?? 0),
      ),
    }),
  );
});

router.post("/connected-apps/custom", async (req, res): Promise<void> => {
  const body = CreateCustomApiBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid custom API payload" });
    return;
  }
  const wsId = req.workspaceId!;
  const normalized = normalizeCustomApiDefinition(body.data);
  if (!normalized.ok) {
    res.status(400).json({ error: normalized.errors.join(" ") });
    return;
  }
  const definition = normalized.value;
  const packageId = customApiPackageId(definition.slug);
  if (findRegistryEntry(packageId)) {
    res.status(409).json({
      error: `The identifier "${definition.slug}" collides with a built-in package. Pick another.`,
    });
    return;
  }
  let credentialEnc: string | null = null;
  if (definition.authType !== "none") {
    const credential = validateCredentialInput(body.data.credential);
    if (typeof credential !== "string") {
      res.status(400).json({
        error: `${definition.authType === "bearer" ? "Bearer-token" : "API-key"} authentication needs a credential. ${credential.error}`,
      });
      return;
    }
    try {
      credentialEnc = encryptCustomApiCredential(credential);
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "The credential could not be stored.",
      });
      return;
    }
  }
  try {
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(customApiConnectionsTable)
        .values({
          workspaceId: wsId,
          slug: definition.slug,
          displayName: definition.displayName,
          description: definition.description,
          baseUrl: definition.baseUrl,
          authType: definition.authType,
          authHeaderName: definition.authHeaderName,
          credentialEnc,
          operations: definition.operations as unknown as Record<
            string,
            unknown
          >[],
        })
        .returning();
      await recordAudit(
        wsId,
        "custom_api.created",
        `Custom API "${definition.displayName}" (${definition.baseUrl}) was whitelisted with ${definition.operations.length} operation${definition.operations.length === 1 ? "" : "s"}.`,
        tx,
      );
      return inserted!;
    });
    publish(wsId, "agents", "overview");
    res.status(201).json(CreateCustomApiResponse.parse(toCustomApiJson(row, 0)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({
        error: `A custom API with the identifier "${definition.slug}" already exists.`,
      });
      return;
    }
    throw error;
  }
});

router.post(
  "/connected-apps/custom/parse-spec",
  async (req, res): Promise<void> => {
    const body = ParseCustomApiSpecBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid document payload" });
      return;
    }
    const parsed = parseOpenApiDocument(body.data.document);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    // Final gate: every draft must already satisfy the operation contract,
    // so the review form only ever shows operations that can be saved.
    const operations: CustomApiOperation[] = [];
    const warnings = [...parsed.value.warnings];
    for (const draft of parsed.value.operations) {
      const checked = checkOperation(draft);
      if (checked.op) operations.push(checked.op);
      else warnings.push(`Skipped ${draft.method} ${draft.path}: ${checked.errors.join(" ")}`);
    }
    if (operations.length === 0) {
      res.status(400).json({
        error: `No operations could be imported. ${warnings.join(" ")}`.trim(),
      });
      return;
    }
    res.json(
      ParseCustomApiSpecResponse.parse({
        operations,
        warnings,
        suggestedBaseUrl: parsed.value.suggestedBaseUrl,
        suggestedName: parsed.value.suggestedName,
      }),
    );
  },
);

router.patch(
  "/connected-apps/custom/:id",
  async (req, res): Promise<void> => {
    const params = UpdateCustomApiParams.safeParse(req.params);
    const body = UpdateCustomApiBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid custom API update" });
      return;
    }
    const wsId = req.workspaceId!;
    const updates = body.data;
    // The whole read-merge-write runs against a FOR UPDATE-locked row so a
    // concurrent PATCH cannot interleave: without the lock, a tab holding a
    // stale copy could write back the pre-disable enabled flag or the old
    // revision, silently resurrecting approvals the owner just invalidated.
    // Every derived value below (diff, bump, disable fence) comes from the
    // row as it exists at commit time, never from an earlier read.
    const outcome = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(customApiConnectionsTable)
        .where(
          and(
            eq(customApiConnectionsTable.id, params.data.id),
            eq(customApiConnectionsTable.workspaceId, wsId),
          ),
        )
        .limit(1)
        .for("update");
      if (!existing) {
        return { status: 404 as const, error: "No such custom API" };
      }
      // Re-validate the MERGED definition: a partial update can never sneak
      // the row into a state the create validation would have rejected.
      const merged = normalizeCustomApiDefinition({
        slug: existing.slug,
        displayName: updates.displayName ?? existing.displayName,
        description:
          updates.description !== undefined
            ? updates.description
            : existing.description,
        baseUrl: updates.baseUrl ?? existing.baseUrl,
        authType: updates.authType ?? existing.authType,
        authHeaderName:
          updates.authHeaderName !== undefined
            ? updates.authHeaderName
            : updates.authType !== undefined && updates.authType !== "api_key"
              ? null
              : existing.authHeaderName,
        operations: updates.operations ?? existing.operations,
      });
      if (!merged.ok) {
        return { status: 400 as const, error: merged.errors.join(" ") };
      }
      const definition = merged.value;
      // Only a REAL definition change bumps the revision (and thereby kills
      // pending approvals): resubmitting the form unchanged must be harmless.
      const definitionTouched =
        JSON.stringify({
          displayName: definition.displayName,
          description: definition.description,
          baseUrl: definition.baseUrl,
          authType: definition.authType,
          authHeaderName: definition.authHeaderName,
          operations: definition.operations,
        }) !==
        JSON.stringify({
          displayName: existing.displayName,
          description: existing.description,
          baseUrl: existing.baseUrl,
          authType: existing.authType,
          authHeaderName: existing.authHeaderName,
          operations: parseStoredOperations(existing) ?? [],
        });
      let credentialEnc = existing.credentialEnc;
      if (definition.authType === "none") {
        // Auth removed: the old secret must not linger in the database.
        credentialEnc = null;
      } else if (
        updates.credential !== undefined &&
        updates.credential !== null &&
        updates.credential !== ""
      ) {
        const credential = validateCredentialInput(updates.credential);
        if (typeof credential !== "string") {
          return { status: 400 as const, error: credential.error };
        }
        try {
          credentialEnc = encryptCustomApiCredential(credential);
        } catch (error) {
          return {
            status: 400 as const,
            error:
              error instanceof Error
                ? error.message
                : "The credential could not be stored.",
          };
        }
      }
      const enabled = updates.enabled ?? existing.enabled;
      const disabling = existing.enabled && !enabled;
      // Disabling also bumps the revision so it is an IRREVERSIBLE fence for
      // anything approved beforehand: a quick disable→enable can never
      // restore compatibility with an old approved action, because the claim
      // UPDATE and the executor both pin the exact revision that was
      // reviewed.
      const revisionBump = definitionTouched || disabling;
      const revision = revisionBump ? randomUUID() : existing.revision;
      const [row] = await tx
        .update(customApiConnectionsTable)
        .set({
          displayName: definition.displayName,
          description: definition.description,
          baseUrl: definition.baseUrl,
          authType: definition.authType,
          authHeaderName: definition.authHeaderName,
          credentialEnc,
          operations: definition.operations as unknown as Record<
            string,
            unknown
          >[],
          revision,
          enabled,
          // A changed definition or auth shape invalidates the last probe.
          ...(definitionTouched
            ? {
                validationStatus: "unchecked",
                validationDetail: null,
                validatedAt: null,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(customApiConnectionsTable.id, existing.id),
            eq(customApiConnectionsTable.workspaceId, wsId),
          ),
        )
        .returning();
      return {
        status: 200 as const,
        row: row!,
        packageId: customApiPackageId(existing.slug),
        definition,
        definitionTouched,
        disabling,
        revisionBump,
        enabling: !existing.enabled && enabled,
      };
    });
    if (outcome.status !== 200) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    // Pending approvals bound to the previous definition (or to an API the
    // owner just switched off) must never execute. The sweep runs after the
    // locked update commits: any claim racing in between fails the live-row
    // revision fence and stays approved for this sweep to settle.
    if (outcome.revisionBump) {
      await expirePendingCustomApiApprovals(
        wsId,
        outcome.packageId,
        outcome.disabling
          ? `The owner disabled the "${outcome.definition.displayName}" API before this action ran. Request it again once the API is re-enabled.`
          : `The owner changed the "${outcome.definition.displayName}" API definition, so the previously requested action no longer matches what was reviewed. Request it again if it is still needed.`,
      );
    }
    await recordAudit(
      wsId,
      "custom_api.updated",
      `Custom API "${outcome.definition.displayName}" was ${
        outcome.disabling
          ? "disabled"
          : outcome.enabling
            ? "enabled"
            : "updated"
      }${outcome.definitionTouched ? " (definition revised; pending approvals for it were invalidated)" : ""}.`,
    );
    publish(wsId, "agents", "overview");
    const counts = await customGrantCounts(wsId, [outcome.packageId]);
    res.json(
      UpdateCustomApiResponse.parse(
        toCustomApiJson(outcome.row, counts.get(outcome.packageId) ?? 0),
      ),
    );
  },
);

router.post(
  "/connected-apps/custom/:id/credential",
  async (req, res): Promise<void> => {
    const params = RotateCustomApiCredentialParams.safeParse(req.params);
    const body = RotateCustomApiCredentialBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid credential rotation" });
      return;
    }
    const wsId = req.workspaceId!;
    const existing = await getCustomApiConnection(wsId, params.data.id);
    if (!existing) {
      res.status(404).json({ error: "No such custom API" });
      return;
    }
    if (existing.authType === "none") {
      res.status(400).json({
        error:
          "This API uses no authentication. Switch it to API key or bearer token first.",
      });
      return;
    }
    const credential = validateCredentialInput(body.data.credential);
    if (typeof credential !== "string") {
      res.status(400).json({ error: credential.error });
      return;
    }
    let credentialEnc: string;
    try {
      credentialEnc = encryptCustomApiCredential(credential);
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "The credential could not be stored.",
      });
      return;
    }
    // Rotation deliberately does NOT bump the definition revision: the
    // reviewed operations are unchanged, they just run with the new secret
    // — which takes effect for background tasks on their very next call.
    const [row] = await db
      .update(customApiConnectionsTable)
      .set({
        credentialEnc,
        validationStatus: "unchecked",
        validationDetail: null,
        validatedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customApiConnectionsTable.id, existing.id),
          eq(customApiConnectionsTable.workspaceId, wsId),
        ),
      )
      .returning();
    await recordAudit(
      wsId,
      "custom_api.credential_rotated",
      `The credential for custom API "${existing.displayName}" was rotated.`,
    );
    publish(wsId, "agents", "overview");
    const packageId = customApiPackageId(existing.slug);
    const counts = await customGrantCounts(wsId, [packageId]);
    res.json(
      RotateCustomApiCredentialResponse.parse(
        toCustomApiJson(row!, counts.get(packageId) ?? 0),
      ),
    );
  },
);

router.post(
  "/connected-apps/custom/:id/validate",
  async (req, res): Promise<void> => {
    const params = ValidateCustomApiParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid custom API id" });
      return;
    }
    const wsId = req.workspaceId!;
    const existing = await getCustomApiConnection(wsId, params.data.id);
    if (!existing) {
      res.status(404).json({ error: "No such custom API" });
      return;
    }
    const outcome = await validateCustomApiConnection(existing);
    const validatedAt = new Date();
    await db
      .update(customApiConnectionsTable)
      .set({
        validationStatus: outcome.ok ? "ok" : "failed",
        validationDetail: outcome.detail,
        validatedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customApiConnectionsTable.id, existing.id),
          eq(customApiConnectionsTable.workspaceId, wsId),
        ),
      );
    publish(wsId, "agents", "overview");
    res.json(
      ValidateCustomApiResponse.parse({
        status: outcome.ok ? "ok" : "failed",
        detail: outcome.detail,
        validatedAt: validatedAt.toISOString(),
      }),
    );
  },
);

router.delete(
  "/connected-apps/custom/:id",
  async (req, res): Promise<void> => {
    const params = DeleteCustomApiParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid custom API id" });
      return;
    }
    const wsId = req.workspaceId!;
    const existing = await getCustomApiConnection(wsId, params.data.id);
    if (!existing) {
      res.status(404).json({ error: "No such custom API" });
      return;
    }
    const packageId = customApiPackageId(existing.slug);
    // Delete the row FIRST: the connection row is the durable fence that the
    // worker's claim UPDATE and the executor's final boundary both re-check,
    // so once this commit lands no approved action for the old definition
    // can transition to executing. Expiring approvals afterwards is then
    // pure cleanup — a claim racing in between fails on the missing row and
    // leaves the action approved for the expiry sweep below to settle.
    const removedGrants = await db.transaction(async (tx) => {
      const workspaceAgents = tx
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(eq(agentsTable.workspaceId, wsId));
      const deletedGrants = await tx
        .delete(agentAppGrantsTable)
        .where(
          and(
            eq(agentAppGrantsTable.app, packageId),
            inArray(agentAppGrantsTable.agentId, workspaceAgents),
          ),
        )
        .returning({ agentId: agentAppGrantsTable.agentId });
      await tx
        .delete(customApiConnectionsTable)
        .where(
          and(
            eq(customApiConnectionsTable.id, existing.id),
            eq(customApiConnectionsTable.workspaceId, wsId),
          ),
        );
      await recordAudit(
        wsId,
        "custom_api.deleted",
        `Custom API "${existing.displayName}" (${existing.baseUrl}) was removed along with ${deletedGrants.length} agent grant${deletedGrants.length === 1 ? "" : "s"}.`,
        tx,
      );
      return deletedGrants.length;
    });
    const expiredApprovals = await expirePendingCustomApiApprovals(
      wsId,
      packageId,
      `The owner removed the "${existing.displayName}" API before this action ran.`,
    );
    publish(wsId, "agents", "overview");
    res.json(
      DeleteCustomApiResponse.parse({
        deleted: true,
        removedGrants,
        expiredApprovals,
      }),
    );
  },
);

export default router;
