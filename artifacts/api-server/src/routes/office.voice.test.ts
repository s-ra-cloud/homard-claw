/**
 * Voice + text conversation routes.
 *
 * Runs against the real development Postgres (see api-server test
 * conventions): impersonate the existing owner, tag and clean up all rows,
 * stub all provider traffic through the global fetch mock, and restore any
 * system_state keys we touch.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentMessagesTable,
  agentsTable,
  db,
  pool,
  systemStateTable,
  workspaceSettingsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray, or } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-voice-test-owner" }));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import officeRouter from "./office";
import { clearProviderCaches } from "../providers";

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Voice ${Date.now()}`;
const createdAgentIds: string[] = [];
let createdOwnerRow = false;
let priorTranscriptsValue: string | null | undefined;
let wsId = "";

/** Minimal RIFF/WAVE header so format detection skips ffmpeg conversion. */
const FAKE_WAV_BASE64 = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([16, 0, 0, 0]),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(32),
]).toString("base64");

const OPENAI_TEST_BASE = "https://openai.test/v1";

async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Voice Tester",
      mission: "Exercise voice conversation rules.",
      provider: "openrouter",
      model: "test-vendor/test-model",
      securityPreset: "assistant",
      autonomy: "autonomous",
      voiceStyle: "deep",
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
      ...extra,
    });
  expect(res.status).toBe(201);
  createdAgentIds.push(res.body.id);
  // Paused agents keep the live development worker away from test rows.
  await request(app).post(`/api/agents/${res.body.id}/pause`).send({ paused: true });
  return res.body as { id: string; name: string };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Route provider traffic by URL: OpenRouter chat, OpenAI STT + TTS.
 * `chatFailStatuses` makes the first N agent-reply calls fail with those HTTP
 * statuses; the returned counter reports how many reply calls were made.
 */
