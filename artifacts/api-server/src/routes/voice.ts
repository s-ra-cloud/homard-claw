/**
 * Voice + text conversations with agents.
 *
 * Speech services (transcription and spoken replies) run through the
 * Replit-managed OpenAI AI integration; agent replies themselves come from
 * the agent's own configured provider, exactly like task execution.
 *
 * The audio module is imported lazily so a missing integration degrades to a
 * clear "voice unavailable" status instead of crashing the whole server.
 */
import {
  ConverseWithAgentBody,
  TranscribeAudioBody,
  UpdateVoiceSettingsBody,
  VoiceConverseWithAgentBody,
} from "@workspace/api-zod";
import { agentMessagesTable, agentsTable, db, systemStateTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { recordAudit } from "../audit";
import { callProvider, ProviderCallError } from "../execution";
import { resolveRouting } from "../providers";

const router: IRouter = Router();

const TRANSCRIPTS_KEY = "voice_transcripts_enabled";
/** ~20MB of base64 ≈ 15MB of audio ≈ several minutes of speech. */
const MAX_AUDIO_BASE64_CHARS = 20 * 1024 * 1024;
const REPLY_MAX_TOKENS = 500;
const CONVERSE_TIMEOUT_MS = 60_000;

type AgentRow = typeof agentsTable.$inferSelect;

/** Map HomardClaw voice styles to OpenAI voices; "none" means text only. */
const VOICE_MAP: Record<string, "alloy" | "nova" | "onyx" | "shimmer" | null> = {
  none: null,
  warm: "nova",
  crisp: "alloy",
  deep: "onyx",
  bubbly: "shimmer",
};

function agentVoice(agent: AgentRow): "alloy" | "nova" | "onyx" | "shimmer" | null {
  const style = (agent.voiceStyle ?? "").toLowerCase();
  if (style in VOICE_MAP) return VOICE_MAP[style];
  return "alloy";
}

function speechAvailability(): { available: boolean; reason: string | null } {
  if (
    !process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||
    !process.env.AI_INTEGRATIONS_OPENAI_API_KEY
  ) {
    return {
      available: false,
      reason:
        "The managed speech service is not provisioned. Text chat still works; ask your administrator to enable the OpenAI AI integration for voice.",
    };
  }
  return { available: true, reason: null };
}

async function transcriptsEnabled(): Promise<boolean> {
  const [row] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, TRANSCRIPTS_KEY))
    .limit(1);
  return row?.value === "true";
}

async function emergencyStopEngaged(): Promise<boolean> {
  const [row] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "emergency_stop"))
    .limit(1);
  return row?.value === "true";
}

async function voiceStatusPayload() {
  const { available, reason } = speechAvailability();
  return { available, reason, transcriptsEnabled: await transcriptsEnabled() };
}

router.get("/voice/status", async (_req: Request, res: Response) => {
  res.json(await voiceStatusPayload());
});

router.put("/voice/settings", async (req: Request, res: Response) => {
  const parsed = UpdateVoiceSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "transcriptsEnabled must be a boolean." });
    return;
  }
  const value = parsed.data.transcriptsEnabled ? "true" : "false";
  await db
    .insert(systemStateTable)
    .values({ key: TRANSCRIPTS_KEY, value })
    .onConflictDoUpdate({
      target: systemStateTable.key,
      set: { value: sql`excluded.value` },
    });
  await recordAudit(
    "voice.settings",
    parsed.data.transcriptsEnabled
      ? "Voice transcript storage was turned on."
      : "Voice transcript storage was turned off.",
  );
  res.json(await voiceStatusPayload());
});

/**
 * Live captions: transcribe the audio captured so far, mid-recording.
 * Best-effort — the voice-converse stream re-transcribes the final recording,
 * which stays authoritative for confirmations and history.
 */
