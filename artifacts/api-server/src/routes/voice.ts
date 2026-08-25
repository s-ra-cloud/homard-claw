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
import {
  agentMessagesTable,
  agentsTable,
  db,
  talkExchangesTable,
  workspaceSettingsTable,
} from "@workspace/db";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { recordAudit } from "../audit";
import { logger } from "../lib/logger";
import { sanitizeErrorMessage } from "../lib/sanitize";
import { callProvider, ProviderCallError } from "../execution";
import { resolveRouting } from "../providers";
import { CodexTalkError, runCodexTalkTurn } from "../talk-codex";
import {
  getWorkspaceSetting,
  getWorkspaceSettingVia,
  setWorkspaceSetting,
} from "../workspace";
const router: IRouter = Router();

const TRANSCRIPTS_KEY = "voice_transcripts_enabled";
/** ~20MB of base64 ≈ 15MB of audio ≈ several minutes of speech. */
const MAX_AUDIO_BASE64_CHARS = 20 * 1024 * 1024;
const REPLY_MAX_TOKENS = 500;
const CONVERSE_TIMEOUT_MS = 60_000;
/**
 * A live conversation cannot wait out the worker's minute-scale backoff, but
 * one quick retry clears most single 5xx/dropped-connection blips before the
 * owner ever sees an error. Short enough to stay well inside the request
 * timeout, long enough to let a load balancer swap backends.
 */
const CONVERSE_RETRY_DELAY_MS = 500;

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

async function transcriptsEnabled(workspaceId: string): Promise<boolean> {
  return (await getWorkspaceSetting(workspaceId, TRANSCRIPTS_KEY)) === "true";
}

/**
 * Clear-vs-persist ordering: each agent has a clear epoch — a counter that
 * every clear-history increments inside its own transaction (DB-ordered, no
 * host clocks involved). A converse request captures the epoch as its very
 * first await, and the transcript persist re-reads it under the per-agent
 * lock just before inserting: any clear that landed in between changed the
 * epoch, so the persist is skipped instead of silently repopulating history
 * the owner just wiped.
 */
const clearedMarkerKey = (agentId: string) => `voice_history_cleared:${agentId}`;

