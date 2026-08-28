import {
  ChatWithDocumentationBody,
  ChatWithDocumentationResponse,
  GetDocumentationResponse,
  UpdateDocumentationSettingsBody,
  UpdateDocumentationSettingsResponse,
} from "@workspace/api-zod";
import { agentsTable, db } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { recordAudit } from "../audit";
import {
  CRUSTABOX_DOCUMENTATION,
  documentationPromptContext,
} from "../documentation/content";
import {
  answerDocumentationQuestion,
  ConverseWithAgentError,
  type DocumentationConversationTurn,
} from "./voice";
import { getWorkspaceSetting, setWorkspaceSetting } from "../workspace";

const router: IRouter = Router();
const DOCUMENTATION_AGENT_KEY = "documentation_agent_id";

type Guide = { id: string; name: string };

async function availableGuide(
  workspaceId: string,
  requestedId?: string,
): Promise<Guide | null> {
  const selectedId =
    requestedId ??
    (await getWorkspaceSetting(workspaceId, DOCUMENTATION_AGENT_KEY));
  if (selectedId) {
    const [selected] = await db
      .select({ id: agentsTable.id, name: agentsTable.name })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.workspaceId, workspaceId),
          eq(agentsTable.id, selectedId),
          eq(agentsTable.archived, false),
          eq(agentsTable.retired, false),
        ),
      )
      .limit(1);
    if (selected) return selected;
    if (requestedId) return null;
  }
  const [fallback] = await db
    .select({ id: agentsTable.id, name: agentsTable.name })
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.workspaceId, workspaceId),
        eq(agentsTable.archived, false),
        eq(agentsTable.retired, false),
      ),
    )
    .orderBy(asc(agentsTable.createdAt), asc(agentsTable.id))
    .limit(1);
  return fallback ?? null;
}

function documentationPayload(guide: Guide | null) {
  return {
    productName: "Crustabox",
    assistantName: guide?.name ?? null,
    assistantAgentId: guide?.id ?? null,
    sections: CRUSTABOX_DOCUMENTATION,
  };
}

router.get("/documentation", async (req: Request, res: Response) => {
  const guide = await availableGuide(req.workspaceId!);
  res.json(GetDocumentationResponse.parse(documentationPayload(guide)));
});

router.put("/documentation/settings", async (req: Request, res: Response) => {
  const parsed = UpdateDocumentationSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a Documentation Crustabot." });
    return;
  }
  const guide = await availableGuide(req.workspaceId!, parsed.data.agentId);
  if (!guide) {
    res.status(404).json({ error: "That Crustabot is not available." });
    return;
  }
  await setWorkspaceSetting(
    req.workspaceId!,
    DOCUMENTATION_AGENT_KEY,
    guide.id,
  );
  await recordAudit(
    req.workspaceId!,
    "documentation.settings",
    `${guide.name} became the Documentation Crustabot.`,
  );
  res.json(
    UpdateDocumentationSettingsResponse.parse(documentationPayload(guide)),
  );
});

router.post("/documentation/chat", async (req: Request, res: Response) => {
  const parsed = ChatWithDocumentationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A documentation question is required." });
    return;
  }
  const guide = await availableGuide(req.workspaceId!);
  if (!guide) {
    res.status(409).json({
      error: "Recruit a Crustabot before using Documentation chat.",
    });
    return;
  }
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  try {
    const answer = await answerDocumentationQuestion({
      workspaceId: req.workspaceId!,
      agentId: guide.id,
      question: parsed.data.text,
      history: (parsed.data.history ?? []) as DocumentationConversationTurn[],
      documentation: documentationPromptContext(),
      signal: controller.signal,
    });
    res.json(
      ChatWithDocumentationResponse.parse({
        reply: answer.reply,
        assistantName: answer.agentName,
        assistantAgentId: answer.agentId,
      }),
    );
  } catch (error) {
    if (error instanceof ConverseWithAgentError) {
      if (!res.headersSent) {
        res.status(error.status).json({ error: error.message });
      }
      return;
    }
    throw error;
  }
});

export default router;