router.post("/voice/transcribe", async (req: Request, res: Response) => {
  const availability = speechAvailability();
  if (!availability.available) {
    res.status(503).json({ error: availability.reason });
    return;
  }
  const parsed = TranscribeAudioBody.safeParse(req.body);
  if (!parsed.success || parsed.data.audio.length > MAX_AUDIO_BASE64_CHARS) {
    res.status(400).json({ error: "A base64 audio payload is required." });
    return;
  }
  let audioBuffer: Buffer;
  try {
    audioBuffer = Buffer.from(parsed.data.audio, "base64");
    if (audioBuffer.length === 0) throw new Error("empty");
  } catch {
    res.status(400).json({ error: "The audio payload could not be decoded." });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  req.on("close", () => controller.abort());
  try {
    const audio = await import("@workspace/integrations-openai-ai-server/audio");
    const compatible = await audio.ensureCompatibleFormat(audioBuffer);
    const text = (
      await audio.speechToText(compatible.buffer, compatible.format, controller.signal)
    ).trim();
    res.json({ text });
  } catch {
    if (!res.headersSent && !controller.signal.aborted) {
      res.status(502).json({ error: "Transcription failed." });
    }
  } finally {
    clearTimeout(timeout);
  }
});

/** Shared guardrails: the agent must exist and be able to hold a chat. */
async function loadConversableAgent(
  agentId: string,
  res: Response,
): Promise<AgentRow | null> {
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1);
  if (!agent || agent.archived) {
    res.status(404).json({ error: "Agent not found." });
    return null;
  }
  if (agent.retired) {
    res.status(409).json({
      error: `${agent.name} has retired to the beach and no longer takes calls.`,
    });
    return null;
  }
  if (await emergencyStopEngaged()) {
    res.status(409).json({
      error: "The emergency stop is engaged; agents cannot converse until it is released.",
    });
    return null;
  }
  return agent;
}

type ConverseTurn = { role: "user" | "agent"; text: string };

