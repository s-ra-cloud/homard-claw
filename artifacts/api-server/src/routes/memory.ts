import {
  ClearMemoriesQueryParams,
  ClearMemoriesResponse,
  CreateMemoryBody,
  CreateMemoryResponse,
  DeleteKnowledgeFileParams,
  DeleteMemoryParams,
  ExportMemoriesResponse,
  GetMemorySettingsResponse,
  ListKnowledgeFilesResponse,
  ListMemoriesQueryParams,
  ListMemoriesResponse,
  ApplyMemoryCompressionPreviewParams,
  ApplyMemoryCompressionPreviewResponse,
  PreviewMemoryCompressionBody,
  PreviewMemoryCompressionResponse,
  SetKnowledgeAssignmentsBody,
  SetKnowledgeAssignmentsParams,
  SetKnowledgeAssignmentsResponse,
  UpdateMemoryBody,
  UpdateMemorySettingsBody,
  UpdateMemorySettingsResponse,
  UpdateMemoryParams,
  UpdateMemoryResponse,
  UploadKnowledgeFileBody,
  UploadKnowledgeFileResponse,
} from "@workspace/api-zod";
import {
  agentKnowledgeTable,
  agentsTable,
  db,
  knowledgeFilesTable,
  memoriesTable,
  workspaceSettingsTable,
} from "@workspace/db";
import { recordAudit } from "../audit";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  insertMemoryEnforcingCap,
  KNOWLEDGE_QUOTA_LOCK,
  MAX_KNOWLEDGE_FILES,
  MAX_KNOWLEDGE_TOTAL_BYTES,
  MemoryQuotaError,
} from "../memory-context";
import {
  applyMemoryCompressionPreview,
  createMemoryCompressionPreview,
  MemoryCompressionError,
} from "../memory-compression";

/**
 * Memory and knowledge management. Mounted inside the office router, so
 * every route here is already owner-only.
 */
const router: IRouter = Router();
const MEMORY_COMPRESSION_AGENT_KEY = "memory_compression_agent_id";

async function configuredMemoryCompressionAgent(workspaceId: string) {
  const [setting] = await db
    .select({ agentId: workspaceSettingsTable.value })
    .from(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, workspaceId),
        eq(workspaceSettingsTable.key, MEMORY_COMPRESSION_AGENT_KEY),
      ),
    )
    .limit(1);
  if (!setting?.agentId) return null;
  const [agent] = await db
    .select({ id: agentsTable.id, name: agentsTable.name })
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.workspaceId, workspaceId),
        eq(agentsTable.id, setting.agentId),
        eq(agentsTable.paused, false),
        eq(agentsTable.archived, false),
        eq(agentsTable.retired, false),
        eq(agentsTable.sensitiveDataSandbox, false),
      ),
    )
    .limit(1);
  return agent ?? null;
}

function memorySettingsPayload(agent: { id: string; name: string } | null) {
  return {
    compressionAgentId: agent?.id ?? null,
    compressionAgentName: agent?.name ?? null,
  };
}

router.get("/memory/settings", async (req, res): Promise<void> => {
  const agent = await configuredMemoryCompressionAgent(req.workspaceId!);
  res.json(GetMemorySettingsResponse.parse(memorySettingsPayload(agent)));
});