function mockProviders({
  replyJson = '{"reply":"Sure thing, boss.","taskObjective":null}',
  transcript = "Hello there, how is the reef?",
  chatFailStatuses = [],
}: {
  replyJson?: string;
  transcript?: string;
  chatFailStatuses?: number[];
} = {}): { calls: () => number } {
  const failures = [...chatFailStatuses];
  let replyCalls = 0;
  fetchMock.mockImplementation(async (url: unknown) => {
    const target = String(url);
    if (target.includes("/models")) {
      return jsonResponse({
        data: [
          {
            id: "test-vendor/test-model",
            name: "Test Model",
            context_length: 8192,
            pricing: { prompt: "0.000001", completion: "0.00001" },
          },
        ],
      });
    }
    if (target.includes("openai.test") && target.includes("/audio/transcriptions")) {
      return jsonResponse({ text: transcript });
    }
    if (target.includes("openai.test") && target.includes("/chat/completions")) {
      // Streaming TTS: two PCM16 chunks.
      return sseResponse([
        '{"choices":[{"delta":{"audio":{"data":"QUFBQQ=="}}}]}',
        '{"choices":[{"delta":{"audio":{"data":"QkJCQg=="}}}]}',
      ]);
    }
    if (target.includes("/chat/completions")) {
      replyCalls += 1;
      const failure = failures.shift();
      if (failure !== undefined) {
        return jsonResponse({ error: "upstream detail that must never leak" }, failure);
      }
      return jsonResponse({
        choices: [{ message: { content: replyJson } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  });
  return { calls: () => replyCalls };
}

beforeAll(async () => {
  const [owner] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "owner_clerk_id"))
    .limit(1);
  if (owner) {
    authState.userId = owner.value;
  } else {
    createdOwnerRow = true;
  }
  const boot = await request(app).get("/api/agents");
  expect(boot.status).toBe(200);
  const [ws] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.clerkUserId, authState.userId))
    .limit(1);
  wsId = ws.id;
  const [transcripts] = await db
    .select()
    .from(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, wsId),
        eq(workspaceSettingsTable.key, "voice_transcripts_enabled"),
      ),
    )
    .limit(1);
  priorTranscriptsValue = transcripts?.value ?? null;
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error("network disabled in tests");
  });
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "test-claude-token");
  vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", OPENAI_TEST_BASE);
  vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "test-openai-key");
  clearProviderCaches();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (createdAgentIds.length > 0) {
    await db
      .delete(agentMessagesTable)
      .where(
        or(
          inArray(agentMessagesTable.fromAgentId, createdAgentIds),
          inArray(agentMessagesTable.toAgentId, createdAgentIds),
        ),
      );
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  // Restore the transcript toggle exactly as we found it.
  if (priorTranscriptsValue === null) {
    await db
      .delete(workspaceSettingsTable)
      .where(
        and(
          eq(workspaceSettingsTable.workspaceId, wsId),
          eq(workspaceSettingsTable.key, "voice_transcripts_enabled"),
        ),
      );
  } else if (priorTranscriptsValue !== undefined) {
    await db
      .update(workspaceSettingsTable)
      .set({ value: priorTranscriptsValue })
      .where(
        and(
          eq(workspaceSettingsTable.workspaceId, wsId),
          eq(workspaceSettingsTable.key, "voice_transcripts_enabled"),
        ),
      );
  }
  if (createdOwnerRow) {
    // Only remove the owner row if it still holds OUR test identity — a
    // concurrently-claimed real owner must never be deleted.
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

async function setTranscripts(enabled: boolean) {
  const res = await request(app)
    .put("/api/voice/settings")
    .send({ transcriptsEnabled: enabled });
  expect(res.status).toBe(200);
  return res.body;
}

describe("voice status and settings", () => {
  it("reports availability from the managed speech env vars", async () => {
    const res = await request(app).get("/api/voice/status");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.reason).toBeNull();
  });

  it("reports a clear reason when the speech service is not provisioned", async () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", "");
    const res = await request(app).get("/api/voice/status");
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/not provisioned/i);
  });

  it("toggles transcript storage", async () => {
    const on = await setTranscripts(true);
    expect(on.transcriptsEnabled).toBe(true);
    const off = await setTranscripts(false);
    expect(off.transcriptsEnabled).toBe(false);
  });

  it("rejects a malformed settings body", async () => {
    const res = await request(app).put("/api/voice/settings").send({ transcriptsEnabled: "yes" });
    expect(res.status).toBe(400);
  });
});

describe("live-caption transcription", () => {
  it("transcribes a partial recording", async () => {
    mockProviders({ transcript: "so far I said this" });
    const res = await request(app)
      .post("/api/voice/transcribe")
      .send({ audio: FAKE_WAV_BASE64 });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("so far I said this");
  });

  it("rejects an empty payload", async () => {
    const res = await request(app).post("/api/voice/transcribe").send({ audio: "" });
    expect(res.status).toBe(400);
  });

  it("502s cleanly when transcription fails", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes("/audio/transcriptions")) {
        return jsonResponse({ error: "boom" }, 500);
      }
      throw new Error(`unexpected fetch in test: ${target}`);
    });
    const res = await request(app)
      .post("/api/voice/transcribe")
      .send({ audio: FAKE_WAV_BASE64 });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/transcription failed/i);
  });

  it("503s when speech services are unavailable", async () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "");
    const res = await request(app)
      .post("/api/voice/transcribe")
      .send({ audio: FAKE_WAV_BASE64 });
    expect(res.status).toBe(503);
  });
});