async function readClearEpoch(workspaceId: string, agentId: string): Promise<number> {
  const raw = await getWorkspaceSetting(workspaceId, clearedMarkerKey(agentId));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Epoch read bound to a specific executor. Inside persistTranscript this
 * MUST be the transaction that holds the advisory lock: reading through the
 * global `db` there would check out a second pool connection per in-flight
 * transaction and deadlock the pool under concurrent Talk turns.
 */
async function readClearEpochVia(
  executor: Pick<typeof db, "select">,
  workspaceId: string,
  agentId: string,
): Promise<number> {
  const raw = await getWorkspaceSettingVia(executor, workspaceId, clearedMarkerKey(agentId));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Per-agent transaction-scoped advisory lock class serializing history
 * clears against transcript persists. Distinct from the worker lease
 * (0x484f4d41), memory/knowledge quota locks (872_001/872_002), and the
 * audit chain lock (872_004) — see the advisory-lock key registry.
 */
const TALK_HISTORY_LOCK = 872_005;

function lockTalkHistory(
  executor: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  agentId: string,
): Promise<unknown> {
  return executor.execute(
    sql`SELECT pg_advisory_xact_lock(${TALK_HISTORY_LOCK}, hashtext(${agentId}))`,
  );
}


async function emergencyStopEngaged(workspaceId: string): Promise<boolean> {
  return (await getWorkspaceSetting(workspaceId, "emergency_stop")) === "true";
}

async function voiceStatusPayload(workspaceId: string) {
  const { available, reason } = speechAvailability();
  return {
    available,
    reason,
    transcriptsEnabled: await transcriptsEnabled(workspaceId),
  };
}

router.get("/voice/status", async (req: Request, res: Response) => {
  res.json(await voiceStatusPayload(req.workspaceId!));
});

router.put("/voice/settings", async (req: Request, res: Response) => {
  const parsed = UpdateVoiceSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "transcriptsEnabled must be a boolean." });
    return;
  }
  const value = parsed.data.transcriptsEnabled ? "true" : "false";
  await setWorkspaceSetting(req.workspaceId!, TRANSCRIPTS_KEY, value);
  await recordAudit(
    req.workspaceId!,
    "voice.settings",
    parsed.data.transcriptsEnabled
      ? "Voice transcript storage was turned on."
      : "Voice transcript storage was turned off.",
  );
  res.json(await voiceStatusPayload(req.workspaceId!));
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
    res.status(400).json({ error: "The audio recording could not be decoded." });
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
  workspaceId: string,
  agentId: string,
  res: Response,
): Promise<AgentRow | null> {
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(
      and(eq(agentsTable.id, agentId), eq(agentsTable.workspaceId, workspaceId)),
    )
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
  if (await emergencyStopEngaged(workspaceId)) {
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

/**
 * Sleep that gives up the moment the conversation's own controller aborts, so
 * a retry can never outlive the request timeout or a disconnected client.
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function generateReply(
  workspaceId: string,
  agent: AgentRow,
  userText: string,
  history: ConverseTurn[],
  signal: AbortSignal,
  attachments: Array<{ name: string; mimeType: string; encoding: "text" | "base64"; content: string }> = [],
): Promise<{ reply: string; taskObjective: string | null }> {
  const routing = await resolveRouting(workspaceId, agent);

  if (routing.provider === "codex_chatgpt") {
    // Codex executes in a sandbox, so a Talk turn needs the same safe
    // context a task run gets: an isolated per-agent workspace, the
    // agent's current sandbox restrictions, thread continuity, and the
    // durable ChatGPT-credential lease. No quick retry here — repeating a
    // subscription call risks double-spending the allowance, and the lease
    // wait already absorbs short contention.
    const result = await runCodexTalkTurn({
      agent: {
        id: agent.id,
        workspaceId,
        securityPreset: agent.securityPreset,
        autonomy: agent.autonomy,
        sensitiveDataSandbox: agent.sensitiveDataSandbox,
      },
      model: routing.model,
      reasoningEffort: routing.reasoningEffort,
      system: buildSystemPrompt(agent),
      prompt: buildPrompt(history, userText, agent.name),
      attachments,
      maxOutputTokens: REPLY_MAX_TOKENS,
      signal,
    });
    return parseModelReply(result.output);
  }

  const call = () =>
    callProvider({
      provider: routing.provider,
      model: routing.model,
      system: buildSystemPrompt(agent),
      prompt: buildPrompt(history, userText, agent.name),
      attachments,
      maxOutputTokens: REPLY_MAX_TOKENS,
      signal,
    });

  let result;
  try {
    result = await call();
  } catch (err) {
    // Only ProviderCallError.retryable kinds (transient, rate_limit) are safe
    // to repeat: the provider never produced a reply. Auth, not_configured,
    // policy, cancellation, and timeout failures stay terminal — repeating
    // them just makes the owner wait longer for the same message.
    if (!(err instanceof ProviderCallError) || !err.retryable || signal.aborted) {
      throw err;
    }
    await abortableDelay(CONVERSE_RETRY_DELAY_MS, signal);
    if (signal.aborted) throw err;
    result = await call();
  }
  return parseModelReply(result.output);
}

/**
 * Store one exchange in the agent's Talk history.
 *
 * Typed exchanges are always kept — Talk is a chat surface and owners expect
 * history to survive a refresh. Spoken exchanges honor the workspace's
 * voice-transcript privacy setting (`force` stays false for those), so
 * turning transcripts off still keeps spoken words out of the database.
 */
async function persistTranscript(
  workspaceId: string,
  agent: AgentRow,
  userText: string,
  reply: string,
  clearEpoch: number,
  force = false,
  tx?: Pick<typeof db, "insert" | "execute" | "select">,
) {
  if (!force && !(await transcriptsEnabled(workspaceId))) return;
  // Serialize against clear-history: the epoch check and the insert hold
  // the per-agent advisory lock in one transaction, and clearing bumps the
  // epoch + deletes under the same lock. A turn whose request began before
  // a clear therefore either commits before the delete (and its rows are
  // deleted with the rest) or observes the changed epoch and skips
  // persisting — it can never repopulate history the owner just wiped.
  const run = async (executor: Pick<typeof db, "insert" | "execute" | "select">) => {
    await lockTalkHistory(executor, agent.id);
    if ((await readClearEpochVia(executor, workspaceId, agent.id)) !== clearEpoch) return;
    await executor.insert(agentMessagesTable).values([
      { fromAgentId: null, toAgentId: agent.id, kind: "voice", body: userText },
      { fromAgentId: agent.id, toAgentId: null, kind: "voice", body: reply },
    ]);
  };
  if (tx) {
    await run(tx);
  } else {
    await db.transaction(run);
  }
}

/**
 * Server-side record of what actually went wrong. The response only ever
 * carries the fixed sanitized text, so without this line a production
 * failure is undiagnosable — the owner sees the category and the logs hold
 * the (already sanitized) underlying detail.
 */
function logTalkFailure(agentId: string, surface: "text" | "voice", err: unknown): void {
  const kind =
    err instanceof CodexTalkError
      ? `codex:${err.kind}`
      : err instanceof ProviderCallError
        ? `provider:${err.kind}`
        : "unknown";
  // Sanitized and bounded: provider errors can echo the failing request,
  // and unknown errors may carry anything.
  logger.warn(
    {
      agentId,
      surface,
      failureKind: kind,
      detail: sanitizeErrorMessage(
        err instanceof Error ? err.message : String(err),
      ).slice(0, 500),
    },
    "Talk turn failed",
  );
}

/** Fixed, sanitized messages only — never echo upstream provider detail. */
function providerErrorMessage(err: unknown): { status: number; message: string } {
  if (err instanceof CodexTalkError) {
    // Codex failures get their own accurate messages: a workspace or
    // sign-in problem is not a missing API key, and saying so sends the
    // owner to the wrong fix.
    switch (err.kind) {
      case "workspace":
        return {
          status: 500,
          message:
            "The agent's private Codex workspace could not be prepared. Try again; if this keeps happening, check the server's Codex workspace configuration.",
        };
      case "setup":
        return {
          status: 503,
          message:
            "Codex setup error: the ChatGPT connection is not ready, so this agent could not start its Talk turn. Open Providers and connect or repair ChatGPT, then resend.",
        };
      case "auth":
        return {
          status: 503,
          message:
            "Codex authentication error: the ChatGPT session was rejected. Open Providers, reconnect ChatGPT, then resend this message.",
        };
      case "busy":
        return {
          status: 503,
          message:
            "Codex busy error: this agent's ChatGPT session is already running another task. Wait for it to finish, then resend this message.",
        };
      case "allowance":
        return {
          status: 503,
          message:
            "Codex allowance error: the ChatGPT plan has no allowance left for this turn. Check the ChatGPT plan or allowance, then resend when available.",
        };
      case "rate_limit":
        return {
          status: 503,
          message: "Codex rate-limit error: ChatGPT asked us to slow down. Wait a moment, then resend this message.",
        };
      case "timeout":
        return {
          status: 503,
          message:
            "Codex timeout error: ChatGPT did not finish within the Talk time limit. Try a shorter message or resend in a moment.",
        };
      case "cancelled":
        return { status: 499, message: "The conversation was interrupted." };
      default:
        return {
          status: 503,
          message:
            "Codex provider error: ChatGPT could not complete this Talk turn. Check Providers for connection status, then resend.",
        };
    }
  }
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
      case "transient":
        return {
          status: 503,
          message: "The response provider is temporarily unavailable. Try again.",
        };
      case "timeout":
        return { status: 503, message: "The response provider timed out. Try again." };
      default:
        return { status: 503, message: "The response provider failed. Try again." };
    }
  }
  return { status: 500, message: "The agent could not answer just now." };
}