function buildSystemPrompt(agent: AgentRow): string {
  const traits = [
    agent.title ? `Your job title is "${agent.title}".` : "",
    agent.personality ? `Personality: ${agent.personality}.` : "",
    agent.specialization ? `Specialization: ${agent.specialization}.` : "",
    agent.mission ? `Current mission: ${agent.mission}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [
    `You are ${agent.name}, a lobster agent working in the HomardClaw office. ${traits}`,
    "You are having a short live conversation with your owner (the Director).",
    "Reply in character, warmly and concisely: one to three short sentences, plain spoken language, no markdown, no lists, no emojis.",
    "You CANNOT start work from a conversation. If the owner asks you to actually do something, describe a single clear task objective in the taskObjective field. The task is only queued after the owner explicitly confirms it, and it still goes through the office's normal approval policy — never claim work has started.",
    'Respond with STRICT JSON exactly like {"reply": "...", "taskObjective": null} or {"reply": "...", "taskObjective": "..."} and nothing else.',
  ].join("\n");
}

function buildPrompt(history: ConverseTurn[], userText: string, agentName: string): string {
  const lines = history
    .slice(-10)
    .map((t) => `${t.role === "user" ? "Owner" : agentName}: ${t.text}`);
  lines.push(`Owner: ${userText}`);
  lines.push(`${agentName} (JSON):`);
  return lines.join("\n");
}

/** Parse the model's JSON reply, tolerating code fences and stray prose. */
function parseModelReply(raw: string): { reply: string; taskObjective: string | null } {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const candidates = [stripped];
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(stripped.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "reply" in parsed &&
        typeof (parsed as { reply: unknown }).reply === "string" &&
        (parsed as { reply: string }).reply.trim()
      ) {
        const objectiveRaw = (parsed as { taskObjective?: unknown }).taskObjective;
        const objective =
          typeof objectiveRaw === "string" ? objectiveRaw.trim() : "";
        return {
          reply: (parsed as { reply: string }).reply.trim(),
          taskObjective: objective || null,
        };
      }
    } catch {
      // fall through to the next candidate
    }
  }
  // The model ignored the JSON contract; treat the whole output as speech.
  return { reply: stripped || "…", taskObjective: null };
}

async function generateReply(
  agent: AgentRow,
  userText: string,
  history: ConverseTurn[],
  signal: AbortSignal,
): Promise<{ reply: string; taskObjective: string | null }> {
  const routing = await resolveRouting(agent);
  const result = await callProvider({
    provider: routing.provider,
    model: routing.model,
    system: buildSystemPrompt(agent),
    prompt: buildPrompt(history, userText, agent.name),
    maxOutputTokens: REPLY_MAX_TOKENS,
    signal,
  });
  return parseModelReply(result.output);
}

async function persistTranscript(agent: AgentRow, userText: string, reply: string) {
  if (!(await transcriptsEnabled())) return;
  await db.insert(agentMessagesTable).values([
    { fromAgentId: null, toAgentId: agent.id, kind: "voice", body: userText },
    { fromAgentId: agent.id, toAgentId: null, kind: "voice", body: reply },
  ]);
}

/** Fixed, sanitized messages only — never echo upstream provider detail. */
function providerErrorMessage(err: unknown): { status: number; message: string } {
  if (err instanceof ProviderCallError) {
    switch (err.kind) {
      case "not_configured":
        return {
          status: 503,
          message:
            "This agent's response provider is not configured. Add a provider key on the Providers page.",
        };
      case "cancelled":
        return { status: 499, message: "The conversation was interrupted." };
      case "auth":
        return {
          status: 503,
          message: "The response provider rejected its credentials. Check the Providers page.",
        };
      case "rate_limit":
        return {
          status: 503,
          message: "The response provider is rate limiting; try again in a moment.",
        };
      case "timeout":
        return { status: 503, message: "The response provider timed out. Try again." };
      default:
        return { status: 503, message: "The response provider failed. Try again." };
    }
  }
  return { status: 500, message: "The agent could not answer just now." };
}

/** Text fallback: plain JSON request/response, no speech services involved. */
router.post("/agents/:agentId/converse", async (req: Request, res: Response) => {
  const parsed = ConverseWithAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A non-empty text message is required." });
    return;
  }
  const agent = await loadConversableAgent(String(req.params.agentId), res);
  if (!agent) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONVERSE_TIMEOUT_MS);
  req.on("close", () => controller.abort());
  try {
    const history = (parsed.data.history ?? []) as ConverseTurn[];
    const { reply, taskObjective } = await generateReply(
      agent,
      parsed.data.text,
      history,
      controller.signal,
    );
    await persistTranscript(agent, parsed.data.text, reply);
    await recordAudit(
      "voice.converse",
      `${agent.name} chatted with the owner (text mode).`,
    );
    res.json({ reply, proposedTaskObjective: taskObjective, voice: agentVoice(agent) });
  } catch (err) {
    const { status, message } = providerErrorMessage(err);
    if (!res.headersSent) res.status(status).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
});

function sseWrite(res: Response, payload: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Voice round-trip as one SSE stream:
 *   user_transcript -> reply (+ proposed task) -> audio chunks -> done.
 */
router.post("/agents/:agentId/voice-converse", async (req: Request, res: Response) => {
  const availability = speechAvailability();
  if (!availability.available) {
    res.status(503).json({ error: availability.reason });
    return;
  }
  const parsed = VoiceConverseWithAgentBody.safeParse(req.body);
  if (!parsed.success || parsed.data.audio.length > MAX_AUDIO_BASE64_CHARS) {
    res.status(400).json({ error: "A base64 audio recording is required." });
    return;
  }
  const agent = await loadConversableAgent(String(req.params.agentId), res);
  if (!agent) return;

  let audioBuffer: Buffer;
  try {
    audioBuffer = Buffer.from(parsed.data.audio, "base64");
    if (audioBuffer.length === 0) throw new Error("empty");
  } catch {
    res.status(400).json({ error: "The audio recording could not be decoded." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONVERSE_TIMEOUT_MS * 2);
  req.on("close", () => controller.abort());

  try {
    // Lazy import: a missing integration must not crash the server at boot.
    const audio = await import("@workspace/integrations-openai-ai-server/audio");

    let userText: string;
    try {
      const compatible = await audio.ensureCompatibleFormat(audioBuffer);
      userText = (
        await audio.speechToText(compatible.buffer, compatible.format, controller.signal)
      ).trim();
    } catch {
      if (controller.signal.aborted) return;
      sseWrite(res, {
        type: "error",
        fatal: true,
        message:
          "Your recording could not be transcribed. Check your microphone or type your message instead.",
      });
      return;
    }
    if (!userText) {
      sseWrite(res, {
        type: "error",
        fatal: true,
        message: "No speech was detected in the recording. Try again a little closer to the microphone.",
      });
      return;
    }
    sseWrite(res, { type: "user_transcript", text: userText });

    let reply: string;
    let taskObjective: string | null;
    try {
      const history = (parsed.data.history ?? []) as ConverseTurn[];
      ({ reply, taskObjective } = await generateReply(
        agent,
        userText,
        history,
        controller.signal,
      ));
    } catch (err) {
      sseWrite(res, {
        type: "error",
        fatal: true,
        message: providerErrorMessage(err).message,
      });
      return;
    }

    const voice = agentVoice(agent);
    sseWrite(res, {
      type: "reply",
      text: reply,
      proposedTaskObjective: taskObjective,
      voice,
    });

    await persistTranscript(agent, userText, reply);
    await recordAudit(
      "voice.converse",
      `${agent.name} spoke with the owner (voice mode).`,
    );

    if (voice && !controller.signal.aborted) {
      try {
        let seq = 0;
        for await (const chunk of await audio.textToSpeechStream(
          reply,
          voice,
          controller.signal,
        )) {
          if (controller.signal.aborted) break;
          sseWrite(res, { type: "audio", seq: seq++, data: chunk });
        }
      } catch {
        if (!controller.signal.aborted) {
          sseWrite(res, {
            type: "error",
            message: "Spoken playback failed; the reply above is still valid.",
          });
        }
      }
    }
    sseWrite(res, { type: "done" });
  } finally {
    clearTimeout(timeout);
    res.end();
  }
});

export default router;