describe("text conversations", () => {
  it("returns the agent reply, mapped voice, and no transcript when storage is off", async () => {
    const agent = await createAgent(`${RUN_TAG} Texter`);
    await setTranscripts(false);
    mockProviders();

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "How are you today?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Sure thing, boss.");
    expect(res.body.proposedTaskObjective).toBeNull();
    expect(res.body.voice).toBe("onyx"); // "deep" style

    const rows = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.toAgentId, agent.id));
    expect(rows.filter((r) => r.kind === "voice")).toHaveLength(0);
  });

  it("stores both sides of the exchange when transcripts are enabled", async () => {
    const agent = await createAgent(`${RUN_TAG} Archivist`);
    await setTranscripts(true);
    mockProviders();

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Remember this chat." });
    expect(res.status).toBe(200);

    const toAgent = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.toAgentId, agent.id));
    const fromAgent = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.fromAgentId, agent.id));
    expect(toAgent.some((r) => r.kind === "voice" && r.body === "Remember this chat.")).toBe(true);
    expect(fromAgent.some((r) => r.kind === "voice" && r.body === "Sure thing, boss.")).toBe(true);

    await setTranscripts(false);
  });

  it("surfaces a proposed task objective without creating any task", async () => {
    const agent = await createAgent(`${RUN_TAG} Proposer`);
    mockProviders({
      replyJson:
        '{"reply":"I can get on that once you confirm.","taskObjective":"Summarize the reef report"}',
    });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Please summarize the reef report." });
    expect(res.status).toBe(200);
    expect(res.body.proposedTaskObjective).toBe("Summarize the reef report");
  });

  it("falls back to plain speech when the model ignores the JSON contract", async () => {
    const agent = await createAgent(`${RUN_TAG} Rambler`);
    mockProviders({ replyJson: "Just plain prose, no JSON at all." });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Hi" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Just plain prose, no JSON at all.");
    expect(res.body.proposedTaskObjective).toBeNull();
  });

  it("404s for unknown agents and 409s for retired ones", async () => {
    const missing = await request(app)
      .post("/api/agents/00000000-0000-0000-0000-000000000000/converse")
      .send({ text: "Hello?" });
    expect(missing.status).toBe(404);

    const agent = await createAgent(`${RUN_TAG} Retiree`);
    await db
      .update(agentsTable)
      .set({ retired: true, retiredAt: new Date() })
      .where(eq(agentsTable.id, agent.id));
    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Come back!" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/retired/i);
  });

  it("refuses to converse while the emergency stop is engaged", async () => {
    const agent = await createAgent(`${RUN_TAG} Stopped`);
    const [prior] = await db
      .select()
      .from(workspaceSettingsTable)
      .where(
        and(
          eq(workspaceSettingsTable.workspaceId, wsId),
          eq(workspaceSettingsTable.key, "emergency_stop"),
        ),
      )
      .limit(1);
    await db
      .insert(workspaceSettingsTable)
      .values({ workspaceId: wsId, key: "emergency_stop", value: "true" })
      .onConflictDoUpdate({
        target: [workspaceSettingsTable.workspaceId, workspaceSettingsTable.key],
        set: { value: "true" },
      });
    try {
      const res = await request(app)
        .post(`/api/agents/${agent.id}/converse`)
        .send({ text: "Anyone there?" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/emergency stop/i);
    } finally {
      if (prior) {
        await db
          .update(workspaceSettingsTable)
          // Never leave the shared development workspace stopped, even if a
          // stale true row predated this test.
          .set({ value: "false" })
          .where(
            and(
              eq(workspaceSettingsTable.workspaceId, wsId),
              eq(workspaceSettingsTable.key, "emergency_stop"),
            ),
          );
      } else {
        await db
          .delete(workspaceSettingsTable)
          .where(
            and(
              eq(workspaceSettingsTable.workspaceId, wsId),
              eq(workspaceSettingsTable.key, "emergency_stop"),
            ),
          );
      }
    }
  });

  it("retries once through a transient provider blip and still answers", async () => {
    const agent = await createAgent(`${RUN_TAG} Flaky`);
    const provider = mockProviders({ chatFailStatuses: [503] });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Still with me?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Sure thing, boss.");
    expect(provider.calls()).toBe(2);
  });

  it("gives up after the retry with a sanitized 503", async () => {
    const agent = await createAgent(`${RUN_TAG} Doubly Flaky`);
    const provider = mockProviders({ chatFailStatuses: [503, 503] });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Still with me?" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
    expect(res.body.error).not.toMatch(/upstream detail/i);
    // Exactly one retry: a live conversation never hammers a sick provider.
    expect(provider.calls()).toBe(2);
  });

  it("fails an auth rejection immediately without retrying", async () => {
    const agent = await createAgent(`${RUN_TAG} Rejected`);
    const provider = mockProviders({ chatFailStatuses: [401] });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Hello?" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/credentials/i);
    expect(provider.calls()).toBe(1);
  });

  it("maps a missing provider key to a clear 503", async () => {
    const agent = await createAgent(`${RUN_TAG} Unprovisioned`);
    vi.stubEnv("OPENROUTER_API_KEY", "");
    clearProviderCaches();
    mockProviders();

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Hello?" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/provider/i);
  });
});