/**
 * Stored Talk history with one agent, oldest first. Reading history is
 * harmless, so unlike conversing it works even for retired agents or while
 * the emergency stop is engaged — the owner can always re-read what was said.
 */
const TALK_HISTORY_LIMIT = 200;
router.get("/agents/:agentId/talk-history", async (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const [agent] = await db
    .select({ id: agentsTable.id, archived: agentsTable.archived })
    .from(agentsTable)
    .where(
      and(eq(agentsTable.id, agentId), eq(agentsTable.workspaceId, req.workspaceId!)),
    )
    .limit(1);
  if (!agent || agent.archived) {
    res.status(404).json({ error: "Agent not found." });
    return;
  }
  const rows = await db
    .select()
    .from(agentMessagesTable)
    .where(
      and(
        eq(agentMessagesTable.kind, "voice"),
        or(
          eq(agentMessagesTable.fromAgentId, agentId),
          eq(agentMessagesTable.toAgentId, agentId),
        ),
      ),
    )
    .orderBy(desc(agentMessagesTable.createdAt), desc(agentMessagesTable.id))
    .limit(TALK_HISTORY_LIMIT);
  // Same-timestamp pairs (one insert stores both sides of an exchange) sort
  // user-before-agent so the transcript reads in speaking order.
  const turns = rows
    .reverse()
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        Number(a.fromAgentId !== null) - Number(b.fromAgentId !== null),
    )
    .map((row) => ({
      id: row.id,
      role: row.fromAgentId === null ? ("user" as const) : ("agent" as const),
      text: row.body,
      createdAt: row.createdAt.toISOString(),
    }));
  res.json({ turns });
});

