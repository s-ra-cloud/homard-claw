import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import {
  afterAll,
  afterEach,
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
  codexCredentialsTable,
  db,
  pool,
  providerConversationsTable,
  providerLeasesTable,
  systemStateTable,
  taskLogsTable,
  tasksTable,
  workspaceSettingsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-test-owner" }));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

// No test may reach a real vendor. HTTP is dead by default and the Codex
// SDK is replaced by a scripted fake, so a real `codex` CLI is never
// spawned and the owner's ChatGPT allowance is never touched.
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import officeRouter from "./office";
import { claimNextTask, recoverInterruptedTasks, runTask } from "../worker";
import { clearProviderCaches } from "../providers";
import {
  setCodexSdkLoader,
  type CodexClient,
  type CodexThreadEvent,
  type CodexThreadHandle,
  type CodexThreadOptions,
  type CodexUsage,
} from "../codex/sdk";
import {
  CODEX_FORBIDDEN_ENV,
  bootstrapCodexHome,
  codexAuthFilePathFor,
  codexAuthFingerprint,
  codexChildEnv,
  codexHomeFor,
  codexRuntimeState,
  connectCodexCredential,
  disconnectCodexCredential,
  materializeCodexHome,
  persistCodexRefresh,
} from "../codex/runtime";
import { saveCodexCredential } from "../codex/credential-store";
import { acquireProviderLease, codexLeaseKey } from "../provider-leases";
import { setCodexTalkLeaseWait } from "../talk-codex";
import { randomUUID } from "node:crypto";
import { setCodexLeaseHeartbeatMs } from "../codex/config";
import { runCodexHealthCheck, resetCodexHealthCheck } from "../scheduler";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void; info: () => void } }).log = {
    warn: () => {},
    info: () => {},
  };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Codex ${Date.now()}`;
const createdAgentIds: string[] = [];
let createdOwnerRow = false;
let wsId = "";

const SETTINGS_KEYS = [
  "provider.default",
  "provider.codex_chatgpt.default_model",
  "provider.codex_chatgpt.default_reasoning",
  "provider.fallback.order",
  "provider.fallback.paid_consent",
  "provider.fallback.paid_limit_cents",
];
let savedSettings: Array<{ workspaceId: string; key: string; value: string }> = [];

/** Directory used as the private CODEX_HOME for the whole file. */
let codexHome = "";
let workspaceRoot = "";

const CHATGPT_AUTH = {
  auth_mode: "chatgpt",
  tokens: {
    account_id: "acct_test",
    access_token: "sk-test-access-token-should-never-surface",
    refresh_token: "rt-test-refresh-token",
  },
  last_refresh: new Date().toISOString(),
};

/**
 * Connect a sign-in the way a person does: stored against their account,
 * not dropped on disk. The filesystem copy only appears when a run
 * materializes it.
 */
async function connectAuth(
  contents: unknown,
  userId = authState.userId,
): Promise<void> {
  await saveCodexCredential(userId, JSON.stringify(contents));
}

/* ------------------------------------------------------------------ */
/* Scripted Codex SDK fake                                             */
/* ------------------------------------------------------------------ */

type ScriptedTurn = {
  events: CodexThreadEvent[];
  /** Throw instead of streaming (SDK-level failure). */
  throws?: Error;
  /** Resolve only once the signal aborts, like a long-running turn. */
  hangUntilAborted?: boolean;
  /**
   * Run just before the turn returns its events. Lets a test open a window
   * between "the SDK finished" and "the worker persists an outcome".
   */
  beforeReturn?: () => Promise<void>;
};

type SdkCall = {
  kind: "start" | "resume";
  threadId: string | null;
  options: CodexThreadOptions | undefined;
  env: Record<string, string> | undefined;
  input: string;
};

const sdkCalls: SdkCall[] = [];
let turnScript: ScriptedTurn[] = [];
let nextThreadCounter = 0;

const USAGE: CodexUsage = {
  input_tokens: 1500,
  cached_input_tokens: 400,
  cache_write_input_tokens: 120,
  output_tokens: 260,
  reasoning_output_tokens: 180,
};

function successTurn(text = "The kelp report is filed."): ScriptedTurn {
  return {
    events: [
      { type: "thread.started", thread_id: `thr_${++nextThreadCounter}` },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text },
      },
      { type: "turn.completed", usage: USAGE },
    ],
  };
}

function failingTurn(message: string): ScriptedTurn {
  return {
    events: [
      { type: "thread.started", thread_id: `thr_${++nextThreadCounter}` },
      { type: "turn.started" },
      { type: "turn.failed", error: { message } },
    ],
  };
}

function installSdkFake(): void {
  setCodexSdkLoader(async () => ({
    createClient: (clientOptions): CodexClient => {
      const makeThread = (
        kind: "start" | "resume",
        existingId: string | null,
        options: CodexThreadOptions | undefined,
      ): CodexThreadHandle => ({
        id: existingId,
        async runStreamed(input, turnOptions) {
          sdkCalls.push({
            kind,
            threadId: existingId,
            options,
            env: clientOptions.env,
            input,
          });
          const turn = turnScript.shift() ?? successTurn();
          if (turn.throws) throw turn.throws;
          const signal = turnOptions?.signal;
          if (turn.hangUntilAborted) {
            await new Promise<void>((resolve) => {
              if (signal?.aborted) return resolve();
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            throw abortError;
          }
          if (turn.beforeReturn) await turn.beforeReturn();
          return {
            events: (async function* () {
              for (const event of turn.events) yield event;
            })(),
          };
        },
      });
      return {
        startThread: (options) => makeThread("start", null, options),
        resumeThread: (id, options) => makeThread("resume", id, options),
      };
    },
  }));
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name,
      title: "Codex Tester",
      mission: "Exercise the Codex provider end to end with a fake SDK.",
      provider: "codex_chatgpt",
      securityPreset: "assistant",
      autonomy: "autonomous",
      permissionOverrides: {
        maxTaskBudgetCents: null,
        dailyBudgetCents: null,
        maxTasksPerDay: null,
      },
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
      ...extra,
    });
  if (res.status === 201) createdAgentIds.push(res.body.id);
  expect(res.status).toBe(201);
  await request(app).post(`/api/agents/${res.body.id}/pause`).send({ paused: true });
  return res.body as { id: string; name: string };
}

async function insertTask(
  agentId: string,
  overrides: Partial<typeof tasksTable.$inferInsert> = {},
) {
  const [task] = await db
    .insert(tasksTable)
    .values({
      workspaceId: wsId,
      agentId,
      objective: `${RUN_TAG} scripted objective`,
      provider: "codex_chatgpt",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      status: "queued",
      ...overrides,
    })
    .returning();
  return task!;
}

async function getTaskRow(id: string) {
  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, id))
    .limit(1);
  return task!;
}

async function getLogs(taskId: string) {
  return db
    .select()
    .from(taskLogsTable)
    .where(eq(taskLogsTable.taskId, taskId))
    .orderBy(taskLogsTable.createdAt);
}

/** Claim and run one task scoped to this file's agents only. */
async function drainOne(agentIds: string[]): Promise<boolean> {
  const claimed = await claimNextTask({ agentIds, includePausedAgents: true });
  if (!claimed) return false;
  await runTask(claimed);
  return true;
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
  savedSettings = await db
    .select()
    .from(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, wsId),
        inArray(workspaceSettingsTable.key, SETTINGS_KEYS),
      ),
    );

  // Deliberately NOT under the OS temp dir: the runtime refuses scratch
  // storage outright, so a fixture there would test the rejection path
  // rather than the real one. This lives beside the package instead.
  const scratchRoot = path.resolve(import.meta.dirname, "../../.test-codex");
  await mkdir(scratchRoot, { recursive: true });
  const base = await mkdtemp(path.join(scratchRoot, "hc-codex-"));
  codexHome = path.join(base, "home");
  workspaceRoot = path.join(base, "workspaces");
});

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error("network disabled in tests");
  });
  vi.stubEnv("CODEX_ENABLED", "1");
  vi.stubEnv("CODEX_HOME", codexHome);
  vi.stubEnv("CODEX_WORKSPACE_ROOT", workspaceRoot);
  vi.stubEnv("CODEX_AUTH_JSON", "");
  // Fixed so the encryption key is deterministic across the file; the real
  // one is never read into a test.
  vi.stubEnv("SESSION_SECRET", "codex-test-session-secret");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "test-claude-token");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  clearProviderCaches();
  resetCodexHealthCheck();
  sdkCalls.length = 0;
  turnScript = [];
  installSdkFake();
  await connectAuth(CHATGPT_AUTH);
});

afterEach(async () => {
  setCodexSdkLoader(null);
  // Never leave a lease behind for the next test (or the live worker).
  const fingerprint = await codexAuthFingerprint();
  if (fingerprint) {
    await db
      .delete(providerLeasesTable)
      .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint)));
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  setCodexSdkLoader(null);
  // The fixture sign-in is stored, not just written to disk; leaving it
  // behind would hand the dev worker a fake ChatGPT session.
  await db
    .delete(codexCredentialsTable)
    .where(
      inArray(codexCredentialsTable.clerkUserId, [
        authState.userId,
        `${authState.userId}-second`,
      ]),
    );
  if (createdAgentIds.length > 0) {
    await db
      .delete(providerConversationsTable)
      .where(inArray(providerConversationsTable.agentId, createdAgentIds));
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  // Audit rows are append-only and hash-chained; they are left in place.
  await db
    .delete(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, wsId),
        inArray(workspaceSettingsTable.key, SETTINGS_KEYS),
      ),
    );
  for (const row of savedSettings) {
    await db.insert(workspaceSettingsTable).values(row);
  }
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
  // The fixture home holds a (fake) credential file; do not leave it behind.
  await rm(path.resolve(import.meta.dirname, "../../.test-codex"), {
    recursive: true,
    force: true,
  });
  await pool.end();
});

/* ------------------------------------------------------------------ */

// eslint-disable-next-line import/order -- test-only import for the pure sandbox mapper
import { codexSandboxFor } from "../codex/execute";

describe("Codex sandbox derivation", () => {
  it("forces the strictest sandbox for a sensitive-data agent, beating preset, autonomy, and the network env flag", () => {
    // The most permissive combination possible: trusted operator, fully
    // autonomous, with CODEX_ALLOW_NETWORK opted in — the sandbox still wins.
    const profile = codexSandboxFor({
      securityPreset: "operator",
      autonomy: "autonomous",
      allowNetwork: true,
      sensitiveDataSandbox: true,
    });
    expect(profile).toEqual({
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    });
    // Sanity: without the flag, the same trusted combination gets network.
    const open = codexSandboxFor({
      securityPreset: "operator",
      autonomy: "autonomous",
      allowNetwork: true,
      sensitiveDataSandbox: false,
    });
    expect(open.networkAccessEnabled).toBe(true);
    expect(open.webSearchMode).toBe("live");
  });
});

describe("Codex credential storage", () => {
  it("reports the ChatGPT allowance only for a chatgpt-mode credential", async () => {
    const state = await codexRuntimeState();
    expect(state.enabled).toBe(true);
    expect(state.storageReady).toBe(true);
    expect(state.authMode).toBe("chatgpt");
    expect(state.usesChatGptAllowance).toBe(true);
    expect(state.ready).toBe(true);
    // The fingerprint identifies the account, so it must carry nothing
    // from the credential itself.
    expect(state.detail).not.toContain("sk-test-access-token");
    expect(JSON.stringify(state)).not.toContain("rt-test-refresh-token");
  });

  it("refuses to call an API-key credential a ChatGPT allowance", async () => {
    await connectAuth({ OPENAI_API_KEY: "sk-live-not-a-subscription" });
    const state = await codexRuntimeState();
    expect(state.authMode).toBe("api_key");
    expect(state.usesChatGptAllowance).toBe(false);
    expect(state.ready).toBe(false);
    expect(JSON.stringify(state)).not.toContain("sk-live-not-a-subscription");
  });

  it("treats an expired session as not ready without deleting it", async () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    await connectAuth({ ...CHATGPT_AUTH, last_refresh: old });
    const state = await codexRuntimeState();
    expect(state.authExpired).toBe(true);
    expect(state.ready).toBe(false);
    // The stored sign-in survives: only Codex's own refresh path may
    // replace it, so a stale session stays recoverable by re-login.
    const [row] = await db
      .select()
      .from(codexCredentialsTable)
      .where(eq(codexCredentialsTable.clerkUserId, authState.userId));
    expect(row?.authMode).toBe("chatgpt");
  });

  it("asks the account to connect a session rather than failing obscurely", async () => {
    await disconnectCodexCredential(authState.userId);
    const state = await codexRuntimeState();
    // Storage is fine — there is simply nobody signed in to Codex yet, and
    // the difference matters to whoever reads the message.
    expect(state.storageReady).toBe(true);
    expect(state.authPresent).toBe(false);
    expect(state.ready).toBe(false);
    expect(state.detail).toMatch(/codex login/i);
  });

  it("never stores the sign-in where a database dump would reveal it", async () => {
    const [row] = await db
      .select()
      .from(codexCredentialsTable)
      .where(eq(codexCredentialsTable.clerkUserId, authState.userId));
    expect(row).toBeDefined();
    expect(row?.authJson).not.toContain("rt-test-refresh-token");
    expect(row?.authJson).not.toContain("sk-test-access-token");
    expect(row?.authJson.startsWith("v1.")).toBe(true);
  });

  it("survives a filesystem that is wiped between runs", async () => {
    // Exactly what a redeploy does: the working copy disappears while the
    // stored session stays put. The next run must rebuild it.
    const home = codexHomeFor(authState.userId);
    await rm(home, { recursive: true, force: true });
    const { home: rebuilt } = await materializeCodexHome(authState.userId);
    const restored = JSON.parse(
      await readFile(path.join(rebuilt, "auth.json"), "utf8"),
    );
    expect(restored.tokens.account_id).toBe("acct_test");

    const dir = await stat(rebuilt);
    expect(dir.mode & 0o077).toBe(0);
    const file = await stat(path.join(rebuilt, "auth.json"));
    expect(file.mode & 0o077).toBe(0);
  });

  it("folds a session Codex refreshed mid-run back into storage", async () => {
    const { home, revision } = await materializeCodexHome(authState.userId);
    // Stand in for the CLI rotating its own tokens during a run.
    const refreshedAt = new Date().toISOString();
    await writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({
        ...CHATGPT_AUTH,
        tokens: { ...CHATGPT_AUTH.tokens, refresh_token: "rt-rotated" },
        last_refresh: refreshedAt,
      }),
      { mode: 0o600 },
    );
    expect(await persistCodexRefresh(authState.userId, revision)).toBe(true);

    // Wipe the disk copy and rebuild it: the rotated token must come back,
    // otherwise the account is left holding a spent refresh token.
    await rm(home, { recursive: true, force: true });
    const { home: rebuilt } = await materializeCodexHome(authState.userId);
    const restored = JSON.parse(
      await readFile(path.join(rebuilt, "auth.json"), "utf8"),
    );
    expect(restored.tokens.refresh_token).toBe("rt-rotated");
  });

  it("ignores a half-written credential rather than saving it back", async () => {
    const { home, revision } = await materializeCodexHome(authState.userId);
    await writeFile(path.join(home, "auth.json"), '{"auth_mode": "chat', {
      mode: 0o600,
    });
    expect(await persistCodexRefresh(authState.userId, revision)).toBe(false);
    // Valid JSON that still claims to be a ChatGPT sign-in but carries no
    // tokens is the same kind of partial write, and just as unusable.
    await writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "x" } }),
      { mode: 0o600 },
    );
    expect(await persistCodexRefresh(authState.userId, revision)).toBe(false);
    // The stored session is still the good one.
    await rm(home, { recursive: true, force: true });
    const { home: rebuilt } = await materializeCodexHome(authState.userId);
    const restored = JSON.parse(
      await readFile(path.join(rebuilt, "auth.json"), "utf8"),
    );
    expect(restored.auth_mode).toBe("chatgpt");
  });

  it("does not undo a reconnect that happened while a run was going", async () => {
    // The run starts from the session stored now...
    const { home, revision } = await materializeCodexHome(authState.userId);
    // ...and mid-run the person pastes a fresh sign-in from `codex login`.
    await connectAuth({
      ...CHATGPT_AUTH,
      tokens: { ...CHATGPT_AUTH.tokens, refresh_token: "rt-freshly-pasted" },
    });
    await writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({
        ...CHATGPT_AUTH,
        tokens: { ...CHATGPT_AUTH.tokens, refresh_token: "rt-from-old-run" },
      }),
      { mode: 0o600 },
    );
    expect(await persistCodexRefresh(authState.userId, revision)).toBe(false);

    await rm(home, { recursive: true, force: true });
    const { home: rebuilt } = await materializeCodexHome(authState.userId);
    const restored = JSON.parse(
      await readFile(path.join(rebuilt, "auth.json"), "utf8"),
    );
    expect(restored.tokens.refresh_token).toBe("rt-freshly-pasted");
  });

  it("does not resurrect a session disconnected while a run was going", async () => {
    const { home, revision } = await materializeCodexHome(authState.userId);
    await disconnectCodexCredential(authState.userId);
    await writeFile(path.join(home, "auth.json"), JSON.stringify(CHATGPT_AUTH), {
      mode: 0o600,
    });
    expect(await persistCodexRefresh(authState.userId, revision)).toBe(false);
    expect((await codexRuntimeState()).authPresent).toBe(false);
  });

  it("keeps each account's session separate", async () => {
    const other = `${authState.userId}-second`;
    await saveCodexCredential(
      other,
      JSON.stringify({
        ...CHATGPT_AUTH,
        tokens: { ...CHATGPT_AUTH.tokens, account_id: "acct_other" },
      }),
    );
    try {
      // Different directories and different lease keys, so two people run
      // at the same time on their own allowances.
      expect(codexHomeFor(other)).not.toBe(codexHomeFor(authState.userId));
      expect(await codexAuthFingerprint(other)).not.toBe(
        await codexAuthFingerprint(authState.userId),
      );

      const { home: mine } = await materializeCodexHome(authState.userId);
      const { home: theirs } = await materializeCodexHome(other);
      const mineAuth = await readFile(path.join(mine, "auth.json"), "utf8");
      const theirsAuth = await readFile(path.join(theirs, "auth.json"), "utf8");
      expect(mineAuth).toContain("acct_test");
      expect(mineAuth).not.toContain("acct_other");
      expect(theirsAuth).toContain("acct_other");

      const state = await codexRuntimeState(other);
      expect(state.clerkUserId).toBe(other);
      expect(state.ready).toBe(true);
    } finally {
      await disconnectCodexCredential(other);
    }
  });

  it("disconnecting removes the stored session and its working copy", async () => {
    const { home } = await materializeCodexHome(authState.userId);
    expect(await disconnectCodexCredential(authState.userId)).toBe(true);
    await expect(stat(path.join(home, "auth.json"))).rejects.toThrow();
    const state = await codexRuntimeState();
    expect(state.authPresent).toBe(false);
    expect(state.ready).toBe(false);
  });

  it("says to reconnect when the encryption key no longer matches", async () => {
    // Rotating SESSION_SECRET must surface as "reconnect Codex", never as
    // a run that quietly proceeds without a session.
    vi.stubEnv("SESSION_SECRET", "a-different-session-secret");
    const state = await codexRuntimeState();
    expect(state.ready).toBe(false);
    expect(state.detail).toMatch(/reconnect/i);
  });

  it("refuses a pasted file that is not JSON without echoing it", async () => {
    const response = await request(app)
      .post("/api/providers/codex/credential")
      .send({ authJson: "definitely-not-json-sk-secret" });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).not.toContain("sk-secret");
  });

  it("connects a pasted sign-in and reports how it is billed", async () => {
    await disconnectCodexCredential(authState.userId);
    const response = await request(app)
      .post("/api/providers/codex/credential")
      .send({ authJson: JSON.stringify(CHATGPT_AUTH) });
    expect(response.status).toBe(200);
    expect(response.body.action).toBe("connected");
    expect(JSON.stringify(response.body)).not.toContain("rt-test-refresh-token");
    expect((await codexRuntimeState()).ready).toBe(true);

    // An API-key file is stored but never passed off as a subscription.
    const apiKey = await connectCodexCredential(
      authState.userId,
      JSON.stringify({ OPENAI_API_KEY: "sk-api-billing" }),
    );
    expect(apiKey.detail).toMatch(/api key/i);
    expect((await codexRuntimeState()).usesChatGptAllowance).toBe(false);
  });

  it("bootstrap never overwrites a session Codex has since refreshed", async () => {
    // Restoring the seed would roll the account back to a revoked token.
    vi.stubEnv("CODEX_AUTH_JSON", JSON.stringify({ auth_mode: "chatgpt" }));
    await connectAuth({
      ...CHATGPT_AUTH,
      tokens: { ...CHATGPT_AUTH.tokens, account_id: "refreshed" },
    });
    const outcome = await bootstrapCodexHome();
    expect(outcome.action).toBe("preserved");
    const { home } = await materializeCodexHome(authState.userId);
    const after = JSON.parse(
      await readFile(path.join(home, "auth.json"), "utf8"),
    );
    expect(after.tokens.account_id).toBe("refreshed");
  });

  it("reports Codex as unavailable rather than throwing when the flag is off", async () => {
    vi.stubEnv("CODEX_ENABLED", "");
    const outcome = await bootstrapCodexHome();
    expect(outcome.action).toBe("unavailable");
    const state = await codexRuntimeState();
    expect(state.enabled).toBe(false);
    expect(state.ready).toBe(false);
  });

  it("hands Codex an allowlisted environment with no API-key billing variables", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-should-not-leak");
    vi.stubEnv("CODEX_API_KEY", "sk-also-should-not-leak");
    const env = codexChildEnv(codexHome);
    expect(env.CODEX_HOME).toBe(codexHome);
    for (const forbidden of CODEX_FORBIDDEN_ENV) {
      expect(env[forbidden]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain("sk-should-not-leak");
    expect(JSON.stringify(env)).not.toContain("sk-also-should-not-leak");
  });
});

describe("Codex owner endpoints", () => {
  it("tests the connection locally without contacting the provider", async () => {
    const res = await request(app).post("/api/providers/codex/test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const names = res.body.checks.map((c: { name: string }) => c.name);
    expect(names).toContain("ChatGPT authentication");
    expect(names).toContain("Codex SDK");
    // A "test" that spent allowance would be a trap; nothing goes out.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sdkCalls).toHaveLength(0);
  });

  it("explains an unusable credential instead of reporting a healthy provider", async () => {
    await connectAuth({ OPENAI_API_KEY: "sk-api-billing" });
    const res = await request(app).post("/api/providers/codex/test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    const auth = res.body.checks.find(
      (c: { name: string }) => c.name === "ChatGPT authentication",
    );
    expect(auth.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("sk-api-billing");
  });

  it("surfaces Codex in provider status with its models and reasoning levels", async () => {
    const res = await request(app).get("/api/providers");
    const codex = res.body.find(
      (s: { provider: string }) => s.provider === "codex_chatgpt",
    );
    expect(codex.enabled).toBe(true);
    expect(codex.billing).toBe("subscription");
    expect(codex.allowanceBalanceKnown).toBe(false);
    expect(codex.usesSubscriptionAllowance).toBe(true);
    expect(codex.reasoningLevels).toEqual(["low", "medium", "high"]);

    const catalog = await request(app).get("/api/providers/codex_chatgpt/models");
    expect(catalog.status).toBe(200);
    expect(catalog.body.available).toBe(true);
    expect(catalog.body.models.map((m: { id: string }) => m.id)).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]);
    // A plan-backed model has no published per-token price, so none is shown.
    for (const model of catalog.body.models) {
      expect(model.promptCentsPerMTok).toBeNull();
      expect(model.completionCentsPerMTok).toBeNull();
    }
  });

  it("finds the real SDK and its native CLI in this deployment", async () => {
    // Guards the packaging path: the SDK is only a wrapper around the
    // platform-specific `codex` binary, and an esbuild bundle that swallows
    // it fails opaquely at run time instead of here.
    setCodexSdkLoader(null);
    const { codexSdkAvailable } = await import("../codex/sdk");
    const availability = await codexSdkAvailable();
    expect(availability.available).toBe(true);
    expect(availability.detail).toMatch(/Native Codex CLI present/);
  });

  it("hides Codex behind its feature flag without breaking the other two", async () => {
    vi.stubEnv("CODEX_ENABLED", "");
    clearProviderCaches();
    const res = await request(app).get("/api/providers");
    const byId = Object.fromEntries(
      res.body.map((s: { provider: string }) => [s.provider, s]),
    );
    expect(byId.codex_chatgpt.enabled).toBe(false);
    expect(byId.codex_chatgpt.healthy).toBe(false);
    // Existing providers are untouched by the flag.
    expect(byId.claude_max.enabled).toBe(true);
    expect(byId.openrouter.enabled).toBe(true);
  });

  it("persists Codex defaults and rejects a model the server does not offer", async () => {
    const ok = await request(app).put("/api/providers/settings").send({
      defaultProvider: "codex_chatgpt",
      codexModel: "gpt-5.6-sol",
      codexReasoning: "high",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.codexModel).toBe("gpt-5.6-sol");
    expect(ok.body.codexReasoning).toBe("high");

    const fetched = await request(app).get("/api/providers/settings");
    expect(fetched.body.codexModel).toBe("gpt-5.6-sol");

    const bad = await request(app).put("/api/providers/settings").send({
      codexModel: "gpt-9-imaginary",
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/gpt-9-imaginary/);
  });

  it("keeps per-agent Codex preferences across create and update", async () => {
    const agent = await createAgent(`${RUN_TAG} Prefs`, {
      codexModel: "gpt-5.6-luna",
      codexReasoning: "low",
    });
    const read = await request(app).get(`/api/agents/${agent.id}`);
    expect(read.body.agent.codexModel).toBe("gpt-5.6-luna");
    expect(read.body.agent.codexReasoning).toBe("low");

    const updated = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ codexReasoning: "high" });
    expect(updated.status).toBe(200);
    expect(updated.body.codexReasoning).toBe("high");
    // An unrelated field is not disturbed by the Codex edit.
    expect(updated.body.codexModel).toBe("gpt-5.6-luna");
  });
});

describe("Codex execution", () => {
  it("runs a turn in an isolated workspace and records granular usage", async () => {
    const agent = await createAgent(`${RUN_TAG} Runner`);
    turnScript = [successTurn("Done: three kelp reports filed.")];
    const task = await insertTask(agent.id);

    expect(await drainOne([agent.id])).toBe(true);
    const row = await getTaskRow(task.id);
    expect(row.status).toBe("completed");
    expect(row.providerPhase).toBe("completed");
    expect(row.output).toContain("kelp reports filed");
    expect(row.actualInputTokens).toBe(USAGE.input_tokens);
    expect(row.actualOutputTokens).toBe(USAGE.output_tokens);
    expect(row.cachedInputTokens).toBe(USAGE.cached_input_tokens);
    expect(row.cacheWriteInputTokens).toBe(USAGE.cache_write_input_tokens);
    expect(row.reasoningOutputTokens).toBe(USAGE.reasoning_output_tokens);
    expect(row.runMs).not.toBeNull();
    // A ChatGPT-plan run has no published per-token price. Recording 0
    // would be an invented number, so the cost stays absent.
    expect(row.actualCostCents).toBeNull();

    const call = sdkCalls.at(0)!;
    expect(call.kind).toBe("start");
    expect(call.options?.model).toBe("gpt-5.6-terra");
    expect(call.options?.modelReasoningEffort).toBe("medium");
    // The working directory is this agent's own, under the configured root.
    expect(call.options?.workingDirectory?.startsWith(workspaceRoot)).toBe(true);
    expect(call.options?.workingDirectory).toContain(agent.id);
  });

  it("continues the same agent on its persisted thread", async () => {
    const agent = await createAgent(`${RUN_TAG} Threaded`);
    turnScript = [successTurn("First answer."), successTurn("Second answer.")];

    const first = await insertTask(agent.id);
    await drainOne([agent.id]);
    const firstRow = await getTaskRow(first.id);
    expect(firstRow.providerThreadId).toBeTruthy();
    expect(firstRow.conversationId).toBeTruthy();

    const second = await insertTask(agent.id, {
      conversationId: firstRow.conversationId,
    });
    await drainOne([agent.id]);
    const secondRow = await getTaskRow(second.id);
    expect(secondRow.status).toBe("completed");
    expect(sdkCalls.at(1)!.kind).toBe("resume");
    expect(sdkCalls.at(1)!.threadId).toBe(firstRow.providerThreadId);
  });

  it("gives each agent its own conversation, thread, and directory", async () => {
    const one = await createAgent(`${RUN_TAG} Iso A`);
    const two = await createAgent(`${RUN_TAG} Iso B`);
    turnScript = [successTurn("A"), successTurn("B")];

    const taskA = await insertTask(one.id);
    await drainOne([one.id]);
    const taskB = await insertTask(two.id);
    await drainOne([two.id]);

    const rowA = await getTaskRow(taskA.id);
    const rowB = await getTaskRow(taskB.id);
    expect(rowA.conversationId).not.toBe(rowB.conversationId);
    expect(rowA.providerThreadId).not.toBe(rowB.providerThreadId);
    const dirA = sdkCalls.at(0)!.options?.workingDirectory;
    const dirB = sdkCalls.at(1)!.options?.workingDirectory;
    expect(dirA).not.toBe(dirB);
    expect(dirA).toContain(one.id);
    expect(dirB).toContain(two.id);
  });

  it("maps an observer preset to a read-only sandbox with no network", async () => {
    const agent = await createAgent(`${RUN_TAG} Observer`, {
      securityPreset: "observer",
    });
    turnScript = [successTurn("Read-only reply.")];
    await insertTask(agent.id);
    await drainOne([agent.id]);

    const options = sdkCalls.at(0)!.options!;
    expect(options.sandboxMode).toBe("read-only");
    expect(options.networkAccessEnabled).toBe(false);
    expect(options.webSearchMode).toBe("disabled");
    // Codex must never block on an approval HomardClaw cannot deliver.
    expect(options.approvalPolicy).toBe("never");
  });

  it("never exposes credentials to the Codex process or the prompt", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-secret-openai");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-secret-openrouter");
    const agent = await createAgent(`${RUN_TAG} Redaction`);
    turnScript = [successTurn("Nothing leaked.")];
    await insertTask(agent.id);
    await drainOne([agent.id]);

    const call = sdkCalls.at(0)!;
    const serialized = JSON.stringify({ env: call.env, input: call.input });
    expect(serialized).not.toContain("sk-secret-openai");
    expect(serialized).not.toContain("sk-secret-openrouter");
    expect(serialized).not.toContain("sk-test-access-token");
    expect(call.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it("streams sanitized progress into the durable task log", async () => {
    const agent = await createAgent(`${RUN_TAG} Progress`);
    turnScript = [
      {
        events: [
          { type: "thread.started", thread_id: "thr_progress" },
          { type: "turn.started" },
          {
            type: "item.completed",
            item: {
              id: "c1",
              type: "command_execution",
              command: "curl -H 'Authorization: Bearer sk-leaky-token' https://x",
              aggregated_output: "",
              exit_code: 0,
              status: "completed",
            },
          },
          {
            type: "item.completed",
            item: { id: "m1", type: "agent_message", text: "All set." },
          },
          { type: "turn.completed", usage: USAGE },
        ],
      },
    ];
    const task = await insertTask(agent.id);
    await drainOne([agent.id]);

    const logs = await getLogs(task.id);
    const joined = logs.map((l) => l.message).join("\n");
    expect(joined).toContain("Command finished");
    expect(joined).not.toContain("sk-leaky-token");
  });
});

describe("Codex failure handling", () => {
  it("stops on an exhausted allowance and offers the choice, never rerouting silently", async () => {
    // No standing consent: a paid provider must not be picked up on its own.
    await request(app).put("/api/providers/settings").send({
      fallbackOrder: ["openrouter"],
      paidFallbackConsent: false,
      paidFallbackLimitCents: null,
    });
    const agent = await createAgent(`${RUN_TAG} Allowance`);
    turnScript = [failingTurn("You've hit your weekly usage limit for Codex.")];
    const task = await insertTask(agent.id);
    await drainOne([agent.id]);

    const row = await getTaskRow(task.id);
    expect(row.status).toBe("failed");
    expect(row.errorKind).toBe("allowance");
    expect(row.providerPhase).toBe("failed");
    // The provider is unchanged: nothing was rerouted behind the owner's back.
    expect(row.provider).toBe("codex_chatgpt");
    expect(row.fallbackFromProvider).toBeNull();
    const joined = (await getLogs(task.id)).map((l) => l.message).join("\n");
    expect(joined).toMatch(/no automatic fallback applies/i);
  });

  it("moves to a paid provider only after the owner approves it for that task", async () => {
    await request(app).put("/api/providers/settings").send({
      fallbackOrder: ["openrouter"],
      paidFallbackConsent: false,
      paidFallbackLimitCents: null,
    });
    const agent = await createAgent(`${RUN_TAG} Consent`);
    turnScript = [failingTurn("You've hit your weekly usage limit for Codex.")];
    const task = await insertTask(agent.id);
    await drainOne([agent.id]);
    expect((await getTaskRow(task.id)).status).toBe("failed");

    const approved = await request(app)
      .post(`/api/tasks/${task.id}/fallback`)
      .send({ action: "approve_paid_fallback" });
    expect(approved.status).toBe(200);
    const afterApproval = await getTaskRow(task.id);
    expect(afterApproval.paidFallbackApprovedAt).not.toBeNull();
    // Approval alone does not reroute; the policy is re-checked at run time.
    expect(afterApproval.provider).toBe("codex_chatgpt");

    turnScript = [failingTurn("You've hit your weekly usage limit for Codex.")];
    await drainOne([agent.id]);
    const rerouted = await getTaskRow(task.id);
    expect(rerouted.provider).toBe("openrouter");
    expect(rerouted.fallbackFromProvider).toBe("codex_chatgpt");
    expect(rerouted.fallbackReason).toBeTruthy();
    // Cancel so the live dev worker never picks up the rerouted task.
    await request(app).post(`/api/tasks/${task.id}/cancel`);
  });

  it("cancels a task without rerouting it", async () => {
    const agent = await createAgent(`${RUN_TAG} FallbackCancel`);
    turnScript = [failingTurn("You've hit your weekly usage limit for Codex.")];
    const task = await insertTask(agent.id);
    await drainOne([agent.id]);

    const res = await request(app)
      .post(`/api/tasks/${task.id}/fallback`)
      .send({ action: "cancel" });
    expect(res.status).toBe(200);
    const row = await getTaskRow(task.id);
    expect(row.status).toBe("cancelled");
    expect(row.provider).toBe("codex_chatgpt");
  });

  it("keeps a rate-limited task retryable with its wait recorded", async () => {
    const agent = await createAgent(`${RUN_TAG} RateLimit`);
    turnScript = [failingTurn("429 Too Many Requests, please slow down.")];
    const task = await insertTask(agent.id);
    await drainOne([agent.id]);

    const row = await getTaskRow(task.id);
    expect(row.errorKind).toBe("rate_limit");
    expect(row.providerPhase).toBe("rate_limited");
    // Retryable failures go back on the queue behind a wait, not to failed.
    expect(row.status).toBe("queued");
    expect(row.notBefore!.getTime()).toBeGreaterThan(Date.now());
    await request(app).post(`/api/tasks/${task.id}/cancel`);
  });

  it("reports an expired session as authentication required, without retrying blindly", async () => {
    const agent = await createAgent(`${RUN_TAG} AuthExpiry`);
    // The SDK's own refresh path failed; HomardClaw must not attempt any
    // refresh of its own, only report it.
    turnScript = [failingTurn("401 Unauthorized: please run codex login again.")];
    const task = await insertTask(agent.id);
    await drainOne([agent.id]);

    const row = await getTaskRow(task.id);
    expect(row.errorKind).toBe("auth");
    expect(row.providerPhase).toBe("auth_required");
    expect(row.status).toBe("failed");
    expect(sdkCalls).toHaveLength(1);
  });

  it("refuses to start when the credential is API-key backed", async () => {
    await connectAuth({ OPENAI_API_KEY: "sk-api-billing" });
    clearProviderCaches();
    const agent = await createAgent(`${RUN_TAG} ApiKeyRefusal`);
    const task = await insertTask(agent.id);
    await drainOne([agent.id]);

    const row = await getTaskRow(task.id);
    expect(row.status).not.toBe("completed");
    expect(sdkCalls).toHaveLength(0);
    expect(JSON.stringify(row)).not.toContain("sk-api-billing");
  });

  it("stops the run when the SDK is not installed", async () => {
    setCodexSdkLoader(async () => {
      const { CodexSdkUnavailableError } = await import("../codex/sdk");
      throw new CodexSdkUnavailableError("The official Codex SDK is not installed.");
    });
    const agent = await createAgent(`${RUN_TAG} NoSdk`);
    const task = await insertTask(agent.id);
    await drainOne([agent.id]);

    const row = await getTaskRow(task.id);
    expect(row.status).not.toBe("completed");
    expect(row.errorMessage).toMatch(/Codex SDK|not installed/i);
  });
});

describe("Codex task dispatch over HTTP", () => {
  it("applies a per-task reasoning override sent to POST /tasks", async () => {
    const agent = await createAgent(`${RUN_TAG} HTTP Reasoning`);
    const res = await request(app)
      .post("/api/tasks")
      .send({
        agentId: agent.id,
        objective: `${RUN_TAG} think harder about the kelp ledger`,
        reasoningOverride: "high",
      });
    expect(res.status).toBe(201);
    // The agent's own preference is medium; the override has to survive the
    // route, not just the dispatch helper it delegates to.
    expect((await getTaskRow(res.body.id)).reasoningEffort).toBe("high");
  });

  it("rejects a reasoning level the server does not offer", async () => {
    const agent = await createAgent(`${RUN_TAG} HTTP Bad Reasoning`);
    const res = await request(app)
      .post("/api/tasks")
      .send({
        agentId: agent.id,
        objective: `${RUN_TAG} attempt an unsupported effort level`,
        reasoningOverride: "ultra",
      });
    expect(res.status).toBe(422);
  });

  it("continues the agent's existing thread only when POST /tasks asks for it", async () => {
    const agent = await createAgent(`${RUN_TAG} HTTP Continue`);
    turnScript = [successTurn("First turn."), successTurn("Second turn.")];
    // Run one task so the agent has a resumable conversation to continue.
    const first = await insertTask(agent.id);
    await drainOne([agent.id]);
    const firstRow = await getTaskRow(first.id);
    expect(firstRow.conversationId).not.toBeNull();

    const fresh = await request(app)
      .post("/api/tasks")
      .send({ agentId: agent.id, objective: `${RUN_TAG} unrelated new question` });
    expect(fresh.status).toBe(201);
    expect((await getTaskRow(fresh.body.id)).conversationId).toBeNull();

    const continued = await request(app)
      .post("/api/tasks")
      .send({
        agentId: agent.id,
        objective: `${RUN_TAG} follow up on that`,
        continueConversation: true,
      });
    expect(continued.status).toBe(201);
    expect((await getTaskRow(continued.body.id)).conversationId).toBe(
      firstRow.conversationId,
    );
  });
});

describe("Codex serialization and recovery", () => {
  it("queues a second Codex task behind the one holding the credential", async () => {
    const agent = await createAgent(`${RUN_TAG} Serial`);
    const fingerprint = (await codexAuthFingerprint())!;
    // Simulate another run already holding this auth file's lease.
    const held = await acquireProviderLease(
      codexLeaseKey(fingerprint),
      "00000000-0000-4000-8000-00000000beef",
      60_000,
    );
    expect(held.acquired).toBe(true);

    const task = await insertTask(agent.id);
    await drainOne([agent.id]);
    const row = await getTaskRow(task.id);
    expect(row.status).toBe("queued");
    // Waiting in line is not a failed attempt; the retry budget is intact.
    expect(row.attempts).toBe(0);
    expect(sdkCalls).toHaveLength(0);
    const joined = (await getLogs(task.id)).map((l) => l.message).join("\n");
    expect(joined).toMatch(/Another Codex task is using the ChatGPT session/i);
    await request(app).post(`/api/tasks/${task.id}/cancel`);
  });

  it("releases the credential when the run finishes so the next task proceeds", async () => {
    const agent = await createAgent(`${RUN_TAG} Release`);
    turnScript = [successTurn("First."), successTurn("Second.")];
    await insertTask(agent.id);
    await drainOne([agent.id]);

    const fingerprint = (await codexAuthFingerprint())!;
    const leases = await db
      .select()
      .from(providerLeasesTable)
      .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint)));
    expect(leases).toHaveLength(0);

    const second = await insertTask(agent.id);
    await drainOne([agent.id]);
    expect((await getTaskRow(second.id)).status).toBe("completed");
  });

  it("leaves other providers free to run while Codex is serialized", async () => {
    const codexAgent = await createAgent(`${RUN_TAG} Blocked Codex`);
    const otherAgent = await createAgent(`${RUN_TAG} Free OpenRouter`, {
      provider: "openrouter",
    });
    const fingerprint = (await codexAuthFingerprint())!;
    await acquireProviderLease(
      codexLeaseKey(fingerprint),
      "00000000-0000-4000-8000-00000000cafe",
      60_000,
    );
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "test-vendor/test-model",
                name: "Test Model",
                context_length: 8192,
                pricing: { prompt: "0.000001", completion: "0.00001" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "OpenRouter is unaffected." } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const codexTask = await insertTask(codexAgent.id);
    const otherTask = await insertTask(otherAgent.id, {
      provider: "openrouter",
      model: "test-vendor/test-model",
      reasoningEffort: null,
      estimatedCostCents: 1,
    });
    await drainOne([codexAgent.id]);
    await drainOne([otherAgent.id]);

    expect((await getTaskRow(codexTask.id)).status).toBe("queued");
    expect((await getTaskRow(otherTask.id)).status).toBe("completed");
    await request(app).post(`/api/tasks/${codexTask.id}/cancel`);
  });

  it("cancels a running Codex turn and keeps the partial record", async () => {
    const agent = await createAgent(`${RUN_TAG} Cancel`);
    turnScript = [{ events: [], hangUntilAborted: true }];
    const task = await insertTask(agent.id);

    const claimed = await claimNextTask({
      agentIds: [agent.id],
      includePausedAgents: true,
    });
    expect(claimed).not.toBeNull();
    const running = runTask(claimed!);
    // Cancel while the turn is still streaming.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await request(app).post(`/api/tasks/${task.id}/cancel`);
    await running;

    const row = await getTaskRow(task.id);
    expect(row.status).toBe("cancelled");
    // An interrupted turn is never recorded as completed.
    expect(row.status).not.toBe("completed");
    const fingerprint = (await codexAuthFingerprint())!;
    const leases = await db
      .select()
      .from(providerLeasesTable)
      .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint)));
    expect(leases).toHaveLength(0);
  });

  it("keeps renewing the credential lease so a long run is never overtaken", async () => {
    const agent = await createAgent(`${RUN_TAG} Heartbeat`);
    turnScript = [{ events: [], hangUntilAborted: true }];
    const task = await insertTask(agent.id);
    const fingerprint = (await codexAuthFingerprint())!;
    // Beat far faster than the minute-floor TTL so the renewal path runs
    // several times inside the test rather than being taken on trust.
    setCodexLeaseHeartbeatMs(25);
    try {
      const claimed = await claimNextTask({
        agentIds: [agent.id],
        includePausedAgents: true,
      });
      expect(claimed).not.toBeNull();
      const running = runTask(claimed!);
      // Poll rather than sleep a fixed span: under a loaded suite a DB
      // round trip can outlast any interval short enough to be worth
      // waiting for, and a renewal that never happens still fails here.
      const deadline = Date.now() + 10_000;
      let lease: typeof providerLeasesTable.$inferSelect | undefined;
      while (Date.now() < deadline) {
        [lease] = await db
          .select()
          .from(providerLeasesTable)
          .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint)));
        if (lease && lease.heartbeatAt.getTime() > lease.acquiredAt.getTime()) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(lease).toBeDefined();
      // The heartbeat pushed the lease forward from the moment it was taken.
      expect(lease!.heartbeatAt.getTime()).toBeGreaterThan(
        lease!.acquiredAt.getTime(),
      );
      expect(lease!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      await request(app).post(`/api/tasks/${task.id}/cancel`);
      await running;
    } finally {
      setCodexLeaseHeartbeatMs(null);
    }
  });

  it("requeues rather than reports an outcome when the lease is lost mid-run", async () => {
    const agent = await createAgent(`${RUN_TAG} Lease Lost`);
    turnScript = [{ events: [], hangUntilAborted: true }];
    const task = await insertTask(agent.id);
    const fingerprint = (await codexAuthFingerprint())!;
    setCodexLeaseHeartbeatMs(25);
    try {
      const claimed = await claimNextTask({
        agentIds: [agent.id],
        includePausedAgents: true,
      });
      expect(claimed).not.toBeNull();
      const running = runTask(claimed!);
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Simulate the lease expiring and being taken by another process:
      // the row is no longer ours, so the next renewal must be refused.
      await db
        .delete(providerLeasesTable)
        .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint)));
      await running;

      const row = await getTaskRow(task.id);
      // An attempt that cannot prove it still owned the credential must
      // never report a result of any kind.
      expect(row.status).toBe("queued");
      expect(row.status).not.toBe("completed");
      expect(row.status).not.toBe("failed");
      // Losing the race is not a failed attempt; the retry budget survives.
      expect(row.attempts).toBe(0);
      const joined = (await getLogs(task.id)).map((l) => l.message).join("\n");
      expect(joined).toMatch(/lost the codex session lease/i);
      await request(app).post(`/api/tasks/${task.id}/cancel`);
    } finally {
      setCodexLeaseHeartbeatMs(null);
    }
  });

  it("requeues instead of completing when the lease is lost as the call returns", async () => {
    const agent = await createAgent(`${RUN_TAG} Lease Race`);
    const fingerprint = (await codexAuthFingerprint())!;
    // The turn succeeds normally; the lease disappears during it. The run
    // therefore reaches the success path holding a credential it no longer
    // owns — the window a catch-block-only check would miss entirely.
    turnScript = [
      {
        ...successTurn("Raced the lease and won the call."),
        beforeReturn: async () => {
          await db
            .delete(providerLeasesTable)
            .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint)));
        },
      },
    ];
    // Heartbeat left at its normal interval on purpose: this is the window
    // a heartbeat cannot cover, so the check under test is the explicit
    // ownership confirmation, not a lucky beat.
    try {
      const task = await insertTask(agent.id);
      await drainOne([agent.id]);
      const row = await getTaskRow(task.id);
      // A successful provider return is not enough: without the lease this
      // attempt cannot claim the result is the only one for this credential.
      expect(row.status).toBe("queued");
      expect(row.status).not.toBe("completed");
      expect(row.output).toBeNull();
      expect(row.actualInputTokens).toBeNull();
      expect(row.attempts).toBe(0);
      const joined = (await getLogs(task.id)).map((l) => l.message).join("\n");
      expect(joined).toMatch(/lost the codex session lease/i);
      await request(app).post(`/api/tasks/${task.id}/cancel`);
    } finally {
      setCodexLeaseHeartbeatMs(null);
    }
  });

  it("requeues interrupted Codex work after a restart instead of completing it", async () => {
    const agent = await createAgent(`${RUN_TAG} Restart`);
    const task = await insertTask(agent.id, {
      status: "running",
      startedAt: new Date(Date.now() - 60_000),
      attempts: 1,
      providerPhase: "running",
      providerThreadId: "thr_interrupted",
    });
    const recovered = await recoverInterruptedTasks();
    expect(recovered).toBeGreaterThan(0);

    const row = await getTaskRow(task.id);
    expect(row.status).not.toBe("completed");
    expect(["queued", "failed"]).toContain(row.status);
    // The thread survives, so the resumed run continues the conversation.
    expect(row.providerThreadId).toBe("thr_interrupted");
    await request(app).post(`/api/tasks/${task.id}/cancel`);
  });
});

describe("Codex health check", () => {
  it("stays quiet when the provider is off or nobody has connected", async () => {
    vi.stubEnv("CODEX_ENABLED", "");
    expect(await runCodexHealthCheck()).toBe(false);
    // Switched on, but no account has connected a ChatGPT session: there is
    // no credential whose health could decay, so nothing is monitored.
    vi.stubEnv("CODEX_ENABLED", "1");
    await disconnectCodexCredential(authState.userId);
    expect(await runCodexHealthCheck()).toBe(false);
  });

  it("runs at most once per configured interval and never calls the provider", async () => {
    vi.stubEnv("CODEX_HEALTH_CHECK_MINUTES", "30");
    const now = Date.now();
    expect(await runCodexHealthCheck(now)).toBe(true);
    expect(await runCodexHealthCheck(now + 60_000)).toBe(false);
    expect(await runCodexHealthCheck(now + 31 * 60_000)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sdkCalls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Talk (typed + voice conversations)                                  */
/* ------------------------------------------------------------------ */

const TALK_REPLY_JSON = '{"reply":"Claws crossed, boss.","taskObjective":null}';

function talkTurn(reply = TALK_REPLY_JSON): ScriptedTurn {
  return successTurn(reply);
}

/** Route managed-speech traffic for voice-converse; everything else dies. */
function mockSpeech(transcript: string): void {
  vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", "https://openai.test/v1");
  vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "test-openai-key");
  fetchMock.mockImplementation(async (url: unknown) => {
    const target = String(url);
    if (target.includes("openai.test") && target.includes("/audio/transcriptions")) {
      return new Response(JSON.stringify({ text: transcript }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (target.includes("openai.test") && target.includes("/chat/completions")) {
      const frames = ['{"choices":[{"delta":{"audio":{"data":"QUFBQQ=="}}}]}'];
      const body = frames.map((f) => `data: ${f}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  });
}

