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
  agentMessagesTable,
  agentsTable,
  db,
  pool,
  systemStateTable,
  talkExchangesTable,
  teamMembersTable,
  teamsTable,
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

// Fault injection: fail the next audit write to prove a post-finalization
// failure can never delete a completed idempotency claim.
const auditState = vi.hoisted(() => ({ failNext: false }));
vi.mock("../audit", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../audit")>();
  return {
    ...mod,
    recordAudit: (...args: Parameters<typeof mod.recordAudit>) => {
      if (auditState.failNext) {
        auditState.failNext = false;
        return Promise.reject(new Error("audit store down"));
      }
      return mod.recordAudit(...args);
    },
  };
});

// Interleaving hook for the clear-vs-persist race tests. Each converse
// request reads the clear-epoch key twice: once at request start (epoch
// capture, before any other await) and once inside persistTranscript under
// the per-agent lock. `armAt` picks which occurrence to pause AFTER the
// value has been read, so tests can wedge a DELETE into either window.
const markerGate = vi.hoisted(() => ({
  armAt: 0,
  seen: 0,
  release: null as null | (() => void),
}));
vi.mock("../workspace", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../workspace")>();
  const maybePause = async (key: string) => {
    if (key.startsWith("voice_history_cleared:") && markerGate.armAt > 0) {
      markerGate.seen += 1;
      if (markerGate.seen === markerGate.armAt) {
        markerGate.armAt = 0;
        await new Promise<void>((resolve) => {
          markerGate.release = resolve;
        });
      }
    }
  };
  return {
    ...mod,
    // Occurrence 1 per request: the epoch capture at request start.
    getWorkspaceSetting: async (workspaceId: string, key: string) => {
      const value = await mod.getWorkspaceSetting(workspaceId, key);
      await maybePause(key);
      return value;
    },
    // Occurrence 2: the persist-side epoch re-check under the agent lock.
    getWorkspaceSettingVia: async (
      executor: Parameters<typeof mod.getWorkspaceSettingVia>[0],
      workspaceId: string,
      key: string,
    ) => {
      const value = await mod.getWorkspaceSettingVia(
        executor,
        workspaceId,
        key,
      );
      await maybePause(key);
      return value;
    },
  };
});