/**
 * Clear the stored Talk history with one agent. Workspace-scoped: the agent
 * must belong to the caller's workspace, and only that agent's kind='voice'
 * rows are removed. Like reading history, clearing works even for retired
 * agents or during an emergency stop — it never starts a conversation.
 */
router.delete("/agents/:agentId/talk-history", async (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const [agent] = await db
    .select({ id: agentsTable.id, name: agentsTable.name, archived: agentsTable.archived })
    .from(agentsTable)
    .where(
      and(eq(agentsTable.id, agentId), eq(agentsTable.workspaceId, req.workspaceId!)),
    )
    .limit(1);
  if (!agent || agent.archived) {
    res.status(404).json({ error: "Agent not found." });
    return;
  }
  // One transaction under the per-agent advisory lock: bump the clear epoch
  // and delete the rows atomically. persistTranscript takes the same lock
  // around its epoch check + insert, so an in-flight turn either commits
  // before this delete (and its rows go with the rest) or sees the changed
  // epoch afterwards and skips persisting. The increment is DB-ordered —
  // no host clock is ever compared.
  const deleted = await db.transaction(async (tx) => {
    await lockTalkHistory(tx, agentId);
    await tx
      .insert(workspaceSettingsTable)
      .values({
        workspaceId: req.workspaceId!,
        key: clearedMarkerKey(agentId),
        value: "1",
      })
      .onConflictDoUpdate({
        target: [workspaceSettingsTable.workspaceId, workspaceSettingsTable.key],
        set: {
          value: sql`(${workspaceSettingsTable.value}::bigint + 1)::text`,
        },
      });
    return tx
      .delete(agentMessagesTable)
      .where(
        and(
          eq(agentMessagesTable.kind, "voice"),
          or(
            eq(agentMessagesTable.fromAgentId, agentId),
            eq(agentMessagesTable.toAgentId, agentId),
          ),
        ),
      )
      .returning({ id: agentMessagesTable.id });
  });
  await recordAudit(
    req.workspaceId!,
    "voice.history_cleared",
    `The Talk history with ${agent.name} was cleared (${deleted.length} stored turns).`,
  );
  res.json({ deleted: deleted.length });
});

