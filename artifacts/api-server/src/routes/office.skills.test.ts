import express from "express";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  auditEventsTable,
  db,
  pool,
  systemStateTable,
  workspacesTable,
  workspaceSkillsTable,
} from "@workspace/db";
import { and, eq, like, sql } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-skills-test-owner" }));
vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

import officeRouter from "./office";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Workspace Skills ${Date.now()}`;
let workspaceId = "";
let createdOwnerRow = false;

beforeAll(async () => {
  const [owner] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "owner_clerk_id"))
    .limit(1);
  if (owner) authState.userId = owner.value;
  else createdOwnerRow = true;

  const boot = await request(app).get("/api/agents");
  expect(boot.status).toBe(200);
  const [workspace] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.clerkUserId, authState.userId))
    .limit(1);
  workspaceId = workspace.id;
});

beforeEach(async () => {
  await db
    .delete(workspaceSkillsTable)
    .where(like(workspaceSkillsTable.title, `${RUN_TAG}%`));
});

afterAll(async () => {
  await db
    .delete(workspaceSkillsTable)
    .where(like(workspaceSkillsTable.title, `${RUN_TAG}%`));
  if (createdOwnerRow) {
    await db
      .delete(systemStateTable)
      .where(
        and(
          eq(systemStateTable.key, "owner_clerk_id"),
          eq(systemStateTable.value, authState.userId),
        ),
      );
  }
  await pool.end();
});

describe("workspace skills", () => {
  it("creates, lists, updates, and deletes a toolless workspace skill with audit events", async () => {
    const created = await request(app)
      .post("/api/skills")
      .send({
        title: `${RUN_TAG} Research format`,
        triggers: ["research", "market update"],
        instructions: "Start with a dated executive summary.",
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      enabled: true,
      triggers: ["research", "market update"],
    });

    const listed = await request(app).get("/api/skills");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.body.id }),
      ]),
    );

    const updated = await request(app)
      .patch(`/api/skills/${created.body.id}`)
      .send({ enabled: false, instructions: "Use a two-line summary." });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      enabled: false,
      instructions: "Use a two-line summary.",
    });

    const deleted = await request(app).delete(`/api/skills/${created.body.id}`);
    expect(deleted.status).toBe(204);

    const audits = await db
      .select({ kind: auditEventsTable.kind })
      .from(auditEventsTable)
      .where(eq(auditEventsTable.workspaceId, workspaceId));
    expect(audits.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "workspace_skill.created",
        "workspace_skill.updated",
        "workspace_skill.deleted",
      ]),
    );
  });

  it("refuses a 21st skill without disturbing existing workspace skills", async () => {
    const [stats] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workspaceSkillsTable)
      .where(eq(workspaceSkillsTable.workspaceId, workspaceId));
    const needed = Math.max(0, 20 - (stats?.count ?? 0));
    if (needed > 0) {
      await db.insert(workspaceSkillsTable).values(
        Array.from({ length: needed }, (_, index) => ({
          workspaceId,
          title: `${RUN_TAG} quota ${index}`,
          triggers: [`quota-${index}`],
          instructions: "Quota fixture.",
        })),
      );
    }

    const refused = await request(app)
      .post("/api/skills")
      .send({
        title: `${RUN_TAG} twenty first`,
        triggers: ["overflow"],
        instructions: "This must not be stored.",
      });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/limit reached \(20\)/i);
  });
});