/** Minimal RIFF/WAVE header so format detection skips ffmpeg conversion. */
const FAKE_WAV_BASE64 = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([16, 0, 0, 0]),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(32),
]).toString("base64");

async function talkConversationRows(agentId: string) {
  return db
    .select()
    .from(providerConversationsTable)
    .where(eq(providerConversationsTable.agentId, agentId));
}

describe("Codex Talk conversations", () => {
  afterEach(() => {
    setCodexTalkLeaseWait(null);
  });

  it("answers a typed Talk message from a healthy Codex session in an isolated sandboxed workspace", async () => {
    // Regression: this exact call used to fail before reaching Codex —
    // no workspace was prepared — and was reported as a missing provider
    // key even though the Providers card showed a healthy session.
    const agent = await createAgent(`${RUN_TAG} Talker`);
    turnScript = [talkTurn()];

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "How is the kelp doing?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Claws crossed, boss.");
    expect(res.body.proposedTaskObjective).toBeNull();

    // Ran in this agent's own workspace with a derived sandbox, and the
    // Talk framing actually reached Codex.
    expect(sdkCalls).toHaveLength(1);
    const call = sdkCalls[0]!;
    expect(call.kind).toBe("start");
    expect(call.options?.workingDirectory?.startsWith(
      path.join(workspaceRoot, agent.id),
    )).toBe(true);
    expect(call.options?.sandboxMode).toBe("workspace-write");
    expect(call.options?.networkAccessEnabled).toBe(false);
    expect(call.options?.approvalPolicy).toBe("never");
    expect(call.input).toContain("lobster agent");
    expect(call.input).toContain("How is the kelp doing?");

    // The lease is released the moment the turn ends.
    const fingerprint = await codexAuthFingerprint();
    const leases = await db
      .select()
      .from(providerLeasesTable)
      .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint!)));
    expect(leases).toHaveLength(0);
  });

  it("resumes the same agent's thread on the next Talk turn and records the thread id", async () => {
    const agent = await createAgent(`${RUN_TAG} Continuity`);
    turnScript = [talkTurn(), talkTurn()];

    const first = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "First turn." });
    expect(first.status).toBe(200);
    // The SDK-issued thread id was recorded on the conversation row.
    const afterFirst = await talkConversationRows(agent.id);
    expect(afterFirst).toHaveLength(1);
    const firstThreadId = afterFirst[0]!.threadId;
    expect(firstThreadId).toMatch(/^thr_/);

    const second = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Second turn." });
    expect(second.status).toBe(200);

    expect(sdkCalls).toHaveLength(2);
    expect(sdkCalls[1]!.kind).toBe("resume");
    expect(sdkCalls[1]!.threadId).toBe(firstThreadId);
    const rows = await talkConversationRows(agent.id);
    expect(rows).toHaveLength(1);
    // Both turns shared one conversation directory.
    expect(sdkCalls[1]!.options?.workingDirectory).toBe(
      sdkCalls[0]!.options?.workingDirectory,
    );
  });

  it("never shares a workspace or thread across agents", async () => {
    const crab = await createAgent(`${RUN_TAG} Crab`);
    const prawn = await createAgent(`${RUN_TAG} Prawn`);
    turnScript = [talkTurn(), talkTurn()];

    await request(app).post(`/api/agents/${crab.id}/converse`).send({ text: "Hi" });
    await request(app).post(`/api/agents/${prawn.id}/converse`).send({ text: "Hi" });

    expect(sdkCalls).toHaveLength(2);
    // The second agent starts fresh: no resume of the first agent's thread.
    expect(sdkCalls[1]!.kind).toBe("start");
    expect(sdkCalls[0]!.options?.workingDirectory).not.toBe(
      sdkCalls[1]!.options?.workingDirectory,
    );
    expect(sdkCalls[0]!.options?.workingDirectory).toContain(crab.id);
    expect(sdkCalls[1]!.options?.workingDirectory).toContain(prawn.id);
  });

  it("forces the strictest sandbox for a sensitive-data agent in Talk too", async () => {
    const agent = await createAgent(`${RUN_TAG} Vaulted`, {
      securityPreset: "operator",
      autonomy: "autonomous",
    });
    await db
      .update(agentsTable)
      .set({ sensitiveDataSandbox: true })
      .where(eq(agentsTable.id, agent.id));
    turnScript = [talkTurn()];

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Anything secret?" });
    expect(res.status).toBe(200);
    expect(sdkCalls[0]!.options?.sandboxMode).toBe("read-only");
    expect(sdkCalls[0]!.options?.networkAccessEnabled).toBe(false);
    expect(sdkCalls[0]!.options?.webSearchMode).toBe("disabled");
  });

  it("completes a voice round-trip through the same Codex context", async () => {
    const agent = await createAgent(`${RUN_TAG} Voicer`, { voiceStyle: "deep" });
    mockSpeech("Status report please");
    turnScript = [talkTurn()];

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
    const body = res.body as unknown as string;
    expect(body).toContain('"type":"user_transcript"');
    expect(body).toContain("Status report please");
    expect(body).toContain('"type":"reply"');
    expect(body).toContain("Claws crossed, boss.");
    expect(sdkCalls).toHaveLength(1);
    expect(sdkCalls[0]!.options?.workingDirectory).toContain(agent.id);
  });

  it("returns a clear busy message when another run holds the ChatGPT credential", async () => {
    const agent = await createAgent(`${RUN_TAG} Queued`);
    setCodexTalkLeaseWait({ totalMs: 250, intervalMs: 100 });
    const fingerprint = await codexAuthFingerprint();
    await db.insert(providerLeasesTable).values({
      key: codexLeaseKey(fingerprint!),
      taskId: randomUUID(),
      holder: "another-process-entirely",
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Anyone home?" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/busy/i);
    expect(res.body.error).not.toMatch(/provider key/i);
    // The turn never reached Codex and never stole the lease.
    expect(sdkCalls).toHaveLength(0);
    const [lease] = await db
      .select()
      .from(providerLeasesTable)
      .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint!)));
    expect(lease?.holder).toBe("another-process-entirely");
  });

  it("waits briefly and proceeds once the credential frees up", async () => {
    const agent = await createAgent(`${RUN_TAG} Patient`);
    setCodexTalkLeaseWait({ totalMs: 2_000, intervalMs: 50 });
    const fingerprint = await codexAuthFingerprint();
    const key = codexLeaseKey(fingerprint!);
    await db.insert(providerLeasesTable).values({
      key,
      taskId: randomUUID(),
      holder: "short-lived-holder",
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    turnScript = [talkTurn()];
    // Free the lease shortly after the Talk turn starts waiting.
    // NOTE: drizzle queries are lazy thenables — without .then() the
    // delete would never execute and the wait would always time out.
    setTimeout(() => {
      db.delete(providerLeasesTable)
        .where(eq(providerLeasesTable.key, key))
        .then(
          () => {},
          () => {},
        );
    }, 150);

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Patiently waiting." });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Claws crossed, boss.");
  });

  it("maps an authentication failure to a ChatGPT-session message, not a missing key", async () => {
    const agent = await createAgent(`${RUN_TAG} Locked Out`);
    turnScript = [failingTurn("401 unauthorized: please run codex login")];

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Hello?" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ChatGPT session/i);
    expect(res.body.error).not.toMatch(/provider key/i);
  });

  it("maps an exhausted allowance to an allowance message", async () => {
    const agent = await createAgent(`${RUN_TAG} Broke`);
    turnScript = [failingTurn("You've hit your usage limit for the week")];

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "One more?" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/allowance/i);
    expect(res.body.error).not.toMatch(/provider key/i);
  });

  it("reports a missing sign-in as a setup problem instead of a missing key", async () => {
    const agent = await createAgent(`${RUN_TAG} Signed Out`);
    await disconnectCodexCredential(authState.userId);

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Hello?" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ChatGPT connection|Providers page/i);
    expect(res.body.error).not.toMatch(/provider key/i);
    expect(sdkCalls).toHaveLength(0);
  });

  it("reports a workspace-preparation failure as an internal problem", async () => {
    const agent = await createAgent(`${RUN_TAG} Homeless`);
    // Point the workspace root under a regular file so mkdir must fail.
    const blocker = path.join(workspaceRoot, `blocker-${Date.now()}`);
    await writeFile(blocker, "not a directory");
    vi.stubEnv("CODEX_WORKSPACE_ROOT", path.join(blocker, "sub"));

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Where do I live?" });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/workspace/i);
    expect(res.body.error).not.toMatch(/provider key/i);
    expect(sdkCalls).toHaveLength(0);
  });

  it("stores voice transcripts only when the existing setting allows it", async () => {
    const agent = await createAgent(`${RUN_TAG} Archivist`);
    const [prior] = await db
      .select()
      .from(workspaceSettingsTable)
      .where(
        and(
          eq(workspaceSettingsTable.workspaceId, wsId),
          eq(workspaceSettingsTable.key, "voice_transcripts_enabled"),
        ),
      )
      .limit(1);
    try {
      // Off: nothing stored.
      await db
        .insert(workspaceSettingsTable)
        .values({
          workspaceId: wsId,
          key: "voice_transcripts_enabled",
          value: "false",
        })
        .onConflictDoUpdate({
          target: [
            workspaceSettingsTable.workspaceId,
            workspaceSettingsTable.key,
          ],
          set: { value: "false" },
        });
      turnScript = [talkTurn()];
      let res = await request(app)
        .post(`/api/agents/${agent.id}/converse`)
        .send({ text: "Off the record." });
      expect(res.status).toBe(200);
      let rows = await db
        .select()
        .from(agentMessagesTable)
        .where(eq(agentMessagesTable.toAgentId, agent.id));
      expect(rows.filter((r) => r.kind === "voice")).toHaveLength(0);

      // On: both sides stored.
      await db
        .update(workspaceSettingsTable)
        .set({ value: "true" })
        .where(
          and(
            eq(workspaceSettingsTable.workspaceId, wsId),
            eq(workspaceSettingsTable.key, "voice_transcripts_enabled"),
          ),
        );
      turnScript = [talkTurn()];
      res = await request(app)
        .post(`/api/agents/${agent.id}/converse`)
        .send({ text: "On the record." });
      expect(res.status).toBe(200);
      rows = await db
        .select()
        .from(agentMessagesTable)
        .where(eq(agentMessagesTable.toAgentId, agent.id));
      expect(rows.some((r) => r.kind === "voice" && r.body === "On the record.")).toBe(true);
    } finally {
      if (prior) {
        await db
          .update(workspaceSettingsTable)
          .set({ value: prior.value })
          .where(
            and(
              eq(workspaceSettingsTable.workspaceId, wsId),
              eq(workspaceSettingsTable.key, "voice_transcripts_enabled"),
            ),
          );
      } else {
        await db
          .delete(workspaceSettingsTable)
          .where(
            and(
              eq(workspaceSettingsTable.workspaceId, wsId),
              eq(workspaceSettingsTable.key, "voice_transcripts_enabled"),
            ),
          );
      }
      await db
        .delete(agentMessagesTable)
        .where(eq(agentMessagesTable.toAgentId, agent.id));
      await db
        .delete(agentMessagesTable)
        .where(eq(agentMessagesTable.fromAgentId, agent.id));
    }
  });
});
