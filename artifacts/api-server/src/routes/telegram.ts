import {
  CreateTelegramLinkCodeBody,
  CreateTelegramLinkCodeResponse,
  GetTelegramStatusResponse,
  RemoveTelegramLinkResponse,
} from "@workspace/api-zod";
import { Router, type IRouter } from "express";
import {
  TelegramLinkError,
  createTelegramLinkCode,
  getTelegramStatus,
  removeTelegramLink,
} from "../telegram/service";

const router: IRouter = Router();

router.get("/telegram/status", async (req, res): Promise<void> => {
  res.json(
    GetTelegramStatusResponse.parse(await getTelegramStatus(req.workspaceId!)),
  );
});

router.post("/telegram/link-code", async (req, res): Promise<void> => {
  const body = CreateTelegramLinkCodeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Choose an agent for Telegram Talk." });
    return;
  }
  try {
    const code = await createTelegramLinkCode({
      workspaceId: req.workspaceId!,
      agentId: body.data.agentId,
    });
    res.json(CreateTelegramLinkCodeResponse.parse(code));
  } catch (error) {
    if (error instanceof TelegramLinkError) {
      res
        .status(error.kind === "not_configured" ? 503 : 404)
        .json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.delete("/telegram/link", async (req, res): Promise<void> => {
  res.json(
    RemoveTelegramLinkResponse.parse({
      unlinked: await removeTelegramLink(req.workspaceId!),
    }),
  );
});

export default router;