import officeRouter from "./office";
import { clearProviderCaches } from "../providers";
import {
  deleteProviderCredential,
  saveProviderCredential,
} from "../provider-credentials";

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Voice ${Date.now()}`;
const createdAgentIds: string[] = [];
const createdTeamIds: string[] = [];
let createdOwnerRow = false;
let priorTranscriptsValue: string | null | undefined;
let priorTalkAutoApproveValue: string | null | undefined;
let wsId = "";

/** Minimal RIFF/WAVE header so format detection skips ffmpeg conversion. */
const FAKE_WAV_BASE64 = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([16, 0, 0, 0]),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(32),
]).toString("base64");


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
      avatar: {
        shellColor: "#C34428",
        deskStyle: "standard",
        accessory: "none",
      },
      ...extra,
    });
  expect(res.status).toBe(201);
  createdAgentIds.push(res.body.id);
  // Paused agents keep the live development worker away from test rows.
  await request(app)
    .post(`/api/agents/${res.body.id}/pause`)
    .send({ paused: true });
  return res.body as { id: string; name: string };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: string[]): Response {
  const body =
    frames.map((f) => `data: ${f}\n\n`).join("") + "data: [DONE]\n\n";
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
    // Workspace voice keys go straight to api.openai.com (no managed base
    // URL), so speech traffic is recognized by the OpenAI host or the
    // transcription path.
    if (target.includes("/audio/transcriptions")) {
      return jsonResponse({ text: transcript });
    }
    if (
      target.includes("api.openai.com") &&
      target.includes("/chat/completions")
    ) {
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
        return jsonResponse(
          { error: "upstream detail that must never leak" },
          failure,
        );
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

function mockTalkOutputs(outputs: string[]) {
  const pending = [...outputs];
  let calls = 0;
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
    if (target.includes("/chat/completions")) {
      calls += 1;
      return jsonResponse({
        choices: [{ message: { content: pending.shift() ?? "No answer." } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  });
  return { calls: () => calls };
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
  const [talkAutoApprove] = await db
    .select()
    .from(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, wsId),
        eq(workspaceSettingsTable.key, "talk_auto_approve_tasks"),
      ),
    )
    .limit(1);
  priorTalkAutoApproveValue = talkAutoApprove?.value ?? null;
});

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error("network disabled in tests");
  });
  await saveProviderCredential(wsId, "openrouter", "test-openrouter-key");
  await saveProviderCredential(wsId, "claude_max", "test-claude-token");
  await saveProviderCredential(wsId, "openai_voice", "test-openai-key");
  clearProviderCaches();
});

afterAll(async () => {
  if (createdAgentIds.length > 0) {
    await db
      .delete(talkExchangesTable)
      .where(inArray(talkExchangesTable.agentId, createdAgentIds));
    await db
      .delete(agentMessagesTable)
      .where(
        or(
          inArray(agentMessagesTable.fromAgentId, createdAgentIds),
          inArray(agentMessagesTable.toAgentId, createdAgentIds),
        ),
      );
    await db.delete(workspaceSettingsTable).where(
      inArray(
        workspaceSettingsTable.key,
        createdAgentIds.map((id) => `voice_history_cleared:${id}`),
      ),
    );
    if (createdTeamIds.length > 0) {
      await db.delete(teamsTable).where(inArray(teamsTable.id, createdTeamIds));
    }
    await db
      .delete(agentsTable)
      .where(inArray(agentsTable.id, createdAgentIds));
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
  if (priorTalkAutoApproveValue === null) {
    await db
      .delete(workspaceSettingsTable)
      .where(
        and(
          eq(workspaceSettingsTable.workspaceId, wsId),
          eq(workspaceSettingsTable.key, "talk_auto_approve_tasks"),
        ),
      );
  } else if (priorTalkAutoApproveValue !== undefined) {
    await db
      .update(workspaceSettingsTable)
      .set({ value: priorTalkAutoApproveValue })
      .where(
        and(
          eq(workspaceSettingsTable.workspaceId, wsId),
          eq(workspaceSettingsTable.key, "talk_auto_approve_tasks"),
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
  it("reports availability from the workspace's stored voice key", async () => {
    const res = await request(app).get("/api/voice/status");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.reason).toBeNull();
  });

  it("reports a clear reason when the workspace has no voice key", async () => {
    await deleteProviderCredential(wsId, "openai_voice");
    const res = await request(app).get("/api/voice/status");
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/add your openai api key/i);
  });

  it("stores and removes the voice key through the credential routes", async () => {
    const removed = await request(app).delete("/api/voice/credential");
    expect(removed.status).toBe(200);
    expect(removed.body.available).toBe(false);

    const rejected = await request(app)
      .put("/api/voice/credential")
      .send({ credential: "short" });
    expect(rejected.status).toBe(400);

    const saved = await request(app)
      .put("/api/voice/credential")
      .send({ credential: "test-openai-key" });
    expect(saved.status).toBe(200);
    expect(saved.body.available).toBe(true);
    // The key itself must never appear anywhere in the response.
    expect(JSON.stringify(saved.body)).not.toContain("test-openai-key");
  });

  it("toggles transcript storage", async () => {
    const on = await setTranscripts(true);
    expect(on.transcriptsEnabled).toBe(true);
    const off = await setTranscripts(false);
    expect(off.transcriptsEnabled).toBe(false);
  });

  it("toggles automatic initial approval for Talk-created tasks independently", async () => {
    const on = await request(app)
      .put("/api/voice/settings")
      .send({ autoApproveTalkTasks: true });
    expect(on.status).toBe(200);
    expect(on.body.autoApproveTalkTasks).toBe(true);

    const status = await request(app).get("/api/voice/status");
    expect(status.body.autoApproveTalkTasks).toBe(true);

    const off = await request(app)
      .put("/api/voice/settings")
      .send({ autoApproveTalkTasks: false });
    expect(off.status).toBe(200);
    expect(off.body.autoApproveTalkTasks).toBe(false);
  });

  it("rejects a malformed settings body", async () => {
    const res = await request(app)
      .put("/api/voice/settings")
      .send({ transcriptsEnabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty settings body", async () => {
    const res = await request(app).put("/api/voice/settings").send({});
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
    const res = await request(app)
      .post("/api/voice/transcribe")
      .send({ audio: "" });
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

  it("503s when the workspace has no voice key", async () => {
    await deleteProviderCredential(wsId, "openai_voice");
    const res = await request(app)
      .post("/api/voice/transcribe")
      .send({ audio: FAKE_WAV_BASE64 });
    expect(res.status).toBe(503);
  });
});

describe("text conversations", () => {
  it("lets one non-sandboxed agent ask another and reports the answer to the owner", async () => {
    const source = await createAgent(`${RUN_TAG} Relay Source`);
    const target = await createAgent(`${RUN_TAG} Relay Target`, {
      personality: "Precise and cheerful",
    });
    const mocked = mockTalkOutputs([
      JSON.stringify({
        reply: `I'll ask ${target.name}.`,
        taskObjective: null,
        agentRequest: {
          targetAgentId: target.id,
          kind: "question",
          content: "What is the launch status?",
        },
      }),
      "The launch checks are complete and everything is green.",
      "I checked with the team: all launch checks are complete and green.",
    ]);

    const response = await request(app)
      .post(`/api/agents/${source.id}/converse`)
      .send({ text: `Ask ${target.name} for the launch status.` });
    expect(response.status).toBe(200);
    expect(response.body.reply).toContain("complete and green");
    expect(response.body.proposedDelegation).toBeNull();
    expect(mocked.calls()).toBe(3);

    const inbox = await request(app)
      .get("/api/messages")
      .query({ agentId: source.id });
    const relay = inbox.body
      .filter((message: { kind: string }) => message.kind === "note")
      .slice(0, 2)
      .reverse();
    expect(relay).toHaveLength(2);
    expect(relay[0]).toMatchObject({
      fromAgentId: source.id,
      toAgentId: target.id,
      body: "What is the launch status?",
    });
    expect(relay[1]).toMatchObject({
      fromAgentId: target.id,
      toAgentId: source.id,
      body: "The launch checks are complete and everything is green.",
    });
  });

  it("proposes a teammate task for owner confirmation instead of starting it", async () => {
    const source = await createAgent(`${RUN_TAG} Task Relay Source`);
    const target = await createAgent(`${RUN_TAG} Task Relay Target`);
    const [team] = await db
      .insert(teamsTable)
      .values({
        workspaceId: wsId,
        name: `${RUN_TAG} Talk Delegation Team`,
        leadAgentId: source.id,
      })
      .returning();
    createdTeamIds.push(team.id);
    await db.insert(teamMembersTable).values([
      { teamId: team.id, agentId: source.id },
      { teamId: team.id, agentId: target.id },
    ]);
    const mocked = mockTalkOutputs([
      JSON.stringify({
        reply: `I can hand that to ${target.name} once you confirm.`,
        taskObjective: null,
        agentRequest: {
          targetAgentId: target.id,
          kind: "task",
          content: "Prepare a concise launch-readiness report.",
        },
      }),
    ]);

    const response = await request(app)
      .post(`/api/agents/${source.id}/converse`)
      .send({ text: `Ask ${target.name} to prepare the report.` });
    expect(response.status).toBe(200);
    expect(response.body.proposedDelegation).toMatchObject({
      targetAgentId: target.id,
      targetAgentName: target.name,
      objective: "Prepare a concise launch-readiness report.",
    });
    expect(response.body.proposedTaskObjective).toBeNull();
    expect(mocked.calls()).toBe(1);

    const inbox = await request(app)
      .get("/api/messages")
      .query({ agentId: source.id });
    expect(
      inbox.body.filter((message: { kind: string }) =>
        ["delegation", "result", "note"].includes(message.kind),
      ),
    ).toHaveLength(0);
  });

  it("keeps the intended teammate across a clarification turn and never falls back to a self-task", async () => {
    const source = await createAgent(`${RUN_TAG} Clarifying Lead`);
    const target = await createAgent(`${RUN_TAG} Jean-Pierre`);
    const [team] = await db
      .insert(teamsTable)
      .values({
        workspaceId: wsId,
        name: `${RUN_TAG} Clarification Team`,
        leadAgentId: source.id,
      })
      .returning();
    createdTeamIds.push(team.id);
    await db.insert(teamMembersTable).values([
      { teamId: team.id, agentId: source.id },
      { teamId: team.id, agentId: target.id },
    ]);

    const firstProvider = mockTalkOutputs([
      JSON.stringify({
        reply: `Certainly. What task would you like ${target.name} to handle?`,
        taskObjective: null,
        agentRequest: null,
      }),
    ]);
    const openingText = `Ask ${target.name} to do a task.`;
    const first = await request(app)
      .post(`/api/agents/${source.id}/converse`)
      .send({ text: openingText });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      proposedTaskObjective: null,
      proposedDelegation: null,
      pendingDelegation: {
        targetAgentId: target.id,
        targetAgentName: target.name,
      },
    });
    expect(firstProvider.calls()).toBe(1);

    // Reproduce the screenshot's failure: the model incorrectly emits the
    // follow-up as a normal taskObjective. The server must convert it to the
    // locked Jean-Pierre hand-off, never a task for the speaking lead.
    const secondProvider = mockTalkOutputs([
      JSON.stringify({
        reply: `I can queue ${target.name} once you confirm.`,
        taskObjective: `Have ${target.name} send the Director a brief confirmation that he is available.`,
        agentRequest: null,
      }),
    ]);
    const second = await request(app)
      .post(`/api/agents/${source.id}/converse`)
      .send({
        text: "Any one, it is a test.",
        pendingDelegationTargetId: target.id,
        history: [
          { role: "user", text: openingText },
          { role: "agent", text: first.body.reply },
        ],
      });
    expect(second.status).toBe(200);
    expect(second.body.proposedTaskObjective).toBeNull();
    expect(second.body.pendingDelegation).toBeNull();
    expect(second.body.proposedDelegation).toMatchObject({
      targetAgentId: target.id,
      targetAgentName: target.name,
      objective: `Have ${target.name} send the Director a brief confirmation that he is available.`,
    });
    expect(secondProvider.calls()).toBe(1);
  });

  it("refuses an unauthorized teammate assignment instead of running it itself", async () => {
    const source = await createAgent(`${RUN_TAG} Nonlead Source`);
    const target = await createAgent(`${RUN_TAG} Outside Target`);
    const mocked = mockTalkOutputs([
      JSON.stringify({
        reply: "I will do it myself.",
        taskObjective: `Ask ${target.name} to prepare the report.`,
        agentRequest: null,
      }),
    ]);

    const response = await request(app)
      .post(`/api/agents/${source.id}/converse`)
      .send({ text: `Ask ${target.name} to prepare the report.` });
    expect(response.status).toBe(200);
    expect(response.body.reply).toMatch(/not in a team i lead/i);
    expect(response.body.proposedTaskObjective).toBeNull();
    expect(response.body.proposedDelegation).toBeNull();
    expect(response.body.pendingDelegation).toBeNull();
    // The deterministic permission guard runs before spending a model call.
    expect(mocked.calls()).toBe(0);
  });

  it("blocks outbound communication from a sandboxed agent", async () => {
    const source = await createAgent(`${RUN_TAG} Sandboxed Source`, {
      sensitiveDataSandbox: true,
    });
    const target = await createAgent(`${RUN_TAG} Sandbox Out Target`);
    const mocked = mockTalkOutputs([
      JSON.stringify({
        reply: "I'll ask.",
        taskObjective: null,
        agentRequest: {
          targetAgentId: target.id,
          kind: "question",
          content: "Share the private finding.",
        },
      }),
    ]);
    const response = await request(app)
      .post(`/api/agents/${source.id}/converse`)
      .send({ text: `Tell ${target.name} the finding.` });
    expect(response.status).toBe(200);
    expect(response.body.reply).toMatch(/sensitive data sandbox/i);
    expect(mocked.calls()).toBe(1);
    const inbox = await request(app)
      .get("/api/messages")
      .query({ agentId: source.id });
    expect(
      inbox.body.filter((message: { kind: string }) => message.kind === "note"),
    ).toHaveLength(0);
  });

  it("blocks inbound communication to a sandboxed agent", async () => {
    const source = await createAgent(`${RUN_TAG} Sandbox In Source`);
    const target = await createAgent(`${RUN_TAG} Sandboxed Target`, {
      sensitiveDataSandbox: true,
    });
    const mocked = mockTalkOutputs([
      JSON.stringify({
        reply: "I'll ask.",
        taskObjective: null,
        agentRequest: {
          targetAgentId: target.id,
          kind: "question",
          content: "Can you share your notes?",
        },
      }),
    ]);
    const response = await request(app)
      .post(`/api/agents/${source.id}/converse`)
      .send({ text: `Ask ${target.name} for their notes.` });
    expect(response.status).toBe(200);
    expect(response.body.reply).toMatch(/unavailable|isolated/i);
    expect(mocked.calls()).toBe(1);
    const inbox = await request(app)
      .get("/api/messages")
      .query({ agentId: target.id });
    expect(
      inbox.body.filter((message: { kind: string }) => message.kind === "note"),
    ).toHaveLength(0);
  });

  it("returns the agent reply and always keeps typed Talk history, even with transcripts off", async () => {
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

    // Typed exchanges are chat history, not voice transcripts: they persist
    // regardless of the voice-transcript privacy setting.
    const toAgent = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.toAgentId, agent.id));
    const fromAgent = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.fromAgentId, agent.id));
    expect(
      toAgent.some(
        (r) => r.kind === "voice" && r.body === "How are you today?",
      ),
    ).toBe(true);
    expect(
      fromAgent.some(
        (r) => r.kind === "voice" && r.body === "Sure thing, boss.",
      ),
    ).toBe(true);
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
    expect(
      toAgent.some(
        (r) => r.kind === "voice" && r.body === "Remember this chat.",
      ),
    ).toBe(true);
    expect(
      fromAgent.some(
        (r) => r.kind === "voice" && r.body === "Sure thing, boss.",
      ),
    ).toBe(true);

    await setTranscripts(false);
  });

  it("serves stored Talk history oldest-first, split into user/agent roles", async () => {
    const agent = await createAgent(`${RUN_TAG} Historian`);
    await setTranscripts(false);
    mockProviders();

    const first = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "First message" });
    expect(first.status).toBe(200);
    mockProviders({
      replyJson: '{"reply":"Second answer.","taskObjective":null}',
    });
    const second = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Second message" });
    expect(second.status).toBe(200);

    const res = await request(app).get(`/api/agents/${agent.id}/talk-history`);
    expect(res.status).toBe(200);
    const turns = res.body.turns as {
      role: string;
      text: string;
      id: string;
    }[];
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "First message"],
      ["agent", "Sure thing, boss."],
      ["user", "Second message"],
      ["agent", "Second answer."],
    ]);
    expect(new Set(turns.map((t) => t.id)).size).toBe(4);
  });

  it("keeps Talk history readable for retired agents but 404s unknown ones", async () => {
    const missing = await request(app).get(
      "/api/agents/00000000-0000-0000-0000-000000000000/talk-history",
    );
    expect(missing.status).toBe(404);

    const agent = await createAgent(`${RUN_TAG} Retired Reader`);
    mockProviders();
    await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Before retiring" });
    await db
      .update(agentsTable)
      .set({ retired: true, retiredAt: new Date() })
      .where(eq(agentsTable.id, agent.id));
    const res = await request(app).get(`/api/agents/${agent.id}/talk-history`);
    expect(res.status).toBe(200);
    expect(
      res.body.turns.some(
        (t: { text: string }) => t.text === "Before retiring",
      ),
    ).toBe(true);
  });

  it("keeps another workspace's agent history invisible", async () => {
    const agent = await createAgent(`${RUN_TAG} Private`);
    mockProviders();
    await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Private note" });

    // A different signed-in user gets their own workspace; the first
    // workspace's agent must look nonexistent from there.
    const originalUser = authState.userId;
    const outsider = `hc-voice-test-outsider-${Date.now()}`;
    authState.userId = outsider;
    try {
      const boot = await request(app).get("/api/agents");
      expect(boot.status).toBe(200);
      const res = await request(app).get(
        `/api/agents/${agent.id}/talk-history`,
      );
      expect(res.status).toBe(404);
    } finally {
      authState.userId = originalUser;
      await db
        .delete(workspacesTable)
        .where(eq(workspacesTable.clerkUserId, outsider));
    }
  });

  it("clears only the agent's own voice history and returns the deleted count", async () => {
    const agent = await createAgent(`${RUN_TAG} Cleared`);
    const bystander = await createAgent(`${RUN_TAG} Bystander`);
    mockProviders();
    await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Wipe me" });
    await request(app)
      .post(`/api/agents/${bystander.id}/converse`)
      .send({ text: "Keep me" });
    // A non-voice message to the same agent must survive the clear.
    const [nonVoice] = await db
      .insert(agentMessagesTable)
      .values({
        fromAgentId: null,
        toAgentId: agent.id,
        kind: "note",
        body: `${RUN_TAG} task note`,
      })
      .returning({ id: agentMessagesTable.id });

    const res = await request(app).delete(
      `/api/agents/${agent.id}/talk-history`,
    );
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);

    const history = await request(app).get(
      `/api/agents/${agent.id}/talk-history`,
    );
    expect(history.body.turns).toEqual([]);
    const bystanderHistory = await request(app).get(
      `/api/agents/${bystander.id}/talk-history`,
    );
    expect(
      bystanderHistory.body.turns.some(
        (t: { text: string }) => t.text === "Keep me",
      ),
    ).toBe(true);
    const survivors = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.id, nonVoice.id));
    expect(survivors).toHaveLength(1);
  });

  it("a clear during an in-flight converse wins: the late reply is not persisted", async () => {
    const agent = await createAgent(`${RUN_TAG} Clear Racer`);
    // Gate the provider's reply so the DELETE can land mid-conversation.
    let releaseReply!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
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
      if (target.includes("/chat/completions")) {
        await gate;
        return jsonResponse({
          choices: [
            {
              message: {
                content: '{"reply":"Too late.","taskObjective":null}',
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        });
      }
      throw new Error(`unexpected fetch in test: ${target}`);
    });

    const inFlight = request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Racing message" })
      .then((r) => r);
    // Give the converse handler time to reach the (gated) provider call.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const cleared = await request(app).delete(
      `/api/agents/${agent.id}/talk-history`,
    );
    expect(cleared.status).toBe(200);

    releaseReply();
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Too late.");

    // The reply was delivered but never persisted: history stays cleared.
    const history = await request(app).get(
      `/api/agents/${agent.id}/talk-history`,
    );
    expect(history.body.turns).toEqual([]);
    const rows = await db
      .select()
      .from(agentMessagesTable)
      .where(
        and(
          eq(agentMessagesTable.kind, "voice"),
          or(
            eq(agentMessagesTable.fromAgentId, agent.id),
            eq(agentMessagesTable.toAgentId, agent.id),
          ),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("a clear issued between marker verification and insert still leaves history empty", async () => {
    const agent = await createAgent(`${RUN_TAG} Interleaver`);
    mockProviders();

    // Pause the persist right after it verified the epoch (while it holds
    // the per-agent lock), fire the DELETE (which must queue on that lock),
    // then release the insert. The delete runs after the insert commits,
    // so history must end up empty either way.
    markerGate.seen = 0;
    markerGate.armAt = 2;
    const inFlight = request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Squeeze past the clear" })
      .then((r) => r);
    await vi.waitFor(() => {
      if (!markerGate.release) throw new Error("persist not paused yet");
    });
    const clearing = request(app)
      .delete(`/api/agents/${agent.id}/talk-history`)
      .then((r) => r);
    // Give the DELETE time to reach (and block on) the advisory lock.
    await new Promise((resolve) => setTimeout(resolve, 300));
    markerGate.release!();
    markerGate.release = null;

    const [reply, cleared] = await Promise.all([inFlight, clearing]);
    expect(reply.status).toBe(200);
    expect(cleared.status).toBe(200);
    // The racing exchange's two rows were committed first, then deleted.
    expect(cleared.body.deleted).toBe(2);
    const history = await request(app).get(
      `/api/agents/${agent.id}/talk-history`,
    );
    expect(history.body.turns).toEqual([]);
  });

  it("a clear that fully completes during the request's epoch capture still vetoes the persist", async () => {
    const agent = await createAgent(`${RUN_TAG} Early Racer`);
    mockProviders();
    // Seed one exchange so the DELETE has something real to remove.
    const seed = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Seed message" });
    expect(seed.status).toBe(200);

    // Pause the racing request at its very first await — the clear-epoch
    // capture, before agent lookup or any provider work. The DELETE holds no
    // conflict with a request paused there, so it runs to completion; the
    // released request must then see the bumped epoch at persist time.
    markerGate.seen = 0;
    markerGate.armAt = 1;
    const inFlight = request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Straggler" })
      .then((r) => r);
    await vi.waitFor(() => {
      if (!markerGate.release) throw new Error("capture not paused yet");
    });
    const cleared = await request(app).delete(
      `/api/agents/${agent.id}/talk-history`,
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.deleted).toBe(2);

    markerGate.release!();
    markerGate.release = null;
    const reply = await inFlight;
    expect(reply.status).toBe(200);

    // The straggler's reply was delivered but never persisted.
    const history = await request(app).get(
      `/api/agents/${agent.id}/talk-history`,
    );
    expect(history.body.turns).toEqual([]);
  });

  it("finalizing more concurrent turns than the pool holds connections cannot deadlock", async () => {
    // Regression guard: the persist transaction must read the clear epoch
    // through its own connection. If it grabbed a second pool connection per
    // in-flight transaction, this fan-out (wider than the pool) would hang.
    const agent = await createAgent(`${RUN_TAG} Pool Flood`);
    mockProviders();
    const width = 12; // default pg pool max is 10
    const results = await Promise.all(
      Array.from({ length: width }, (_, i) =>
        request(app)
          .post(`/api/agents/${agent.id}/converse`)
          .send({
            text: `Flood ${i}`,
            clientMessageId: `flood-${Date.now()}-${i}`,
          }),
      ),
    );
    for (const res of results) expect(res.status).toBe(200);
    const history = await request(app).get(
      `/api/agents/${agent.id}/talk-history`,
    );
    expect(history.body.turns).toHaveLength(width * 2);
  }, 30_000);

  it("refuses to clear another workspace's agent history", async () => {
    const agent = await createAgent(`${RUN_TAG} Guarded`);
    mockProviders();
    await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Protected" });

    const originalUser = authState.userId;
    const outsider = `hc-voice-test-clear-outsider-${Date.now()}`;
    authState.userId = outsider;
    try {
      const boot = await request(app).get("/api/agents");
      expect(boot.status).toBe(200);
      const res = await request(app).delete(
        `/api/agents/${agent.id}/talk-history`,
      );
      expect(res.status).toBe(404);
    } finally {
      authState.userId = originalUser;
      await db
        .delete(workspacesTable)
        .where(eq(workspacesTable.clerkUserId, outsider));
    }
    const history = await request(app).get(
      `/api/agents/${agent.id}/talk-history`,
    );
    expect(
      history.body.turns.some((t: { text: string }) => t.text === "Protected"),
    ).toBe(true);
  });

  it("resending with the same clientMessageId returns the cached reply without duplicating history", async () => {
    const agent = await createAgent(`${RUN_TAG} Resender`);
    const providers = mockProviders();
    const clientMessageId = `resend-${Date.now()}`;

    const first = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Deliver this once", clientMessageId });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Deliver this once", clientMessageId });
    expect(second.status).toBe(200);
    expect(second.body.reply).toBe(first.body.reply);
    // The provider was consulted only once; the resend was answered from
    // the idempotency cache and persisted nothing new.
    expect(providers.calls()).toBe(1);

    const rows = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.toAgentId, agent.id));
    expect(rows.filter((r) => r.body === "Deliver this once")).toHaveLength(1);
  });

  it("concurrent duplicates: exactly one exchange is generated, the loser gets 409 or the reply", async () => {
    const agent = await createAgent(`${RUN_TAG} Racer`);
    const providers = mockProviders();
    const clientMessageId = `race-${Date.now()}`;

    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/agents/${agent.id}/converse`)
        .send({ text: "Race me", clientMessageId }),
      request(app)
        .post(`/api/agents/${agent.id}/converse`)
        .send({ text: "Race me", clientMessageId }),
    ]);
    const statuses = [a.status, b.status].sort();
    // One wins; the other either replays the finished response (200) or
    // reports the in-flight original (409). Never two generations.
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    expect(providers.calls()).toBe(1);

    const rows = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.toAgentId, agent.id));
    expect(rows.filter((r) => r.body === "Race me")).toHaveLength(1);
  });

  it("replays a finished exchange after a lost response without generating or persisting again", async () => {
    // Simulates a crash/lost response after the exchange committed: the
    // durable claim already holds the response, so a retry replays it.
    const agent = await createAgent(`${RUN_TAG} Replayer`);
    const providers = mockProviders();
    const clientMessageId = `replay-${Date.now()}`;
    const storedPayload = {
      reply: "Stored answer.",
      proposedTaskObjective: null,
      voice: "onyx",
    };
    await db.insert(talkExchangesTable).values({
      workspaceId: wsId,
      agentId: agent.id,
      clientMessageId,
      status: "done",
      responseJson: JSON.stringify(storedPayload),
    });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Anything", clientMessageId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(storedPayload);
    expect(providers.calls()).toBe(0);
    const rows = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.toAgentId, agent.id));
    expect(rows).toHaveLength(0);
  });

  it("reclaims a claim orphaned by a crash mid-generation instead of blocking forever", async () => {
    const agent = await createAgent(`${RUN_TAG} Orphan`);
    const providers = mockProviders();
    const clientMessageId = `orphan-${Date.now()}`;
    await db.insert(talkExchangesTable).values({
      workspaceId: wsId,
      agentId: agent.id,
      clientMessageId,
      status: "pending",
      createdAt: new Date(Date.now() - 10 * 60_000),
    });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Recover me", clientMessageId });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Sure thing, boss.");
    expect(providers.calls()).toBe(1);
  });

  it("keeps the finished claim for replay when a post-finalization step fails", async () => {
    const agent = await createAgent(`${RUN_TAG} Auditless`);
    const providers = mockProviders();
    const clientMessageId = `audit-fail-${Date.now()}`;

    auditState.failNext = true;
    const failed = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Persist despite audit", clientMessageId });
    // The exchange committed before the audit write failed.
    expect(failed.status).toBe(500);

    const retried = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Persist despite audit", clientMessageId });
    expect(retried.status).toBe(200);
    expect(retried.body.reply).toBe("Sure thing, boss.");
    // Replay came from the stored claim: one generation, one stored exchange.
    expect(providers.calls()).toBe(1);
    const rows = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.toAgentId, agent.id));
    expect(rows.filter((r) => r.body === "Persist despite audit")).toHaveLength(
      1,
    );
  });

  it("a stale original that loses its claim replays the reclaimer's reply instead of its own", async () => {
    const agent = await createAgent(`${RUN_TAG} Stale Owner`);
    const clientMessageId = `stale-${Date.now()}`;

    // The provider call blocks until we let it finish, giving us time to
    // steal the claim mid-flight (as a stale-claim reclaimer would).
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>(
      (resolve) => (releaseProvider = resolve),
    );
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
      if (target.includes("/chat/completions")) {
        await providerGate;
        return jsonResponse({
          choices: [
            {
              message: {
                content: '{"reply":"Late reply.","taskObjective":null}',
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        });
      }
      throw new Error(`unexpected fetch in test: ${target}`);
    });

    // .then() starts the supertest request immediately so it runs while we
    // steal the claim below.
    const inFlight = request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Slow one", clientMessageId })
      .then((r) => r);

    // Wait for the original to claim, then steal the claim and finalize it
    // the way a reclaiming retry would.
    let claimId: string | undefined;
    for (let i = 0; i < 100 && !claimId; i++) {
      const [row] = await db
        .select()
        .from(talkExchangesTable)
        .where(eq(talkExchangesTable.clientMessageId, clientMessageId))
        .limit(1);
      claimId = row?.id;
      if (!claimId) await new Promise((r) => setTimeout(r, 50));
    }
    expect(claimId).toBeDefined();
    const authoritative = {
      reply: "Reclaimer's answer.",
      proposedTaskObjective: null,
      voice: "onyx",
    };
    await db
      .delete(talkExchangesTable)
      .where(eq(talkExchangesTable.id, claimId!));
    await db.insert(talkExchangesTable).values({
      workspaceId: wsId,
      agentId: agent.id,
      clientMessageId,
      status: "done",
      responseJson: JSON.stringify(authoritative),
    });

    releaseProvider();
    const res = await inFlight;
    // The stale original must not answer with "Late reply." — it lost
    // ownership and replays the authoritative stored response.
    expect(res.status).toBe(200);
    expect(res.body).toEqual(authoritative);
    // And it persisted nothing of its own generation.
    const rows = await db
      .select()
      .from(agentMessagesTable)
      .where(eq(agentMessagesTable.toAgentId, agent.id));
    expect(rows.filter((r) => r.body === "Slow one")).toHaveLength(0);
  });

  it("a failed delivery releases its idempotency claim so a retry can succeed", async () => {
    const agent = await createAgent(`${RUN_TAG} Retrier`);
    const clientMessageId = `retry-${Date.now()}`;
    // Both the first call and its automatic in-route retry fail terminally.
    mockProviders({ chatFailStatuses: [401] });

    const failed = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Try, fail, retry", clientMessageId });
    expect(failed.status).toBeGreaterThanOrEqual(500);

    mockProviders();
    const retried = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Try, fail, retry", clientMessageId });
    expect(retried.status).toBe(200);
    expect(retried.body.reply).toBe("Sure thing, boss.");
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
        target: [
          workspaceSettingsTable.workspaceId,
          workspaceSettingsTable.key,
        ],
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
    await deleteProviderCredential(wsId, "openrouter");
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
  it("503s with a clear reason when the workspace has no voice key", async () => {
    const agent = await createAgent(`${RUN_TAG} NoSpeech`);
    await deleteProviderCredential(wsId, "openai_voice");
    const res = await request(app)
      .post(`/api/agents/${agent.id}/voice-converse`)
      .send({ audio: FAKE_WAV_BASE64 });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/add your openai api key/i);
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
      .map(
        (f) => JSON.parse(f.slice(6)) as { type: string; [k: string]: unknown },
      );

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
      .map(
        (f) =>
          JSON.parse(f.slice(6)) as { type: string; voice?: string | null },
      );
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
          JSON.parse(f.slice(6)) as {
            type: string;
            message?: string;
            fatal?: boolean;
          },
      );
    const error = events.find((e) => e.type === "error");
    expect(error?.message).toMatch(/transcribed/i);
    // Fatal errors are terminal: the client must not report a dropped
    // connection on top of the real message.
    expect(error?.fatal).toBe(true);
    expect(events.some((e) => e.type === "reply")).toBe(false);
  });
});