router.put("/memory/settings", async (req, res): Promise<void> => {
  const body = UpdateMemorySettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Choose a memory-compression Crustabot." });
    return;
  }

  const requestedId = body.data.compressionAgentId;
  let agent: { id: string; name: string } | null = null;
  if (requestedId) {
    const [available] = await db
      .select({
        id: agentsTable.id,
        name: agentsTable.name,
        paused: agentsTable.paused,
        sandboxed: agentsTable.sensitiveDataSandbox,
      })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.workspaceId, req.workspaceId!),
          eq(agentsTable.id, requestedId),
          eq(agentsTable.archived, false),
          eq(agentsTable.retired, false),
        ),
      )
      .limit(1);
    if (!available) {
      res.status(404).json({ error: "That Crustabot is not available." });
      return;
    }
    if (available.paused) {
      res.status(409).json({
        error: "Resume that Crustabot before assigning memory compression.",
      });
      return;
    }
    if (available.sandboxed) {
      res.status(409).json({
        error: "A sandboxed Crustabot cannot maintain shared office memories.",
      });
      return;
    }
    agent = available;
  }

  await db.transaction(async (tx) => {
    if (agent) {
      await tx
        .insert(workspaceSettingsTable)
        .values({
          workspaceId: req.workspaceId!,
          key: MEMORY_COMPRESSION_AGENT_KEY,
          value: agent.id,
        })
        .onConflictDoUpdate({
          target: [
            workspaceSettingsTable.workspaceId,
            workspaceSettingsTable.key,
          ],
          set: { value: agent.id },
        });
    } else {
      await tx
        .delete(workspaceSettingsTable)
        .where(
          and(
            eq(workspaceSettingsTable.workspaceId, req.workspaceId!),
            eq(workspaceSettingsTable.key, MEMORY_COMPRESSION_AGENT_KEY),
          ),
        );
    }
    await recordAudit(
      req.workspaceId!,
      "memory.compression_settings",
      agent
        ? `${agent.name} became the memory-compression Crustabot.`
        : "The memory-compression role was cleared.",
      tx,
    );
  });

  res.json(UpdateMemorySettingsResponse.parse(memorySettingsPayload(agent)));
});

