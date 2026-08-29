/**
 * Custom API route + integration coverage:
 *  - owner CRUD: create/list/update/rotate/validate/delete, with the saved
 *    secret never appearing in ANY response
 *  - duplicate slugs 409, invalid definitions 400 with actionable errors
 *  - workspace tenancy: a foreign workspace's ids are 404, never 403
 *  - grants: custom package ids are grantable per agent and default to none
 *  - capability integration: enabled custom APIs resolve as workspace
 *    packages; disabling removes them; the sensitive-data sandbox denies
 *    them outright
 *  - lifecycle: editing or disabling a definition expires pending
 *    approvals and unblocks parked tasks
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md):
 * impersonate a fresh workspace owner, tag and clean up all created rows.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentAppGrantsTable,
  agentsTable,
  appActionsTable,
  approvalsTable,
  customApiConnectionsTable,
  db,
  tasksTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({
  userId: "custom-api-owner" as string | null,
  emails: {} as Record<string, string>,
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
  clerkClient: {
    users: {
      getUser: async (id: string) => {
        const email = authState.emails[id];
        if (!email) throw new Error("no such user");
        return {
          primaryEmailAddress: {
            emailAddress: email,
            verification: { status: "verified" },
          },
        };
      },
    },
  },
}));

import officeRouter from "./office";
import { loadWorkspaceCapabilities } from "../capabilities/service";
import { claimApprovedAction } from "../connected-apps/actions";
import { authorizeAppAction } from "../connected-apps/authorize";
import { executeCustomApiTool } from "../connected-apps/custom-api-executor";
import { customApiPackageId } from "../connected-apps/custom-apis";
import type { AppAccessLevel } from "@workspace/db";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `Custom API Test ${Date.now()}`;
let workspaceId: string;
let otherWorkspaceId: string;
let otherClerkId: string;
let ownClerkId: string;
const createdAgentIds: string[] = [];

const SECRET = "sk-test-super-secret-abc123";

function apiBody(overrides: Record<string, unknown> = {}) {
  return {
    slug: "acme",
    displayName: `Acme ${RUN_TAG}`,
    description: "Test API",
    baseUrl: "https://api.acme.example/v1",
    authType: "bearer",
    credential: SECRET,
    operations: [
      {
        id: "get_item",
        method: "GET",
        path: "/items/{id}",
        description: "Fetch one item",
        level: "read",
        params: [
          { name: "id", in: "path", kind: "string", required: true },
        ],
      },
      {
        id: "create_item",
        method: "POST",
        path: "/items",
        description: "Create an item",
        level: "write",
        params: [
          {
            name: "title",
            in: "body",
            kind: "string",
            required: true,
            maxLength: 200,
          },
        ],
      },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "custom-api-routes-test-secret");
  ownClerkId = `custom-api-routes-${Date.now()}`;
  const [workspace] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: ownClerkId })
    .returning();
  workspaceId = workspace.id;
  otherClerkId = `custom-api-routes-other-${Date.now()}`;
  const [other] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: otherClerkId })
    .returning();
  otherWorkspaceId = other.id;
  authState.userId = ownClerkId;
});

afterAll(async () => {
  if (createdAgentIds.length > 0) {
    await db
      .delete(agentAppGrantsTable)
      .where(inArray(agentAppGrantsTable.agentId, createdAgentIds));
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db
      .delete(agentsTable)
      .where(inArray(agentsTable.id, createdAgentIds));
  }
  await db
    .delete(customApiConnectionsTable)
    .where(eq(customApiConnectionsTable.workspaceId, workspaceId));
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  await db
    .delete(workspacesTable)
    .where(eq(workspacesTable.id, otherWorkspaceId));
  vi.unstubAllEnvs();
});

describe("custom API management routes", () => {
  let apiId: string;
  let firstRevision: string;

  it("creates a custom API and NEVER echoes the credential", async () => {
    const res = await request(app)
      .post("/api/connected-apps/custom")
      .send(apiBody());
    expect(res.status).toBe(201);
    apiId = res.body.id;
    firstRevision = res.body.revision;
    expect(res.body).toMatchObject({
      slug: "acme",
      packageId: "custom_acme",
      authType: "bearer",
      hasCredential: true,
      enabled: true,
      validationStatus: "unchecked",
      grantedAgents: 0,
    });
    expect(res.body.operations).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it("rejects a duplicate slug with 409 and an invalid definition with 400", async () => {
    const dup = await request(app)
      .post("/api/connected-apps/custom")
      .send(apiBody());
    expect(dup.status).toBe(409);

    const badUrl = await request(app)
      .post("/api/connected-apps/custom")
      .send(apiBody({ slug: "acme2", baseUrl: "http://api.acme.example" }));
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.error).toMatch(/https/);

    const noCredential = await request(app)
      .post("/api/connected-apps/custom")
      .send(apiBody({ slug: "acme3", credential: undefined }));
    expect(noCredential.status).toBe(400);
    expect(noCredential.body.error).toMatch(/credential/i);
  });

  it("lists custom APIs without any secret material", async () => {
    const res = await request(app).get("/api/connected-apps/custom");
    expect(res.status).toBe(200);
    const mine = res.body.apis.find(
      (entry: { id: string }) => entry.id === apiId,
    );
    expect(mine).toBeDefined();
    expect(mine.hasCredential).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it("resolves the enabled API as a workspace capability package", async () => {
    const capabilities = await loadWorkspaceCapabilities(workspaceId);
    expect(capabilities.packages.has("custom_acme")).toBe(true);
    const tool = capabilities.tools.get("custom_acme.get_item");
    expect(tool).toBeDefined();
    expect(tool!.manifest.version).toBe(firstRevision);
    // The model-facing description carries the operation contract, never
    // any credential material.
    expect(tool!.description).toContain("GET /items/{id}");
  });

  it("authorizes via grants (default none), gates writes, and sandbox-denies", async () => {
    const capabilities = await loadWorkspaceCapabilities(workspaceId);
    const noGrant = authorizeAppAction(
      { grants: new Map(), sensitiveDataSandbox: false, capabilities },
      "custom_acme.get_item",
      { id: "1" },
    );
    expect(noGrant.kind).toBe("deny");

    const grants = new Map<string, AppAccessLevel>([["custom_acme", "write"]]);
    const read = authorizeAppAction(
      { grants, sensitiveDataSandbox: false, capabilities },
      "custom_acme.get_item",
      { id: "1" },
    );
    expect(read.kind).toBe("allow");
    const write = authorizeAppAction(
      { grants, sensitiveDataSandbox: false, capabilities },
      "custom_acme.create_item",
      { title: "hello" },
    );
    expect(write.kind).toBe("needs_approval");
    // The sandbox denies network-backed custom APIs even at read level.
    const sandboxed = authorizeAppAction(
      { grants, sensitiveDataSandbox: true, capabilities },
      "custom_acme.get_item",
      { id: "1" },
    );
    expect(sandboxed.kind).toBe("deny");
  });

  it("grants custom APIs per agent through the personnel-file payload", async () => {
    const res = await request(app)
      .post("/api/agents")
      .send({
        name: `Granted ${RUN_TAG}`,
        title: "Analyst",
        mission: "Exercise custom API grants for the test suite.",
        provider: "claude_max",
        securityPreset: "assistant",
        avatar: {
          shellColor: "#C34428",
          deskStyle: "standard",
          accessory: "none",
        },
        appGrants: [{ app: "custom_acme", accessLevel: "read" }],
      });
    expect(res.status).toBe(201);
    createdAgentIds.push(res.body.id);
    const grantRows = await db
      .select()
      .from(agentAppGrantsTable)
      .where(eq(agentAppGrantsTable.agentId, res.body.id));
    expect(grantRows).toHaveLength(1);
    expect(grantRows[0]).toMatchObject({
      app: "custom_acme",
      accessLevel: "read",
    });
  });

  it("is invisible to other workspaces (list, update, rotate, delete all 404)", async () => {
    authState.userId = otherClerkId;
    try {
      const list = await request(app).get("/api/connected-apps/custom");
      expect(list.status).toBe(200);
      expect(
        list.body.apis.find((entry: { id: string }) => entry.id === apiId),
      ).toBeUndefined();
      const patch = await request(app)
        .patch(`/api/connected-apps/custom/${apiId}`)
        .send({ enabled: false });
      expect(patch.status).toBe(404);
      const rotate = await request(app)
        .post(`/api/connected-apps/custom/${apiId}/credential`)
        .send({ credential: "stolen" });
      expect(rotate.status).toBe(404);
      const del = await request(app).delete(
        `/api/connected-apps/custom/${apiId}`,
      );
      expect(del.status).toBe(404);
    } finally {
      authState.userId = ownClerkId;
    }
    // Nothing changed.
    const [row] = await db
      .select()
      .from(customApiConnectionsTable)
      .where(eq(customApiConnectionsTable.id, apiId));
    expect(row.enabled).toBe(true);
  });

  it("rotates the credential without bumping the definition revision", async () => {
    const res = await request(app)
      .post(`/api/connected-apps/custom/${apiId}/credential`)
      .send({ credential: "sk-rotated-9876" });
    expect(res.status).toBe(200);
    expect(res.body.revision).toBe(firstRevision);
    expect(res.body.hasCredential).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("sk-rotated-9876");
  });

  it("expires pending approvals and unblocks parked tasks when the definition changes", async () => {
    // Seed an agent with a parked write awaiting approval.
    const agentRes = await request(app)
      .post("/api/agents")
      .send({
        name: `Parked ${RUN_TAG}`,
        title: "Writer",
        mission: "Hold a pending custom-API approval for the test suite.",
        provider: "claude_max",
        securityPreset: "assistant",
        avatar: {
          shellColor: "#C34428",
          deskStyle: "standard",
          accessory: "none",
        },
        appGrants: [{ app: "custom_acme", accessLevel: "write" }],
      });
    expect(agentRes.status).toBe(201);
    const agentId = agentRes.body.id;
    createdAgentIds.push(agentId);
    const [task] = await db
      .insert(tasksTable)
      .values({
        workspaceId,
        agentId,
        objective: `Custom API approval test ${RUN_TAG}`,
        provider: "claude_max",
        status: "waiting_approval",
      })
      .returning();
    const [approval] = await db
      .insert(approvalsTable)
      .values({
        agentId,
        taskId: task.id,
        kind: "app_action",
        action: "custom_acme.create_item",
        details: "Create an item",
        status: "pending",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    await db.insert(appActionsTable).values({
      taskId: task.id,
      agentId,
      app: "custom_acme",
      operation: "custom_acme.create_item",
      params: { title: "x" },
      targetSummary: "Acme: POST /items",
      status: "waiting_approval",
      approvalId: approval.id,
      definitionRevision: firstRevision,
    });

    // Owner edits the definition (adds an operation description change).
    const body = apiBody();
    (body.operations[0] as { description: string }).description =
      "Fetch one item by id";
    const res = await request(app)
      .patch(`/api/connected-apps/custom/${apiId}`)
      .send({ operations: body.operations });
    expect(res.status).toBe(200);
    expect(res.body.revision).not.toBe(firstRevision);
    // The probe status resets: the reviewed surface changed.
    expect(res.body.validationStatus).toBe("unchecked");

    const [expiredApproval] = await db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.id, approval.id));
    expect(expiredApproval.status).toBe("expired");
    const [expiredAction] = await db
      .select()
      .from(appActionsTable)
      .where(eq(appActionsTable.approvalId, approval.id));
    expect(expiredAction.status).toBe("expired");
    const [blockedTask] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id));
    expect(blockedTask.status).toBe("blocked");
    expect(blockedTask.errorKind).toBe("approval_expired");
  });

  it("resubmitting an unchanged definition does NOT bump the revision", async () => {
    const before = await request(app).get("/api/connected-apps/custom");
    const mine = before.body.apis.find(
      (entry: { id: string }) => entry.id === apiId,
    );
    const res = await request(app)
      .patch(`/api/connected-apps/custom/${apiId}`)
      .send({ operations: mine.operations, displayName: mine.displayName });
    expect(res.status).toBe(200);
    expect(res.body.revision).toBe(mine.revision);
  });

  it("disabling removes the package from the workspace catalog immediately", async () => {
    const res = await request(app)
      .patch(`/api/connected-apps/custom/${apiId}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    const capabilities = await loadWorkspaceCapabilities(workspaceId);
    expect(capabilities.packages.has("custom_acme")).toBe(false);
    expect(capabilities.tools.get("custom_acme.get_item")).toBeUndefined();
    // Grants to it stop counting while disabled.
    const verdict = authorizeAppAction(
      {
        grants: new Map<string, AppAccessLevel>([["custom_acme", "write"]]),
        sensitiveDataSandbox: false,
        capabilities,
      },
      "custom_acme.get_item",
      { id: "1" },
    );
    expect(verdict.kind).toBe("deny");
    // Re-enable for the remaining tests.
    const enable = await request(app)
      .patch(`/api/connected-apps/custom/${apiId}`)
      .send({ enabled: true });
    expect(enable.status).toBe(200);
  });

  it("parses an OpenAPI JSON document into reviewable drafts without saving", async () => {
    const res = await request(app)
      .post("/api/connected-apps/custom/parse-spec")
      .send({
        document: JSON.stringify({
          openapi: "3.0.0",
          info: { title: "Draft API" },
          servers: [{ url: "https://draft.example.com" }],
          paths: {
            "/widgets": {
              get: { operationId: "listWidgets", summary: "List widgets" },
            },
          },
        }),
      });
    expect(res.status).toBe(200);
    expect(res.body.operations).toHaveLength(1);
    expect(res.body.operations[0]).toMatchObject({
      id: "list_widgets",
      method: "GET",
      level: "read",
    });
    expect(res.body.suggestedBaseUrl).toBe("https://draft.example.com");
    // Nothing was persisted.
    const list = await request(app).get("/api/connected-apps/custom");
    expect(
      list.body.apis.filter(
        (entry: { slug: string }) => entry.slug !== "acme",
      ),
    ).toHaveLength(0);

    const yaml = await request(app)
      .post("/api/connected-apps/custom/parse-spec")
      .send({ document: "openapi: 3.0.0" });
    expect(yaml.status).toBe(400);
    expect(yaml.body.error).toMatch(/JSON/);
  });

  it("a worker claim can never race an owner delete into an outbound call", async () => {
    // Dedicated API so the shared fixture's lifecycle stays untouched.
    const created = await request(app)
      .post("/api/connected-apps/custom")
      .send(apiBody({ slug: "racer", displayName: `Racer ${RUN_TAG}` }));
    expect(created.status).toBe(201);
    const raceApiId: string = created.body.id;
    const raceRevision: string = created.body.revision;
    const racePackage = customApiPackageId("racer");

    const agentRes = await request(app)
      .post("/api/agents")
      .send({
        name: `Racer ${RUN_TAG}`,
        title: "Writer",
        mission: "Hold an approved custom-API write for the race test.",
        provider: "claude_max",
        securityPreset: "assistant",
        avatar: {
          shellColor: "#C34428",
          deskStyle: "standard",
          accessory: "none",
        },
        appGrants: [{ app: racePackage, accessLevel: "write" }],
      });
    expect(agentRes.status).toBe(201);
    const agentId: string = agentRes.body.id;
    createdAgentIds.push(agentId);
    const [task] = await db
      .insert(tasksTable)
      .values({
        workspaceId,
        agentId,
        objective: `Custom API race test ${RUN_TAG}`,
        provider: "claude_max",
        status: "working",
      })
      .returning();
    const [approval] = await db
      .insert(approvalsTable)
      .values({
        agentId,
        taskId: task.id,
        kind: "app_action",
        action: `${racePackage}.create_item`,
        details: "Create an item",
        status: "approved",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    const [action] = await db
      .insert(appActionsTable)
      .values({
        taskId: task.id,
        agentId,
        app: racePackage,
        operation: `${racePackage}.create_item`,
        params: { title: "x" },
        targetSummary: "Racer: POST /items",
        status: "approved",
        approvalId: approval.id,
        definitionRevision: raceRevision,
      })
      .returning();

    // Interleaving A — the mid-removal window: the connection fence has
    // committed (row disabled or already gone) but the approval sweep has
    // not run yet. The claim UPDATE itself must refuse, leaving the row
    // approved for the sweep — it must NEVER transition to executing.
    await db
      .update(customApiConnectionsTable)
      .set({ enabled: false })
      .where(eq(customApiConnectionsTable.id, raceApiId));
    expect(await claimApprovedAction(action.id)).toBeNull();
    let [current] = await db
      .select()
      .from(appActionsTable)
      .where(eq(appActionsTable.id, action.id));
    expect(current.status).toBe("approved");
    await db
      .update(customApiConnectionsTable)
      .set({ enabled: true })
      .where(eq(customApiConnectionsTable.id, raceApiId));

    // A stale definition revision refuses the claim even while enabled.
    await db
      .update(appActionsTable)
      .set({ definitionRevision: "00000000-0000-4000-8000-00000000dead" })
      .where(eq(appActionsTable.id, action.id));
    expect(await claimApprovedAction(action.id)).toBeNull();
    await db
      .update(appActionsTable)
      .set({ definitionRevision: raceRevision })
      .where(eq(appActionsTable.id, action.id));

    // Interleaving C — disable followed by a quick re-enable. Disabling
    // bumps the revision, so it is an IRREVERSIBLE fence: even when the
    // expiry sweep loses the race (simulated by forcing the row back to
    // approved), neither the claim nor the executor accepts the action
    // approved under the old revision.
    const disabled = await request(app)
      .patch(`/api/connected-apps/custom/${raceApiId}`)
      .send({ enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.revision).not.toBe(raceRevision);
    const reenabled = await request(app)
      .patch(`/api/connected-apps/custom/${raceApiId}`)
      .send({ enabled: true });
    expect(reenabled.status).toBe(200);
    expect(reenabled.body.enabled).toBe(true);
    // Re-enabling must not restore the pre-disable revision.
    expect(reenabled.body.revision).not.toBe(raceRevision);
    const postEnableRevision: string = reenabled.body.revision;
    // Pretend the sweep never reached this row: the claim must still refuse.
    await db
      .update(appActionsTable)
      .set({ status: "approved" })
      .where(eq(appActionsTable.id, action.id));
    expect(await claimApprovedAction(action.id)).toBeNull();
    const staleResolve = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    const staleRequest = vi.fn(async () => ({
      status: 200,
      contentType: "application/json",
      location: null,
      body: Buffer.from("{}"),
    }));
    const staleCapabilities = await loadWorkspaceCapabilities(workspaceId);
    const staleTool = staleCapabilities.tools.get(`${racePackage}.create_item`);
    expect(staleTool).toBeDefined();
    const staleOutcome = await executeCustomApiTool(
      staleTool!,
      { title: "x" },
      { workspaceId, expectedRevision: raceRevision },
      { resolve: staleResolve, requestOnce: staleRequest },
    );
    expect(staleOutcome.ok).toBe(false);
    expect(staleResolve).not.toHaveBeenCalled();
    expect(staleRequest).not.toHaveBeenCalled();

    // Interleaving B — the worker wins the claim BEFORE the owner deletes.
    // Re-approve at the CURRENT revision so the claim legitimately passes,
    // and snapshot the resolved tool first, like a worker that resolved it
    // before the deletion committed.
    await db
      .update(appActionsTable)
      .set({ status: "approved", definitionRevision: postEnableRevision })
      .where(eq(appActionsTable.id, action.id));
    const capabilities = await loadWorkspaceCapabilities(workspaceId);
    const tool = capabilities.tools.get(`${racePackage}.create_item`);
    expect(tool).toBeDefined();
    const claimed = await claimApprovedAction(action.id);
    expect(claimed?.status).toBe("executing");

    const del = await request(app).delete(
      `/api/connected-apps/custom/${raceApiId}`,
    );
    expect(del.status).toBe(200);

    // The executor's final-boundary re-read must refuse without a single
    // DNS lookup or network request.
    const resolveSpy = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    const requestSpy = vi.fn(async () => ({
      status: 200,
      contentType: "application/json",
      location: null,
      body: Buffer.from("{}"),
    }));
    const outcome = await executeCustomApiTool(
      tool!,
      { title: "x" },
      { workspaceId, expectedRevision: postEnableRevision },
      { resolve: resolveSpy, requestOnce: requestSpy },
    );
    expect(outcome.ok).toBe(false);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();

    // And the deletion sweep expired the approval trail for good measure:
    // an action that never reached executing would have been swept; ours
    // was claimed, so it must not have been resurrected either way.
    [current] = await db
      .select()
      .from(appActionsTable)
      .where(eq(appActionsTable.id, action.id));
    expect(current.status).toBe("executing");
  });

  it("a stale PATCH writer can never resurrect a revoked revision", async () => {
    const created = await request(app)
      .post("/api/connected-apps/custom")
      .send(apiBody({ slug: "staler", displayName: `Staler ${RUN_TAG}` }));
    expect(created.status).toBe(201);
    const staleApiId: string = created.body.id;
    const rev1: string = created.body.revision;
    // Tab B snapshots the full editable state before anything changes.
    const listed = await request(app).get("/api/connected-apps/custom");
    const staleCopy = listed.body.apis.find(
      (entry: { id: string }) => entry.id === staleApiId,
    );
    expect(staleCopy).toBeDefined();

    // Tab A disables the API — the revision moves irreversibly past rev1.
    const disabled = await request(app)
      .patch(`/api/connected-apps/custom/${staleApiId}`)
      .send({ enabled: false });
    expect(disabled.status).toBe(200);
    const rev2: string = disabled.body.revision;
    expect(rev2).not.toBe(rev1);

    // Tab B now submits its stale copy with enabled: true — exactly the
    // lost-update write that used to restore the pre-disable revision.
    // The row is re-read under lock, so the write re-enables at rev2 (its
    // definition matches the current row) and can never revive rev1.
    const staleWrite = await request(app)
      .patch(`/api/connected-apps/custom/${staleApiId}`)
      .send({
        displayName: staleCopy.displayName,
        description: staleCopy.description,
        baseUrl: staleCopy.baseUrl,
        authType: staleCopy.authType,
        operations: staleCopy.operations,
        enabled: true,
      });
    expect(staleWrite.status).toBe(200);
    expect(staleWrite.body.enabled).toBe(true);
    expect(staleWrite.body.revision).not.toBe(rev1);

    // An action approved under rev1 stays dead: the claim fence refuses.
    const agentRes = await request(app)
      .post("/api/agents")
      .send({
        name: `Staler ${RUN_TAG}`,
        title: "Writer",
        mission: "Hold a stale-revision approval for the PATCH race test.",
        provider: "claude_max",
        securityPreset: "assistant",
        avatar: {
          shellColor: "#C34428",
          deskStyle: "standard",
          accessory: "none",
        },
        appGrants: [{ app: customApiPackageId("staler"), accessLevel: "write" }],
      });
    expect(agentRes.status).toBe(201);
    createdAgentIds.push(agentRes.body.id);
    const [task] = await db
      .insert(tasksTable)
      .values({
        workspaceId,
        agentId: agentRes.body.id,
        objective: `Stale PATCH race ${RUN_TAG}`,
        provider: "claude_max",
        status: "working",
      })
      .returning();
    const [approval] = await db
      .insert(approvalsTable)
      .values({
        agentId: agentRes.body.id,
        taskId: task.id,
        kind: "app_action",
        action: "custom_staler.create_item",
        details: "Create an item",
        status: "approved",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    const [action] = await db
      .insert(appActionsTable)
      .values({
        taskId: task.id,
        agentId: agentRes.body.id,
        app: "custom_staler",
        operation: "custom_staler.create_item",
        params: { title: "x" },
        targetSummary: "Staler: POST /items",
        status: "approved",
        approvalId: approval.id,
        definitionRevision: rev1,
      })
      .returning();
    expect(await claimApprovedAction(action.id)).toBeNull();

    // Same for a definition edit followed by a stale write-back of the OLD
    // operations: the stale write is itself a definition change against the
    // locked current row, so the revision moves FORWARD yet again — it never
    // returns to any previously approved value.
    const edited = await request(app)
      .patch(`/api/connected-apps/custom/${staleApiId}`)
      .send({ description: "Edited by tab A" });
    expect(edited.status).toBe(200);
    const rev3: string = edited.body.revision;
    expect(rev3).not.toBe(staleWrite.body.revision);
    const staleDefinitionWrite = await request(app)
      .patch(`/api/connected-apps/custom/${staleApiId}`)
      .send({
        description: staleCopy.description,
        operations: staleCopy.operations,
      });
    expect(staleDefinitionWrite.status).toBe(200);
    expect(staleDefinitionWrite.body.revision).not.toBe(rev3);
    expect(staleDefinitionWrite.body.revision).not.toBe(rev1);
    // The rev3-pinned action (simulating one approved under tab A's edit)
    // is dead after the stale write-back too.
    await db
      .update(appActionsTable)
      .set({ definitionRevision: rev3 })
      .where(eq(appActionsTable.id, action.id));
    expect(await claimApprovedAction(action.id)).toBeNull();

    await request(app).delete(`/api/connected-apps/custom/${staleApiId}`);
  });

  it("deletes the API, revokes grants, and reports the counts", async () => {
    const packageId = customApiPackageId("acme");
    const res = await request(app).delete(
      `/api/connected-apps/custom/${apiId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.removedGrants).toBeGreaterThanOrEqual(2);
    const rows = await db
      .select()
      .from(customApiConnectionsTable)
      .where(eq(customApiConnectionsTable.id, apiId));
    expect(rows).toHaveLength(0);
    const grants = await db
      .select()
      .from(agentAppGrantsTable)
      .where(
        and(
          eq(agentAppGrantsTable.app, packageId),
          inArray(agentAppGrantsTable.agentId, createdAgentIds),
        ),
      );
    expect(grants).toHaveLength(0);
    const capabilities = await loadWorkspaceCapabilities(workspaceId);
    expect(capabilities.packages.has(packageId)).toBe(false);
  });
});