describe("voice conversations", () => {
  it("503s with a clear reason when speech services are unavailable", async () => {
    const agent = await createAgent(`${RUN_TAG} NoSpeech`);
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "");
    const res = await request(app)
      .post(`/api/agents/${agent.id}/voice-converse`)
      .send({ audio: FAKE_WAV_BASE64 });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not provisioned/i);
  });

  it("rejects garbage audio payloads", async () => {
    const agent = await createAgent(`${RUN_TAG} Garbled`);
    const res = await request(app)
      .post(`/api/agents/${agent.id}/voice-converse`)
      .send({ audio: "" });
    expect(res.status).toBe(400);
  });

  it("streams transcript, reply, audio chunks, and done", async () => {
    const agent = await createAgent(`${RUN_TAG} Speaker`);
    mockProviders({ transcript: "Status report please" });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/voice-converse`)
      .send({ audio: FAKE_WAV_BASE64 })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.on("data", (chunk: Buffer) => (text += chunk.toString()));
        response.on("end", () => callback(null, text));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = String(res.body)
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice(6)) as { type: string; [k: string]: unknown });

    const types = events.map((e) => e.type);
    expect(types).toContain("user_transcript");
    expect(types).toContain("reply");
    expect(types).toContain("audio");
    expect(types[types.length - 1]).toBe("done");

    const transcriptEvent = events.find((e) => e.type === "user_transcript");
    expect(transcriptEvent?.text).toBe("Status report please");
    const reply = events.find((e) => e.type === "reply");
    expect(reply?.text).toBe("Sure thing, boss.");
    expect(reply?.voice).toBe("onyx");
    const audioChunks = events.filter((e) => e.type === "audio");
    expect(audioChunks.length).toBe(2);
    expect(audioChunks[0]?.seq).toBe(0);
  });

  it("skips audio entirely for text-only agents", async () => {
    const agent = await createAgent(`${RUN_TAG} Mute`, { voiceStyle: "none" });
    mockProviders();

    const res = await request(app)
      .post(`/api/agents/${agent.id}/voice-converse`)
      .send({ audio: FAKE_WAV_BASE64 })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.on("data", (chunk: Buffer) => (text += chunk.toString()));
        response.on("end", () => callback(null, text));
      });
    expect(res.status).toBe(200);
    const events = String(res.body)
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice(6)) as { type: string; voice?: string | null });
    expect(events.find((e) => e.type === "reply")?.voice).toBeNull();
    expect(events.some((e) => e.type === "audio")).toBe(false);
  });

  it("reports a transcription failure as a clear in-stream error", async () => {
    const agent = await createAgent(`${RUN_TAG} DeafEar`);
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes("/audio/transcriptions")) {
        return jsonResponse({ error: "boom" }, 500);
      }
      throw new Error(`unexpected fetch in test: ${target}`);
    });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/voice-converse`)
      .send({ audio: FAKE_WAV_BASE64 })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.on("data", (chunk: Buffer) => (text += chunk.toString()));
        response.on("end", () => callback(null, text));
      });
    expect(res.status).toBe(200);
    const events = String(res.body)
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map(
        (f) =>
          JSON.parse(f.slice(6)) as { type: string; message?: string; fatal?: boolean },
      );
    const error = events.find((e) => e.type === "error");
    expect(error?.message).toMatch(/transcribed/i);
    // Fatal errors are terminal: the client must not report a dropped
    // connection on top of the real message.
    expect(error?.fatal).toBe(true);
    expect(events.some((e) => e.type === "reply")).toBe(false);
  });
});
