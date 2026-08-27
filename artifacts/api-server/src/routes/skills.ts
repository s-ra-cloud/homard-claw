import {
  CreateWorkspaceSkillBody,
  CreateWorkspaceSkillResponse,
  DeleteWorkspaceSkillParams,
  ListWorkspaceSkillsResponse,
  UpdateWorkspaceSkillBody,
  UpdateWorkspaceSkillParams,
  UpdateWorkspaceSkillResponse,
} from "@workspace/api-zod";
import { db, workspaceSkillsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { recordAudit } from "../audit";

const router: IRouter = Router();

export const MAX_WORKSPACE_SKILLS = 20;
const WORKSPACE_SKILLS_QUOTA_LOCK = 872_007;

function toSkillJson(skill: typeof workspaceSkillsTable.$inferSelect) {
  return {
    id: skill.id,
    title: skill.title,
    triggers: skill.triggers,
    instructions: skill.instructions,
    enabled: skill.enabled,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

function normalizeTextFields(input: {
  title?: string;
  triggers?: string[];
  instructions?: string;
}):
  | {
      ok: true;
      values: { title?: string; triggers?: string[]; instructions?: string };
    }
  | { ok: false; error: string } {
  const values: { title?: string; triggers?: string[]; instructions?: string } =
    {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return { ok: false, error: "Skill title cannot be empty." };
    values.title = title;
  }
  if (input.instructions !== undefined) {
    const instructions = input.instructions.trim();
    if (!instructions) {
      return { ok: false, error: "Skill instructions cannot be empty." };
    }
    values.instructions = instructions;
  }
  if (input.triggers !== undefined) {
    const triggers: string[] = [];
    const seen = new Set<string>();
    for (const raw of input.triggers) {
      const trigger = raw.trim();
      if (!trigger) {
        return { ok: false, error: "Skill triggers cannot be empty." };
      }
      const key = trigger.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      triggers.push(trigger);
    }
    values.triggers = triggers;
  }
  return { ok: true, values };
}

router.get("/skills", async (req, res): Promise<void> => {
  const skills = await db
    .select()
    .from(workspaceSkillsTable)
    .where(eq(workspaceSkillsTable.workspaceId, req.workspaceId!))
    .orderBy(desc(workspaceSkillsTable.updatedAt));
  res.json(ListWorkspaceSkillsResponse.parse(skills.map(toSkillJson)));
});

router.post("/skills", async (req, res): Promise<void> => {
  const body = CreateWorkspaceSkillBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const normalized = normalizeTextFields(body.data);
  if (!normalized.ok) {
    res.status(400).json({ error: normalized.error });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${WORKSPACE_SKILLS_QUOTA_LOCK}, hashtext(${req.workspaceId!}))`,
    );
    const [stats] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workspaceSkillsTable)
      .where(eq(workspaceSkillsTable.workspaceId, req.workspaceId!));
    if ((stats?.count ?? 0) >= MAX_WORKSPACE_SKILLS) return null;
    const [skill] = await tx
      .insert(workspaceSkillsTable)
      .values({
        workspaceId: req.workspaceId!,
        title: normalized.values.title!,
        triggers: normalized.values.triggers!,
        instructions: normalized.values.instructions!,
        enabled: body.data.enabled ?? true,
      })
      .returning();
    await recordAudit(
      req.workspaceId!,
      "workspace_skill.created",
      `Workspace skill "${skill!.title}" was created.`,
      tx,
    );
    return skill!;
  });
  if (!outcome) {
    res.status(409).json({
      error: `Workspace skill limit reached (${MAX_WORKSPACE_SKILLS}). Delete a skill before creating another.`,
    });
    return;
  }
  res
    .status(201)
    .json(CreateWorkspaceSkillResponse.parse(toSkillJson(outcome)));
});

router.patch("/skills/:skillId", async (req, res): Promise<void> => {
  const params = UpdateWorkspaceSkillParams.safeParse(req.params);
  const body = UpdateWorkspaceSkillBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid workspace skill update." });
    return;
  }
  if (Object.values(body.data).every((value) => value === undefined)) {
    res.status(400).json({ error: "No fields to update." });
    return;
  }
  const normalized = normalizeTextFields(body.data);
  if (!normalized.ok) {
    res.status(400).json({ error: normalized.error });
    return;
  }
  const updates = {
    ...normalized.values,
    ...(body.data.enabled !== undefined ? { enabled: body.data.enabled } : {}),
    updatedAt: new Date(),
  };
  const skill = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(workspaceSkillsTable)
      .set(updates)
      .where(
        and(
          eq(workspaceSkillsTable.id, params.data.skillId),
          eq(workspaceSkillsTable.workspaceId, req.workspaceId!),
        ),
      )
      .returning();
    if (!updated) return null;
    await recordAudit(
      req.workspaceId!,
      "workspace_skill.updated",
      `Workspace skill "${updated.title}" was updated.`,
      tx,
    );
    return updated;
  });
  if (!skill) {
    res.status(404).json({ error: "Workspace skill not found." });
    return;
  }
  res.json(UpdateWorkspaceSkillResponse.parse(toSkillJson(skill)));
});

router.delete("/skills/:skillId", async (req, res): Promise<void> => {
  const params = DeleteWorkspaceSkillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid workspace skill id." });
    return;
  }
  const deleted = await db.transaction(async (tx) => {
    const [skill] = await tx
      .delete(workspaceSkillsTable)
      .where(
        and(
          eq(workspaceSkillsTable.id, params.data.skillId),
          eq(workspaceSkillsTable.workspaceId, req.workspaceId!),
        ),
      )
      .returning({ title: workspaceSkillsTable.title });
    if (!skill) return null;
    await recordAudit(
      req.workspaceId!,
      "workspace_skill.deleted",
      `Workspace skill "${skill.title}" was deleted.`,
      tx,
    );
    return skill;
  });
  if (!deleted) {
    res.status(404).json({ error: "Workspace skill not found." });
    return;
  }
  res.status(204).end();
});

export default router;