/**
 * Resend idempotency: a reply can be generated and persisted while the
 * client's connection drops, so a resend of the same message must return the
 * already-generated reply instead of creating a duplicate exchange.
 *
 * The guarantee is durable and atomic: `INSERT ... ON CONFLICT DO NOTHING`
 * on talk_exchanges' unique (workspace, agent, client message id) index
 * claims the exchange before any provider call. Exactly one of two
 * concurrent duplicates wins the claim; the loser (and any later retry,
 * across restarts and instances) sees the existing row and either replays
 * the stored response or reports that the original is still in flight.
 *
 * A claim whose provider call fails is deleted so the owner's retry can
 * proceed. A claim orphaned by a crash mid-call is retried after
 * PENDING_CLAIM_TIMEOUT_MS instead of blocking the message forever.
 */
const PENDING_CLAIM_TIMEOUT_MS = CONVERSE_TIMEOUT_MS * 2 + 30_000;

async function claimExchange(
  workspaceId: string,
  agentId: string,
  clientMessageId: string,
): Promise<
  | { kind: "claimed"; claimId: string }
  | { kind: "done"; payload: Record<string, unknown> }
  | { kind: "in_flight" }
> {
  const inserted = await db
    .insert(talkExchangesTable)
    .values({ workspaceId, agentId, clientMessageId })
    .onConflictDoNothing()
    .returning({ id: talkExchangesTable.id });
  if (inserted.length > 0) return { kind: "claimed", claimId: inserted[0].id };

  const [existing] = await db
    .select()
    .from(talkExchangesTable)
    .where(
      and(
        eq(talkExchangesTable.workspaceId, workspaceId),
        eq(talkExchangesTable.agentId, agentId),
        eq(talkExchangesTable.clientMessageId, clientMessageId),
      ),
    )
    .limit(1);
  if (!existing) {
    // Raced with a failed claim's cleanup; let the caller try fresh.
    return claimExchange(workspaceId, agentId, clientMessageId);
  }
  if (existing.status === "done" && existing.responseJson) {
    return { kind: "done", payload: JSON.parse(existing.responseJson) };
  }
  // Pending: either genuinely in flight, or orphaned by a crash. Reclaim
  // orphans by deleting the stale row and claiming again.
  if (Date.now() - existing.createdAt.getTime() > PENDING_CLAIM_TIMEOUT_MS) {
    // Only a still-pending row may be reclaimed; if the original finished
    // in the meantime the next claim attempt replays its stored response.
    await db
      .delete(talkExchangesTable)
      .where(
        and(
          eq(talkExchangesTable.id, existing.id),
          eq(talkExchangesTable.status, "pending"),
        ),
      );
    return claimExchange(workspaceId, agentId, clientMessageId);
  }
  return { kind: "in_flight" };
}