router.post(
  "/memory/compression/previews",
  async (req, res): Promise<void> => {
    const body = PreviewMemoryCompressionBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Choose the Crustabot memory bank to compress." });
      return;
    }
    try {
      const preview = await createMemoryCompressionPreview({
        workspaceId: req.workspaceId!,
        targetAgentId: body.data.targetAgentId,
      });
      res.json(PreviewMemoryCompressionResponse.parse(preview));
    } catch (error) {
      if (error instanceof MemoryCompressionError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/memory/compression/previews/:runId/apply",
  async (req, res): Promise<void> => {
    const params = ApplyMemoryCompressionPreviewParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid compression preview." });
      return;
    }
    try {
      const applied = await applyMemoryCompressionPreview({
        workspaceId: req.workspaceId!,
        runId: params.data.runId,
      });
      res.json(ApplyMemoryCompressionPreviewResponse.parse(applied));
    } catch (error) {
      if (error instanceof MemoryCompressionError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

function toMemoryJson(
  memory: typeof memoriesTable.$inferSelect,
  agentName: string | null,
) {
  return {
    id: memory.id,
    agentId: memory.agentId,
    agentName,
    kind: memory.kind,
    content: memory.content,
    pinned: memory.pinned,
    disabled: memory.disabled,
    sourceTaskId: memory.sourceTaskId,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

async function listMemoriesWithAgents(where?: ReturnType<typeof and>) {
  const rows = await db
    .select({ memory: memoriesTable, agentName: agentsTable.name })
    .from(memoriesTable)
    .leftJoin(
      agentsTable,
      and(
        eq(agentsTable.id, memoriesTable.agentId),
        eq(agentsTable.workspaceId, memoriesTable.workspaceId),
      ),
    )
    .where(where)
    .orderBy(
      desc(memoriesTable.pinned),
      desc(memoriesTable.updatedAt),
    );
  return rows.map((row) => toMemoryJson(row.memory, row.agentName));
}

router.get("/memories", async (req, res): Promise<void> => {
  const query = ListMemoriesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid memory query" });
    return;
  }
  const { agentId, q } = query.data;
  const conditions = [eq(memoriesTable.workspaceId, req.workspaceId!)];
  if (agentId === "shared") {
    conditions.push(isNull(memoriesTable.agentId));
  } else if (agentId) {
    conditions.push(
      or(eq(memoriesTable.agentId, agentId), isNull(memoriesTable.agentId))!,
    );
  }
  if (q && q.trim() !== "") {
    const needle = q.trim();
    // Substring match OR full-text match, so both exact fragments and
    // natural-language queries find memories.
    conditions.push(
      or(
        sql`${memoriesTable.content} ILIKE ${"%" + needle + "%"}`,
        sql`to_tsvector('english', ${memoriesTable.content}) @@ websearch_to_tsquery('english', ${needle})`,
      )!,
    );
  }
  const memories = await listMemoriesWithAgents(and(...conditions));
  res.json(ListMemoriesResponse.parse({ memories, total: memories.length }));
});

router.post("/memories", async (req, res): Promise<void> => {
  const body = CreateMemoryBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const agentId = body.data.agentId ?? null;
  if (agentId) {
    const [agent] = await db
      .select({ id: agentsTable.id, name: agentsTable.name })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
  }
  let memory: typeof memoriesTable.$inferSelect;
  try {
    const inserted = await insertMemoryEnforcingCap(
      {
        agentId,
        workspaceId: req.workspaceId!,
        kind: body.data.kind ?? "fact",
        content: body.data.content,
        pinned: body.data.pinned ?? false,
      },
      { pruneToMakeRoom: false },
    );
    if (!inserted) throw new MemoryQuotaError();
    memory = inserted;
  } catch (error) {
    if (error instanceof MemoryQuotaError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
  const agentName = agentId
    ? (
        await db
          .select({ name: agentsTable.name })
          .from(agentsTable)
          .where(
            and(
              eq(agentsTable.id, agentId),
              eq(agentsTable.workspaceId, req.workspaceId!),
            ),
          )
          .limit(1)
      )[0]?.name ?? null
    : null;
  res.status(201).json(CreateMemoryResponse.parse(toMemoryJson(memory, agentName)));
});

router.delete("/memories", async (req, res): Promise<void> => {
  const query = ClearMemoriesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid clear request" });
    return;
  }
  const deleted = await db
    .delete(memoriesTable)
    .where(
      query.data.agentId
        ? and(
            eq(memoriesTable.workspaceId, req.workspaceId!),
            eq(memoriesTable.agentId, query.data.agentId),
          )
        : eq(memoriesTable.workspaceId, req.workspaceId!),
    )
    .returning({ id: memoriesTable.id });
  await recordAudit(
      req.workspaceId!,
      "memory.cleared",
      query.data.agentId
      ? `${deleted.length} memories were cleared for one agent.`
      : `All ${deleted.length} memories were cleared.`,
    );
  res.json(ClearMemoriesResponse.parse({ deleted: deleted.length }));
});

router.get("/memories/export", async (req, res): Promise<void> => {
  const memories = await listMemoriesWithAgents(
    and(eq(memoriesTable.workspaceId, req.workspaceId!)),
  );
  res.json(ExportMemoriesResponse.parse({ memories, total: memories.length }));
});

router.patch("/memories/:memoryId", async (req, res): Promise<void> => {
  const params = UpdateMemoryParams.safeParse(req.params);
  const body = UpdateMemoryBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid memory update" });
    return;
  }
  const updates = Object.fromEntries(
    Object.entries(body.data).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  if (typeof updates.agentId === "string") {
    const [agent] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, updates.agentId),
          eq(agentsTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
  }
  // A sandboxed agent's private memories may never be published office-wide
  // (or handed to another agent): re-scoping is the one path that would let
  // sensitive-task residue reach other agents' prompts, so it is refused
  // while the owning agent is in the sensitive data sandbox.
  if ("agentId" in updates) {
    const [current] = await db
      .select({
        agentId: memoriesTable.agentId,
        sandboxed: agentsTable.sensitiveDataSandbox,
        agentName: agentsTable.name,
      })
      .from(memoriesTable)
      .leftJoin(agentsTable, eq(agentsTable.id, memoriesTable.agentId))
      .where(
        and(
          eq(memoriesTable.id, params.data.memoryId),
          eq(memoriesTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1);
    if (!current) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    const moving = updates.agentId !== current.agentId;
    if (moving && current.agentId && current.sandboxed) {
      res.status(409).json({
        error: `${current.agentName ?? "This agent"} is in the sensitive data sandbox; its private memories cannot be shared office-wide or moved to another agent.`,
      });
      return;
    }
  }
  const [memory] = await db
    .update(memoriesTable)
    .set({ ...updates, updatedAt: new Date() })
    .where(
      and(
        eq(memoriesTable.id, params.data.memoryId),
        eq(memoriesTable.workspaceId, req.workspaceId!),
      ),
    )
    .returning();
  if (!memory) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  const agentName = memory.agentId
    ? (
        await db
          .select({ name: agentsTable.name })
          .from(agentsTable)
          .where(
            and(
              eq(agentsTable.id, memory.agentId),
              eq(agentsTable.workspaceId, req.workspaceId!),
            ),
          )
          .limit(1)
      )[0]?.name ?? null
    : null;
  res.json(UpdateMemoryResponse.parse(toMemoryJson(memory, agentName)));
});

router.delete("/memories/:memoryId", async (req, res): Promise<void> => {
  const params = DeleteMemoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid memory id" });
    return;
  }
  const deleted = await db
    .delete(memoriesTable)
    .where(
      and(
        eq(memoriesTable.id, params.data.memoryId),
        eq(memoriesTable.workspaceId, req.workspaceId!),
      ),
    )
    .returning({ id: memoriesTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Knowledge files
// ---------------------------------------------------------------------------

/** Text-based types agents can actually read; binaries are rejected. */
const TEXT_MIME_ALLOWLIST = [
  /^text\//,
  /^application\/(json|xml|x-yaml|yaml|toml|csv|javascript|typescript|sql|x-sh)$/,
];

function toKnowledgeJson(
  file: Omit<typeof knowledgeFilesTable.$inferSelect, "content" | "workspaceId">,
  agentIds: string[],
) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    description: file.description,
    sizeBytes: file.sizeBytes,
    wordCount: file.wordCount,
    agentIds,
    createdAt: file.createdAt.toISOString(),
  };
}

async function assignmentsByFile(workspaceId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({
      fileId: agentKnowledgeTable.fileId,
      agentId: agentKnowledgeTable.agentId,
    })
    .from(agentKnowledgeTable)
    .innerJoin(
      knowledgeFilesTable,
      eq(knowledgeFilesTable.id, agentKnowledgeTable.fileId),
    )
    .where(eq(knowledgeFilesTable.workspaceId, workspaceId));
  const map = new Map<string, string[]>();
  for (const row of rows) {
    map.set(row.fileId, [...(map.get(row.fileId) ?? []), row.agentId]);
  }
  return map;
}

router.get("/knowledge", async (req, res): Promise<void> => {
  const [files, assignments] = await Promise.all([
    db
      .select({
        id: knowledgeFilesTable.id,
        name: knowledgeFilesTable.name,
        mimeType: knowledgeFilesTable.mimeType,
        description: knowledgeFilesTable.description,
        sizeBytes: knowledgeFilesTable.sizeBytes,
        wordCount: knowledgeFilesTable.wordCount,
        createdAt: knowledgeFilesTable.createdAt,
      })
      .from(knowledgeFilesTable)
      .where(eq(knowledgeFilesTable.workspaceId, req.workspaceId!))
      .orderBy(desc(knowledgeFilesTable.createdAt)),
    assignmentsByFile(req.workspaceId!),
  ]);
  res.json(
    ListKnowledgeFilesResponse.parse(
      files.map((file) => toKnowledgeJson(file, assignments.get(file.id) ?? [])),
    ),
  );
});

router.post("/knowledge", async (req, res): Promise<void> => {
  const body = UploadKnowledgeFileBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const { name, mimeType, content, description } = body.data;
  if (!TEXT_MIME_ALLOWLIST.some((pattern) => pattern.test(mimeType))) {
    res.status(400).json({
      error: `Unsupported file type "${mimeType}". Upload text-based files (txt, md, csv, json, code).`,
    });
    return;
  }
  if (content.includes("\u0000")) {
    res.status(400).json({ error: "File looks binary; only text files are supported." });
    return;
  }
  const sizeBytes = Buffer.byteLength(content, "utf8");
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  // Quota check and insert run under one advisory lock so concurrent
  // uploads cannot race past the storage limits.
  let file: typeof knowledgeFilesTable.$inferSelect | null = null;
  let quotaError: string | null = null;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${KNOWLEDGE_QUOTA_LOCK}, hashtext(${req.workspaceId!}))`,
    );
    const [stats] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        totalBytes: sql<number>`coalesce(sum(${knowledgeFilesTable.sizeBytes}), 0)::int`,
      })
      .from(knowledgeFilesTable)
      .where(eq(knowledgeFilesTable.workspaceId, req.workspaceId!));
    if ((stats?.count ?? 0) >= MAX_KNOWLEDGE_FILES) {
      quotaError = `File limit reached (${MAX_KNOWLEDGE_FILES}). Delete a file before uploading more.`;
      return;
    }
    if ((stats?.totalBytes ?? 0) + sizeBytes > MAX_KNOWLEDGE_TOTAL_BYTES) {
      quotaError = `Storage limit reached (${Math.round(MAX_KNOWLEDGE_TOTAL_BYTES / 1_000_000)} MB total). Delete files to free space.`;
      return;
    }
    const [inserted] = await tx
      .insert(knowledgeFilesTable)
      .values({
        workspaceId: req.workspaceId!,
        name,
        mimeType,
        description: description ?? null,
        content,
        sizeBytes,
        wordCount,
      })
      .returning();
    file = inserted;
  });
  if (quotaError !== null || !file) {
    res.status(409).json({ error: quotaError ?? "Upload failed" });
    return;
  }
  await recordAudit(
      req.workspaceId!,
      "knowledge.uploaded",
      `Knowledge file "${name}" was uploaded (${wordCount} words).`,
    );
  res.status(201).json(UploadKnowledgeFileResponse.parse(toKnowledgeJson(file, [])));
});

router.delete("/knowledge/:fileId", async (req, res): Promise<void> => {
  const params = DeleteKnowledgeFileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid file id" });
    return;
  }
  const deleted = await db
    .delete(knowledgeFilesTable)
    .where(
      and(
        eq(knowledgeFilesTable.id, params.data.fileId),
        eq(knowledgeFilesTable.workspaceId, req.workspaceId!),
      ),
    )
    .returning({ name: knowledgeFilesTable.name });
  if (deleted.length === 0) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  await recordAudit(
      req.workspaceId!,
      "knowledge.deleted",
      `Knowledge file "${deleted[0].name}" was deleted.`,
    );
  res.status(204).end();
});

router.put("/knowledge/:fileId/assignments", async (req, res): Promise<void> => {
  const params = SetKnowledgeAssignmentsParams.safeParse(req.params);
  const body = SetKnowledgeAssignmentsBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid assignment request" });
    return;
  }
  const agentIds = [...new Set(body.data.agentIds)];
  const [file] = await db
    .select({
      id: knowledgeFilesTable.id,
      name: knowledgeFilesTable.name,
      mimeType: knowledgeFilesTable.mimeType,
      description: knowledgeFilesTable.description,
      sizeBytes: knowledgeFilesTable.sizeBytes,
      wordCount: knowledgeFilesTable.wordCount,
      createdAt: knowledgeFilesTable.createdAt,
    })
    .from(knowledgeFilesTable)
    .where(
      and(
        eq(knowledgeFilesTable.id, params.data.fileId),
        eq(knowledgeFilesTable.workspaceId, req.workspaceId!),
      ),
    )
    .limit(1);
  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  if (agentIds.length > 0) {
    const agents = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.workspaceId, req.workspaceId!),
          inArray(agentsTable.id, agentIds),
        ),
      );
    if (agents.length !== agentIds.length) {
      res.status(404).json({ error: "One or more agents were not found" });
      return;
    }
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(agentKnowledgeTable)
      .where(eq(agentKnowledgeTable.fileId, file.id));
    if (agentIds.length > 0) {
      await tx
        .insert(agentKnowledgeTable)
        .values(agentIds.map((agentId) => ({ agentId, fileId: file.id })));
    }
  });
  res.json(
    SetKnowledgeAssignmentsResponse.parse(toKnowledgeJson(file, agentIds)),
  );
});

export default router;