/** Text fallback: plain JSON request/response, no speech services involved. */
router.post("/agents/:agentId/converse", async (req: Request, res: Response) => {
  const parsed = ConverseWithAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A text message is required." });
    return;
  }
  // Captured before any other await: a clear that lands anywhere after this
  // point changes the epoch and vetoes this request's transcript persist.
  const clearEpoch = await readClearEpoch(
    req.workspaceId!,
    String(req.params.agentId),
  );
  const agent = await loadConversableAgent(
    req.workspaceId!,
    String(req.params.agentId),
    res,
  );
  if (!agent) return;

  const clientMessageId = parsed.data.clientMessageId;
  let claimId: string | null = null;
  if (clientMessageId) {
    const claim = await claimExchange(req.workspaceId!, agent.id, clientMessageId);
    if (claim.kind === "done") {
      res.json(claim.payload);
      return;
    }
    if (claim.kind === "in_flight") {
      res.status(409).json({
        error: "This message is already being delivered. Give it a moment.",
      });
      return;
    }
    claimId = claim.claimId;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONVERSE_TIMEOUT_MS * 2);
  req.on("close", () => controller.abort());
  try {
    const history = (parsed.data.history ?? []) as ConverseTurn[];
    const { reply, taskObjective } = await generateReply(
      req.workspaceId!,
      agent,
      parsed.data.text,
      history,
      controller.signal,
      parsed.data.attachments,
    );
    const payload = {
      reply,
      proposedTaskObjective: taskObjective,
      voice: agentVoice(agent),
    };
    if (claimId) {
      // Crash safety: history rows and the claim's "done" state commit
      // atomically, so a crash before this point leaves nothing persisted
      // (the released/expired claim lets a retry regenerate cleanly) and a
      // crash after it replays the stored response. The status='pending'
      // guard means a stolen/expired claim skips persisting instead of
      // duplicating rows the reclaimer will write.
      const ownedClaimId = claimId;
      const finalized = await db.transaction(async (tx) => {
        const updated = await tx
          .update(talkExchangesTable)
          .set({ status: "done", responseJson: JSON.stringify(payload) })
          .where(
            and(
              eq(talkExchangesTable.id, ownedClaimId),
              eq(talkExchangesTable.status, "pending"),
            ),
          )
          .returning({ id: talkExchangesTable.id });
        if (updated.length === 0) return false;
        await persistTranscript(req.workspaceId!, agent, parsed.data.text, reply, clearEpoch, true, tx);
        return true;
      });
      // Ownership is consumed either way: nothing past this point may
      // release or delete the claim (a post-finalization failure such as a
      // broken audit write must leave the done claim for replay).
      claimId = null;
      if (!finalized) {
        // Lost ownership: our claim was reclaimed while we ran (stale-claim
        // timeout). The reclaimer's outcome is authoritative — replay it
        // rather than answering with our own uncommitted reply, which would
        // double-deliver the message.
        const [authoritative] = await db
          .select()
          .from(talkExchangesTable)
          .where(
            and(
              eq(talkExchangesTable.workspaceId, req.workspaceId!),
              eq(talkExchangesTable.agentId, agent.id),
              eq(talkExchangesTable.clientMessageId, clientMessageId!),
            ),
          )
          .limit(1);
        if (authoritative?.status === "done" && authoritative.responseJson) {
          res.json(JSON.parse(authoritative.responseJson));
          return;
        }
        res.status(409).json({
          error: "This message is being retried elsewhere. Give it a moment.",
        });
        return;
      }
    } else {
      await persistTranscript(req.workspaceId!, agent, parsed.data.text, reply, clearEpoch, true);
    }
    await recordAudit(
      req.workspaceId!,
      "voice.converse",
      `${agent.name} chatted with the owner (text mode).`,
    );
    res.json(payload);
  } catch (err) {
    // Release only a claim we still own and that never finalized, so the
    // owner's resend can try again. A finalized claim must survive for
    // replay even when later steps fail.
    if (claimId) {
      await db
        .delete(talkExchangesTable)
        .where(
          and(
            eq(talkExchangesTable.id, claimId),
            eq(talkExchangesTable.status, "pending"),
          ),
        )
        .catch(() => {});
    }
    logTalkFailure(agent.id, "text", err);
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
  // Captured before any other await: a clear that lands anywhere after this
  // point changes the epoch and vetoes this request's transcript persist.
  const clearEpoch = await readClearEpoch(
    req.workspaceId!,
    String(req.params.agentId),
  );
  const agent = await loadConversableAgent(
    req.workspaceId!,
    String(req.params.agentId),
    res,
  );
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
        req.workspaceId!,
        agent,
        userText,
        history,
        controller.signal,
      ));
    } catch (err) {
      logTalkFailure(agent.id, "voice", err);
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

    await persistTranscript(req.workspaceId!, agent, userText, reply, clearEpoch);
    await recordAudit(
      req.workspaceId!,
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
