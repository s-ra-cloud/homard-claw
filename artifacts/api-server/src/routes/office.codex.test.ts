import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  memoriesTable,
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
import { saveProviderCredential } from "../provider-credentials";
import { providerCredentialsTable } from "@workspace/db";
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
import { setMemoryRefreshTimeout } from "../memory-refresh";
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
let priorCredentialRows: (typeof providerCredentialsTable.$inferSelect)[] = [];

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
  /** Rejects the event stream after the scripted events were consumed. */
  throwsMidStream?: Error;
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
              if (turn.throwsMidStream) throw turn.throwsMidStream;
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
      // Mirrors production dispatch: the billing identity is snapshotted
      // onto the task at queue time.
      ownerClerkUserId: authState.userId,
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
  priorCredentialRows = await db
    .select()
    .from(providerCredentialsTable)
    .where(eq(providerCredentialsTable.workspaceId, wsId));
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
  // Provider credentials are workspace rows now, not env vars. They are
  // encrypted under the stubbed SESSION_SECRET above, which stays in force
  // for every test in this file; afterAll restores the original rows.
  await saveProviderCredential(wsId, "claude_max", "test-claude-token");
  await saveProviderCredential(wsId, "openrouter", "test-openrouter-key");
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
  const fingerprint = await codexAuthFingerprint(authState.userId);
  if (fingerprint) {
    await db
      .delete(providerLeasesTable)
      .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint)));
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  setCodexSdkLoader(null);
  // Restore the workspace's provider credential rows exactly as found.
  await db
    .delete(providerCredentialsTable)
    .where(eq(providerCredentialsTable.workspaceId, wsId));
  if (priorCredentialRows.length > 0) {
    await db.insert(providerCredentialsTable).values(priorCredentialRows);
  }
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
import { codexSandboxFor, runCodexTurn } from "../codex/execute";

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
    const state = await codexRuntimeState(authState.userId);
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
    const state = await codexRuntimeState(authState.userId);
    expect(state.authMode).toBe("api_key");
    expect(state.usesChatGptAllowance).toBe(false);
    expect(state.ready).toBe(false);
    expect(JSON.stringify(state)).not.toContain("sk-live-not-a-subscription");
  });

  it("treats an expired session as not ready without deleting it", async () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    await connectAuth({ ...CHATGPT_AUTH, last_refresh: old });
    const state = await codexRuntimeState(authState.userId);
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
    const state = await codexRuntimeState(authState.userId);
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
    expect((await codexRuntimeState(authState.userId)).authPresent).toBe(false);
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
    const state = await codexRuntimeState(authState.userId);
    expect(state.authPresent).toBe(false);
    expect(state.ready).toBe(false);
  });

  it("says to reconnect when the encryption key no longer matches", async () => {
    // Rotating SESSION_SECRET must surface as "reconnect Codex", never as
    // a run that quietly proceeds without a session.
    vi.stubEnv("SESSION_SECRET", "a-different-session-secret");
    const state = await codexRuntimeState(authState.userId);
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
    expect((await codexRuntimeState(authState.userId)).ready).toBe(true);

    // An API-key file is stored but never passed off as a subscription.
    const apiKey = await connectCodexCredential(
      authState.userId,
      JSON.stringify({ OPENAI_API_KEY: "sk-api-billing" }),
    );
    expect(apiKey.detail).toMatch(/api key/i);
    expect((await codexRuntimeState(authState.userId)).usesChatGptAllowance).toBe(false);
  });

  it("bootstrap never overwrites a session Codex has since refreshed", async () => {
    // Restoring the seed would roll the account back to a revoked token.
    vi.stubEnv("CODEX_AUTH_JSON", JSON.stringify({ auth_mode: "chatgpt" }));
    await connectAuth({
      ...CHATGPT_AUTH,
      tokens: { ...CHATGPT_AUTH.tokens, account_id: "refreshed" },
    });
    const outcome = await bootstrapCodexHome(authState.userId);
    expect(outcome.action).toBe("preserved");
    const { home } = await materializeCodexHome(authState.userId);
    const after = JSON.parse(
      await readFile(path.join(home, "auth.json"), "utf8"),
    );
    expect(after.tokens.account_id).toBe("refreshed");
  });

  it("reports Codex as unavailable rather than throwing when the flag is off", async () => {
    vi.stubEnv("CODEX_ENABLED", "");
    const outcome = await bootstrapCodexHome(authState.userId);
    expect(outcome.action).toBe("unavailable");
    const state = await codexRuntimeState(authState.userId);
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

  it("disconnects a Codex sign-in over HTTP instead of rejecting it as an unknown provider", async () => {
    // Regression: the generic `/providers/:provider/credential` route used
    // to be registered before the literal codex one, so this exact request
    // came back 400 "Unknown provider" in production.
    await connectAuth(CHATGPT_AUTH);
    const res = await request(app).delete("/api/providers/codex/credential");
    expect(res.status).toBe(200);
    expect(res.body.action).toBe("disconnected");

    // A second disconnect is a clean no-op, still never a routing 400.
    const again = await request(app).delete("/api/providers/codex/credential");
    expect(again.status).toBe(200);
    expect(again.body.action).toBe("skipped");
  });

  it("keeps generic provider credential routes working alongside the codex ones", async () => {
    // The reorder must not weaken the parameterized routes it now follows.
    for (const provider of ["claude_max", "openrouter"] as const) {
      const res = await request(app).delete(
        `/api/providers/${provider}/credential`,
      );
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe(provider);
    }
    const bogus = await request(app).delete("/api/providers/bogus/credential");
    expect(bogus.status).toBe(400);
    expect(bogus.body.error).toBe("Unknown provider");
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
    const fingerprint = (await codexAuthFingerprint(authState.userId))!;
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

    const fingerprint = (await codexAuthFingerprint(authState.userId))!;
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
    const fingerprint = (await codexAuthFingerprint(authState.userId))!;
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
    // Cancel only once the SDK turn is actually in flight. A fixed sleep
    // raced the worker's startup (workspace setup, lease acquisition, DB
    // writes) under a loaded suite: a cancel that lands before the abort
    // handle is registered has nothing to abort, so the hanging mock turn
    // waits forever and the test times out. The mock records the call the
    // moment runStreamed begins — which is strictly after the abort handle
    // exists — and it resolves immediately when the signal is already
    // aborted, so cancelling after this point is deterministic.
    const startedBy = Date.now() + 15_000;
    while (sdkCalls.length === 0) {
      if (Date.now() > startedBy) throw new Error("SDK turn never started");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await request(app).post(`/api/tasks/${task.id}/cancel`);
    await running;

    const row = await getTaskRow(task.id);
    expect(row.status).toBe("cancelled");
    // An interrupted turn is never recorded as completed.
    expect(row.status).not.toBe("completed");
    const fingerprint = (await codexAuthFingerprint(authState.userId))!;
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
    const fingerprint = (await codexAuthFingerprint(authState.userId))!;
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
    const fingerprint = (await codexAuthFingerprint(authState.userId))!;
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
    const fingerprint = (await codexAuthFingerprint(authState.userId))!;
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

  it("rebuilds scratch directories wiped by a restart before resuming a thread", async () => {
    const agent = await createAgent(`${RUN_TAG} Wiped`);
    turnScript = [successTurn("Before restart."), successTurn("After restart.")];

    const first = await insertTask(agent.id);
    await drainOne([agent.id]);
    const firstRow = await getTaskRow(first.id);
    expect(firstRow.status).toBe("completed");
    expect(firstRow.conversationId).toBeTruthy();
    const firstDir = sdkCalls.at(-1)!.options?.workingDirectory as string;
    expect(firstDir).toBeTruthy();

    // Simulate a restart wiping scratch storage: the conversation workspace
    // and the per-account Codex home both vanish, while the database rows
    // (conversation, thread id, encrypted credential) survive.
    await rm(firstDir, { recursive: true, force: true });
    await rm(codexHomeFor(authState.userId), { recursive: true, force: true });

    const second = await insertTask(agent.id, {
      conversationId: firstRow.conversationId,
    });
    await drainOne([agent.id]);
    const secondRow = await getTaskRow(second.id);
    expect(secondRow.status).toBe("completed");
    expect(secondRow.output).toContain("After restart");

    // The run resumed the original thread inside a recreated directory.
    const resumed = sdkCalls.at(-1)!;
    expect(resumed.kind).toBe("resume");
    expect(resumed.threadId).toBe(firstRow.providerThreadId);
    expect(resumed.options?.workingDirectory).toBe(firstDir);
    expect((await stat(firstDir)).isDirectory()).toBe(true);
    // The credential was re-materialized from the database into the
    // recreated private home, not lost with the wiped filesystem.
    expect((await stat(codexHomeFor(authState.userId))).isDirectory()).toBe(true);
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

  it("watches every account that connected a session, not just the owner", async () => {
    const second = `${authState.userId}-second`;
    try {
      // The owner disconnects; a different account's session must still be
      // monitored — there is no privileged "the" credential.
      await disconnectCodexCredential(authState.userId);
      expect(await runCodexHealthCheck()).toBe(false);
      resetCodexHealthCheck();
      await connectAuth(CHATGPT_AUTH, second);
      expect(await runCodexHealthCheck()).toBe(true);
    } finally {
      await disconnectCodexCredential(second);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Identity isolation across workspaces                                */
/* ------------------------------------------------------------------ */

describe("Codex identity isolation", () => {
  it("fails closed when no account can be resolved, rather than borrowing one", async () => {
    // No fallback identity: an anonymous runtime state is not ready…
    const anonymous = await codexRuntimeState();
    expect(anonymous.ready).toBe(false);
    expect(anonymous.clerkUserId).toBeNull();
    expect(anonymous.detail).toMatch(/no account/i);
    // …the lease key cannot be derived…
    expect(await codexAuthFingerprint()).toBeNull();
    // …and a turn with a missing identity is refused before anything runs.
    await expect(
      runCodexTurn({
        clerkUserId: "",
        system: "system",
        prompt: "prompt",
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        workingDirectory: workspaceRoot,
        threadId: null,
        sandbox: {
          sandboxMode: "read-only",
          networkAccessEnabled: false,
          webSearchMode: "disabled",
          approvalPolicy: "never",
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "not_configured" });
    expect(sdkCalls).toHaveLength(0);
  });

  it("only seeds CODEX_AUTH_JSON into the office owner's account", async () => {
    vi.stubEnv("CODEX_AUTH_JSON", JSON.stringify(CHATGPT_AUTH));
    const stranger = `${authState.userId}-second`;
    try {
      // A signed-in non-owner without a sign-in of their own is told to
      // paste one: the operator's seed is not theirs to spend.
      const outcome = await bootstrapCodexHome(stranger);
      expect(outcome.action).toBe("skipped");
      expect(outcome.detail).toMatch(/your own auth\.json/i);
      expect((await codexRuntimeState(stranger)).authPresent).toBe(false);

      // Nobody resolved at all: unavailable, nothing stored anywhere.
      expect((await bootstrapCodexHome()).action).toBe("unavailable");

      // The owner's empty account is exactly what the seed is for.
      await disconnectCodexCredential(authState.userId);
      const seeded = await bootstrapCodexHome(authState.userId);
      expect(seeded.action).toBe("connected");
      expect((await codexRuntimeState(authState.userId)).authPresent).toBe(true);
    } finally {
      await disconnectCodexCredential(stranger);
    }
  });

  it("runs a queued task on the credential of the workspace that queued it", async () => {
    const ownerId = authState.userId;
    const tenantB = `${ownerId}-second`;
    try {
      // Boot tenant B's own workspace and agent through the same HTTP
      // surface a real session uses; the workspace owner is resolved
      // server-side from the session, never from the request body.
      authState.userId = tenantB;
      const boot = await request(app).get("/api/agents");
      expect(boot.status).toBe(200);
      const agentB = await createAgent(`${RUN_TAG} Tenant B Runner`);
      await connectAuth(
        {
          ...CHATGPT_AUTH,
          tokens: { ...CHATGPT_AUTH.tokens, account_id: "acct_tenant_b" },
        },
        tenantB,
      );
      const [wsB] = await db
        .select({ id: workspacesTable.id })
        .from(workspacesTable)
        .where(eq(workspacesTable.clerkUserId, tenantB))
        .limit(1);
      expect(wsB).toBeDefined();

      // The owner's session is busy the whole time; that must not delay
      // tenant B by a single tick — the leases are per account.
      const ownerFingerprint = (await codexAuthFingerprint(ownerId))!;
      await db.insert(providerLeasesTable).values({
        key: codexLeaseKey(ownerFingerprint),
        taskId: randomUUID(),
        holder: "owner-task-still-running",
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      turnScript = [successTurn("Filed for tenant B.")];
      const task = await insertTask(agentB.id, { workspaceId: wsB!.id });
      expect(await drainOne([agentB.id])).toBe(true);
      const finished = await getTaskRow(task.id);
      expect(finished.status).toBe("completed");

      // The run materialized tenant B's own private home — never the
      // owner's — so it spent tenant B's allowance.
      expect(sdkCalls).toHaveLength(1);
      expect(sdkCalls[0]!.env?.CODEX_HOME).toBe(codexHomeFor(tenantB));
      expect(sdkCalls[0]!.env?.CODEX_HOME).not.toBe(codexHomeFor(ownerId));

      // Tenant B's lease was taken and released; the owner's untouched
      // lease still belongs to its own holder.
      const bFingerprint = (await codexAuthFingerprint(tenantB))!;
      expect(bFingerprint).not.toBe(ownerFingerprint);
      const bLeases = await db
        .select()
        .from(providerLeasesTable)
        .where(eq(providerLeasesTable.key, codexLeaseKey(bFingerprint)));
      expect(bLeases).toHaveLength(0);
      const [ownerLease] = await db
        .select()
        .from(providerLeasesTable)
        .where(eq(providerLeasesTable.key, codexLeaseKey(ownerFingerprint)));
      expect(ownerLease?.holder).toBe("owner-task-still-running");
    } finally {
      authState.userId = ownerId;
      await disconnectCodexCredential(tenantB);
      // Tenant B's workspace cascades its agents, tasks, conversations,
      // and settings away; the fixture leaves nothing behind.
      await db
        .delete(workspacesTable)
        .where(eq(workspacesTable.clerkUserId, tenantB));
    }
  });

  it("keeps billing the queuer after the workspace is handed to another account", async () => {
    const ownerId = authState.userId;
    const tenantB = `${ownerId}-second`;
    const handedTo = `${ownerId}-third`;
    let wsBId: string | null = null;
    try {
      // Tenant B queues work in their own workspace…
      authState.userId = tenantB;
      await request(app).get("/api/agents");
      const agentB = await createAgent(`${RUN_TAG} Handover Runner`);
      await connectAuth(
        {
          ...CHATGPT_AUTH,
          tokens: { ...CHATGPT_AUTH.tokens, account_id: "acct_tenant_b" },
        },
        tenantB,
      );
      const [wsB] = await db
        .select({ id: workspacesTable.id })
        .from(workspacesTable)
        .where(eq(workspacesTable.clerkUserId, tenantB))
        .limit(1);
      wsBId = wsB!.id;
      turnScript = [successTurn("Still tenant B's run.")];
      const task = await insertTask(agentB.id, {
        workspaceId: wsBId,
        // Queue-time snapshot, exactly as production dispatch stamps it.
        ownerClerkUserId: tenantB,
      });

      // …then the workspace changes hands before the queue drains.
      await db
        .update(workspacesTable)
        .set({ clerkUserId: handedTo })
        .where(eq(workspacesTable.id, wsBId));

      expect(await drainOne([agentB.id])).toBe(true);
      const finished = await getTaskRow(task.id);
      expect(finished.status).toBe("completed");

      // The run still billed the account that queued it — the snapshot —
      // not the workspace's new owner (who has no sign-in at all).
      expect(sdkCalls).toHaveLength(1);
      expect(sdkCalls[0]!.env?.CODEX_HOME).toBe(codexHomeFor(tenantB));
      expect(sdkCalls[0]!.env?.CODEX_HOME).not.toBe(codexHomeFor(handedTo));
    } finally {
      authState.userId = ownerId;
      await disconnectCodexCredential(tenantB);
      if (wsBId) {
        await db.delete(workspacesTable).where(eq(workspacesTable.id, wsBId));
      }
    }
  });

  it("serializes enqueue with a hand-over so a fresh task cannot carry a stale owner", async () => {
    const ownerId = authState.userId;
    const handedTo = `${ownerId}-second`;
    const agent = await createAgent(`${RUN_TAG} Enqueue Race`);
    const client = await pool.connect();
    let committed = false;
    try {
      // A workspace hand-over is in flight, holding the row lock…
      await client.query("BEGIN");
      await client.query(
        "UPDATE workspaces SET clerk_user_id = $1 WHERE id = $2",
        [handedTo, wsId],
      );
      // …while a task is queued through the real dispatch route. Its
      // snapshot read locks the same row, so it must wait for the
      // hand-over to finish instead of reading the pre-hand-over owner.
      const pending = request(app)
        .post("/api/tasks")
        .send({ agentId: agent.id, objective: `${RUN_TAG} race objective` })
        .then((res) => res);
      const first = await Promise.race([
        pending.then(() => "created" as const),
        new Promise<"waiting">((r) => setTimeout(() => r("waiting"), 400)),
      ]);
      expect(first).toBe("waiting");

      await client.query("COMMIT");
      committed = true;
      const res = await pending;
      expect(res.status).toBe(201);
      const row = await getTaskRow(res.body.id);
      // The snapshot is the owner at enqueue commit — never the stale one.
      expect(row.ownerClerkUserId).toBe(handedTo);
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
      // Undo the hand-over: this is the shared fixture workspace.
      await db
        .update(workspacesTable)
        .set({ clerkUserId: ownerId })
        .where(eq(workspacesTable.id, wsId));
    }
  });

  it("refuses a legacy queued task that carries no owner snapshot", async () => {
    const agent = await createAgent(`${RUN_TAG} Legacy Row`);
    // A row queued before per-account billing existed: workspace known,
    // billing identity not recorded. Guessing (e.g. from the workspace's
    // current owner) could bill an account that never queued it.
    const task = await insertTask(agent.id, { ownerClerkUserId: null });
    expect(await drainOne([agent.id])).toBe(true);
    const finished = await getTaskRow(task.id);
    expect(finished.status).not.toBe("completed");
    expect(finished.errorMessage ?? "").toMatch(/owner snapshot|re-create/i);
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

/** Route workspace-key speech traffic for voice-converse; everything else dies. */
async function mockSpeech(transcript: string): Promise<void> {
  await saveProviderCredential(wsId, "openai_voice", "test-openai-key");
  fetchMock.mockImplementation(async (url: unknown) => {
    const target = String(url);
    if (target.includes("/audio/transcriptions")) {
      return new Response(JSON.stringify({ text: transcript }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (target.includes("api.openai.com") && target.includes("/chat/completions")) {
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
    expect(call.input).toContain("Crustabot working in the Crustabox office");
    expect(call.input).toContain("How is the kelp doing?");

    // The lease is released the moment the turn ends.
    const fingerprint = await codexAuthFingerprint(authState.userId);
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

  it("recovers onto a fresh thread when the stored thread can no longer be resumed", async () => {
    // Regression: Codex session files live on scratch disk, so a deploy
    // restart wipes them while the conversation row (and its thread id)
    // survive. Talk always resumed that stale thread, failed instantly,
    // and reported a generic provider error forever.
    const agent = await createAgent(`${RUN_TAG} Restarted`);
    turnScript = [talkTurn()];
    const first = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Before the deploy." });
    expect(first.status).toBe(200);
    const beforeRows = await talkConversationRows(agent.id);
    expect(beforeRows).toHaveLength(1);
    const staleId = beforeRows[0]!.id;

    turnScript = [
      // The provider streams back a terminal error before the turn ever
      // starts — protocol-level proof that nothing ran and no allowance
      // was spent, which is what the automatic replay requires.
      {
        events: [
          { type: "error", message: "The session rollout file was not found on disk." },
        ],
      },
      talkTurn(),
    ];
    const second = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "After the deploy." });
    expect(second.status).toBe(200);
    expect(second.body.reply).toBe("Claws crossed, boss.");

    // The failed resume was followed by one fresh start — never a third try.
    expect(sdkCalls).toHaveLength(3);
    expect(sdkCalls[1]!.kind).toBe("resume");
    expect(sdkCalls[2]!.kind).toBe("start");

    // The broken conversation can never be picked again; the new one is.
    const rows = await talkConversationRows(agent.id);
    expect(rows).toHaveLength(2);
    const stale = rows.find((row) => row.id === staleId)!;
    expect(stale.resumable).toBe(false);
    const fresh = rows.find((row) => row.id !== staleId)!;
    expect(fresh.resumable).toBe(true);
    expect(fresh.threadId).toMatch(/^thr_/);
  });

  it("recovers onto a fresh thread on the exact production missing-rollout error", async () => {
    // Regression for the exact production failure: George's Talk requests
    // returned 503 forever because the classifier matched neither
    // "no rollout found" nor "thread/resume failed", so the dead thread
    // was never retired.
    const production =
      "thread/resume failed: no rollout found for thread id 0199a7f2-1c2b-7d3e-9a4f-5b6c7d8e9f01 (code -32600)";
    const george = await createAgent(`${RUN_TAG} George`);
    const jeanPierre = await createAgent(`${RUN_TAG} JeanPierre`);
    turnScript = [talkTurn(), talkTurn()];
    expect(
      (
        await request(app)
          .post(`/api/agents/${george.id}/converse`)
          .send({ text: "Warm up George." })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/api/agents/${jeanPierre.id}/converse`)
          .send({ text: "Warm up Jean-Pierre." })
      ).status,
    ).toBe(200);
    const georgeBefore = await talkConversationRows(george.id);
    const staleId = georgeBefore[0]!.id;

    // The provider reports the failure before turn.started — proof no
    // allowance was spent — so this very turn replays on a fresh thread.
    turnScript = [
      { events: [{ type: "error", message: production }] },
      talkTurn(),
    ];
    const second = await request(app)
      .post(`/api/agents/${george.id}/converse`)
      .send({ text: "After the rollout vanished." });
    expect(second.status).toBe(200);
    expect(sdkCalls).toHaveLength(4);
    expect(sdkCalls[2]!.kind).toBe("resume");
    expect(sdkCalls[3]!.kind).toBe("start");

    // Only George's stale conversation was retired; the fresh one resumes.
    const georgeRows = await talkConversationRows(george.id);
    expect(georgeRows).toHaveLength(2);
    expect(georgeRows.find((row) => row.id === staleId)!.resumable).toBe(false);
    const fresh = georgeRows.find((row) => row.id !== staleId)!;
    expect(fresh.resumable).toBe(true);
    expect(fresh.threadId).toMatch(/^thr_/);

    // Jean-Pierre's conversation is untouched and still resumable.
    const jpRows = await talkConversationRows(jeanPierre.id);
    expect(jpRows).toHaveLength(1);
    expect(jpRows[0]!.resumable).toBe(true);

    // The next turn resumes George's fresh thread, not another new one.
    turnScript = [talkTurn()];
    const third = await request(app)
      .post(`/api/agents/${george.id}/converse`)
      .send({ text: "Carry on." });
    expect(third.status).toBe(200);
    expect(sdkCalls[4]!.kind).toBe("resume");
    expect(sdkCalls[4]!.threadId).toBe(fresh.threadId);
  });

  it("recovers in the same turn when the production missing-rollout error arrives as a promise rejection", async () => {
    // Regression for the second production failure mode: the CLI process
    // exits echoing the server's own `thread/resume ... no rollout found`
    // rejection, so runStreamed() rejects instead of streaming an error
    // event. That full signature is server-confirmed proof the turn never
    // began, so this very turn must replay on a fresh thread — no manual
    // resend.
    const production =
      "thread/resume failed: no rollout found for thread id 0199a7f2-1c2b-7d3e-9a4f-5b6c7d8e9f01 (code -32600)";
    const agent = await createAgent(`${RUN_TAG} GeorgeRejected`);
    turnScript = [talkTurn()];
    expect(
      (
        await request(app)
          .post(`/api/agents/${agent.id}/converse`)
          .send({ text: "Warm up." })
      ).status,
    ).toBe(200);
    const staleId = (await talkConversationRows(agent.id))[0]!.id;

    turnScript = [{ events: [], throws: new Error(production) }, talkTurn()];
    const second = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Rollout gone, via rejection." });
    expect(second.status).toBe(200);
    expect(second.body.reply).toBe("Claws crossed, boss.");
    // Exactly one automatic replay: failed resume, then one fresh start.
    expect(sdkCalls).toHaveLength(3);
    expect(sdkCalls[1]!.kind).toBe("resume");
    expect(sdkCalls[2]!.kind).toBe("start");

    // The dead thread was retired and the fresh one is what resumes next.
    const rows = await talkConversationRows(agent.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === staleId)!.resumable).toBe(false);
    const fresh = rows.find((row) => row.id !== staleId)!;
    expect(fresh.resumable).toBe(true);

    turnScript = [talkTurn()];
    const third = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Carry on." });
    expect(third.status).toBe(200);
    expect(sdkCalls[3]!.kind).toBe("resume");
    expect(sdkCalls[3]!.threadId).toBe(fresh.threadId);
  });

  it("never replays a post-start rejection carrying the exact missing-rollout message", async () => {
    // Adversarial: the stream saw turn.started, then the promise rejects
    // with the exact production signature. The observed start outranks the
    // message — the turn may have been charged, so it must fail closed.
    const production =
      "thread/resume failed: no rollout found for thread id 0199a7f2-1c2b-7d3e-9a4f-5b6c7d8e9f01 (code -32600)";
    const agent = await createAgent(`${RUN_TAG} GeorgeStartedThenRejected`);
    turnScript = [talkTurn()];
    expect(
      (
        await request(app)
          .post(`/api/agents/${agent.id}/converse`)
          .send({ text: "Warm up." })
      ).status,
    ).toBe(200);

    turnScript = [
      {
        events: [{ type: "turn.started" }],
        throwsMidStream: new Error(production),
      },
    ];
    const second = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Started, then rejected." });
    expect(second.status).toBe(503);
    // No automatic replay, and the thread is not retired: the turn ran.
    expect(sdkCalls).toHaveLength(2);
    const rows = await talkConversationRows(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resumable).toBe(true);
  });

  it("never replays the missing-rollout message once the turn has started", async () => {
    // Even the exact production message must fail closed when it arrives
    // after turn.started — the provider may have charged the turn.
    const production =
      "thread/resume failed: no rollout found for thread id 0199a7f2-1c2b-7d3e-9a4f-5b6c7d8e9f01 (code -32600)";
    const agent = await createAgent(`${RUN_TAG} GeorgePostStart`);
    turnScript = [talkTurn()];
    expect(
      (
        await request(app)
          .post(`/api/agents/${agent.id}/converse`)
          .send({ text: "Warm up." })
      ).status,
    ).toBe(200);

    turnScript = [failingTurn(production)];
    const second = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Post-start failure." });
    expect(second.status).toBe(503);
    expect(sdkCalls).toHaveLength(2);
    // The thread is not retired: the turn ran, so the thread may be fine.
    const rows = await talkConversationRows(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resumable).toBe(true);
  });

  it("fails closed on a resume-shaped promise rejection but retires the thread so the resend recovers", async () => {
    // A rejected runStreamed() promise proves nothing about remote
    // execution — the request may have been accepted (and charged) before
    // the client-side failure. The turn must NOT be replayed automatically;
    // instead the suspect thread is retired so the owner's resend starts
    // fresh.
    const agent = await createAgent(`${RUN_TAG} Rejected`);
    turnScript = [talkTurn()];
    const first = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Warm up the thread." });
    expect(first.status).toBe(200);

    turnScript = [
      { events: [], throws: new Error("The session rollout file was not found on disk.") },
    ];
    const second = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "After a wipe, via rejection." });
    expect(second.status).toBe(503);
    // No automatic fresh-thread call happened.
    expect(sdkCalls).toHaveLength(2);
    // But the suspect thread was retired...
    const rows = await talkConversationRows(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resumable).toBe(false);

    // ...so the owner's resend recovers on a fresh thread.
    turnScript = [talkTurn()];
    const third = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Resend after the failure." });
    expect(third.status).toBe(200);
    expect(sdkCalls).toHaveLength(3);
    expect(sdkCalls[2]!.kind).toBe("start");
  });

  it("never replays a failure that happened after the turn started, even when its message mentions the session", async () => {
    // Adversarial case: the message matches every resume-failure hint, but
    // the turn had already started — the provider may have charged it, so
    // replaying it could double-spend the plan allowance.
    const agent = await createAgent(`${RUN_TAG} Ambiguous`);
    turnScript = [talkTurn()];
    const first = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Warm up the thread." });
    expect(first.status).toBe(200);

    turnScript = [failingTurn("Unable to process conversation session: state not found.")];
    const second = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Ambiguous failure." });
    expect(second.status).toBe(503);
    expect(sdkCalls).toHaveLength(2);
    const rows = await talkConversationRows(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resumable).toBe(true);
  });

  it("does not retry a real provider failure on a fresh thread", async () => {
    const agent = await createAgent(`${RUN_TAG} RealFailure`);
    turnScript = [talkTurn()];
    const first = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Warm up the thread." });
    expect(first.status).toBe(200);

    // A genuine model failure on a resumed thread must not be replayed —
    // the call ran, so a retry could double-spend the plan allowance.
    turnScript = [failingTurn("The model returned malformed output.")];
    const second = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "This one fails for real." });
    expect(second.status).toBe(503);
    expect(second.body.error).toMatch(/Codex provider error/i);
    expect(sdkCalls).toHaveLength(2);

    // The conversation stays resumable: the thread itself is fine.
    const rows = await talkConversationRows(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resumable).toBe(true);
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
    await mockSpeech("Status report please");
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
    const fingerprint = await codexAuthFingerprint(authState.userId);
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
    const fingerprint = await codexAuthFingerprint(authState.userId);
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

  it("maps rate limiting to a try-again-shortly message", async () => {
    const agent = await createAgent(`${RUN_TAG} Throttled`);
    turnScript = [failingTurn("429 Too Many Requests, please slow down.")];

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Quick one?" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/rate-limit error/i);
    expect(res.body.error).not.toMatch(/429|Too Many Requests/);
  });

  it("never leaks raw provider detail on an unknown Codex failure", async () => {
    const agent = await createAgent(`${RUN_TAG} Exploded`);
    turnScript = [
      failingTurn(
        "ECONNRESET at /home/runner/.codex/auth.json token=sk-secret-999",
      ),
    ];

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Still there?" });
    expect(res.status).toBe(503);
    // A fixed, sanitized message — none of the raw path/token detail.
    expect(res.body.error).toMatch(/Codex provider error/i);
    expect(res.body.error).not.toMatch(/ECONNRESET|auth\.json|sk-secret/);
  });

  it("sends the sanitized Codex failure over the voice SSE stream too", async () => {
    const agent = await createAgent(`${RUN_TAG} Voicefail`);
    await mockSpeech("Anything new?");
    turnScript = [
      failingTurn("401 unauthorized: token=sk-live-123 run codex login"),
    ];

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
    expect(body).toContain('"type":"error"');
    expect(body).toMatch(/ChatGPT session/i);
    expect(body).not.toContain("sk-live-123");
    expect(body).not.toContain("codex login");
  });

  it("reports a missing sign-in as a setup problem instead of a missing key", async () => {
    const agent = await createAgent(`${RUN_TAG} Signed Out`);
    await disconnectCodexCredential(authState.userId);

    const res = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Hello?" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/reconnect ChatGPT|Providers/i);
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
      // Typed Talk exchanges are chat history and persist regardless of the
      // voice-transcript privacy setting (only spoken turns are gated).
      let rows = await db
        .select()
        .from(agentMessagesTable)
        .where(eq(agentMessagesTable.toAgentId, agent.id));
      expect(rows.filter((r) => r.kind === "voice" && r.body === "Off the record.")).toHaveLength(1);

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

describe("manual memory refresh through Codex", () => {
  afterEach(async () => {
    setCodexTalkLeaseWait(null);
    setMemoryRefreshTimeout(null);
    if (createdAgentIds.length > 0) {
      await db
        .delete(memoriesTable)
        .where(inArray(memoriesTable.agentId, createdAgentIds));
    }
  });

  async function seedMemory(
    agentId: string,
    content: string,
    extra: Partial<typeof memoriesTable.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(memoriesTable)
      .values({ workspaceId: wsId, agentId, kind: "fact", content, ...extra })
      .returning();
    return row!;
  }

  async function memoryContents(agentId: string): Promise<string[]> {
    const rows = await db
      .select({ content: memoriesTable.content })
      .from(memoriesTable)
      .where(eq(memoriesTable.agentId, agentId));
    return rows.map((row) => row.content).sort();
  }

  /** Conversations and workspace folders left behind for one agent. */
  async function leftovers(agentId: string) {
    const conversations = await db
      .select()
      .from(providerConversationsTable)
      .where(eq(providerConversationsTable.agentId, agentId));
    const dirs = await readdir(path.join(workspaceRoot, agentId)).catch(
      () => [] as string[],
    );
    return { conversations, dirs };
  }

  it("runs ephemerally: repeated refreshes accumulate no conversations or work folders", async () => {
    const agent = await createAgent(`${RUN_TAG} Memory Groomer`);
    turnScript = [
      successTurn('{"add":[],"update":[],"remove":[]}'),
      successTurn('{"add":[],"update":[],"remove":[]}'),
    ];

    for (let round = 0; round < 2; round++) {
      const res = await request(app).post(
        `/api/agents/${agent.id}/memory/refresh`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("no_changes");
    }
    // Both reviews really went through the scripted Codex SDK…
    expect(sdkCalls).toHaveLength(2);
    // …under the forced maintenance sandbox: read-only and offline, even
    // though this agent's own settings (assistant preset, autonomous, no
    // sensitive-data flag) would normally allow workspace writes.
    for (const call of sdkCalls) {
      expect(call.options?.sandboxMode).toBe("read-only");
      expect(call.options?.networkAccessEnabled).toBe(false);
    }
    // …yet neither left a provider conversation row or a work folder.
    const afterSuccess = await leftovers(agent.id);
    expect(afterSuccess.conversations).toHaveLength(0);
    expect(afterSuccess.dirs).toEqual([]);

    // A failed review (unusable reply) must clean up just the same.
    turnScript = [successTurn("All memories look great to me, no JSON needed.")];
    const bad = await request(app).post(
      `/api/agents/${agent.id}/memory/refresh`,
    );
    expect(bad.status).toBe(502);
    const afterFailure = await leftovers(agent.id);
    expect(afterFailure.conversations).toHaveLength(0);
    expect(afterFailure.dirs).toEqual([]);
  });

  it("leaves no conversation row behind when workspace setup itself fails", async () => {
    const agent = await createAgent(`${RUN_TAG} Groomer Blocked`);
    // A regular file where a directory must go makes every mkdir under it
    // fail — the same trick the workspace-preparation tests use — so the
    // conversation row is created but its directory never materializes.
    const blocker = path.join(workspaceRoot, `refresh-blocker-${Date.now()}`);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(blocker, "not a directory");
    vi.stubEnv("CODEX_WORKSPACE_ROOT", path.join(blocker, "sub"));
    try {
      const res = await request(app).post(
        `/api/agents/${agent.id}/memory/refresh`,
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      const rows = await db
        .select()
        .from(providerConversationsTable)
        .where(eq(providerConversationsTable.agentId, agent.id));
      expect(rows).toHaveLength(0);
    } finally {
      vi.stubEnv("CODEX_WORKSPACE_ROOT", workspaceRoot);
      await rm(blocker, { force: true });
    }
  });

  it("applies a validated patch through the owner's ChatGPT session without a task or fallback", async () => {
    const agent = await createAgent(`${RUN_TAG} Groomer Prime`);
    // A real Talk exchange first, so the refresh has a resumable thread it
    // could wrongly resume — or wrongly destroy.
    turnScript = [talkTurn()];
    const talk = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({ text: "Warm up the thread." });
    expect(talk.status).toBe(200);
    const [talkRow] = await talkConversationRows(agent.id);
    expect(talkRow).toBeDefined();

    const stale = await seedMemory(
      agent.id,
      `${RUN_TAG} the deploy pipeline still uses Jenkins`,
    );
    const obsolete = await seedMemory(
      agent.id,
      `${RUN_TAG} duplicate stale note`,
    );
    const pinnedRow = await seedMemory(
      agent.id,
      `${RUN_TAG} owner decision: reports ship on Fridays`,
      { kind: "decision", pinned: true },
    );

    fetchMock.mockClear();
    const addedContent = `${RUN_TAG} the deploy pipeline moved to GitHub Actions`;
    const updatedContent = `${RUN_TAG} Jenkins was retired in 2026`;
    turnScript = [
      successTurn(
        JSON.stringify({
          add: [{ kind: "fact", content: addedContent }],
          update: [{ id: stale.id, content: updatedContent }],
          remove: [{ id: obsolete.id }],
        }),
      ),
    ];
    const res = await request(app).post(
      `/api/agents/${agent.id}/memory/refresh`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      agentId: agent.id,
      agentName: agent.name,
      status: "updated",
      added: 1,
      updated: 1,
      removed: 1,
    });

    // The memory bank now matches the patch exactly; the pin is untouched.
    expect(await memoryContents(agent.id)).toEqual(
      [addedContent, updatedContent, pinnedRow.content].sort(),
    );

    // The review ran as one brand-new Codex turn — never resuming the Talk
    // thread — under the forced maintenance sandbox, in its own work folder.
    expect(sdkCalls).toHaveLength(2);
    const call = sdkCalls[1]!;
    expect(call.kind).toBe("start");
    expect(call.options?.sandboxMode).toBe("read-only");
    expect(call.options?.networkAccessEnabled).toBe(false);
    expect(call.options?.webSearchMode).toBe("disabled");
    expect(call.input).toContain(stale.id);
    expect(call.options?.workingDirectory).not.toBe(
      sdkCalls[0]!.options?.workingDirectory,
    );

    // The Talk conversation survives, still resumable; the ephemeral
    // review conversation is gone.
    const convs = await talkConversationRows(agent.id);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.id).toBe(talkRow!.id);
    expect(convs[0]!.resumable).toBe(true);

    // No ordinary task was created and no metered provider was touched.
    const tasks = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.agentId, agent.id));
    expect(tasks).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    // The ChatGPT credential lease is free again.
    const fingerprint = await codexAuthFingerprint(authState.userId);
    const leases = await db
      .select()
      .from(providerLeasesTable)
      .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint!)));
    expect(leases).toHaveLength(0);
  });

  it("accepts a patch wrapped in a lone markdown fence", async () => {
    // Codex models habitually fence JSON despite the no-fences instruction;
    // a fence around the object (and nothing else) must not fail the review.
    const agent = await createAgent(`${RUN_TAG} Fencer`);
    const doomed = await seedMemory(agent.id, `${RUN_TAG} fenced removal target`);
    turnScript = [
      successTurn(
        "```json\n" +
          JSON.stringify({ add: [], update: [], remove: [{ id: doomed.id }] }) +
          "\n```",
      ),
    ];
    const res = await request(app).post(
      `/api/agents/${agent.id}/memory/refresh`,
    );
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
    expect(await memoryContents(agent.id)).toEqual([]);
  });

  it("rejects prose around the JSON and changes nothing", async () => {
    const agent = await createAgent(`${RUN_TAG} Chatty`);
    const kept = await seedMemory(agent.id, `${RUN_TAG} must survive prose reply`);
    turnScript = [
      successTurn(
        `Certainly! Here is the patch: {"add":[],"update":[],"remove":[{"id":"${kept.id}"}]}`,
      ),
    ];
    const res = await request(app).post(
      `/api/agents/${agent.id}/memory/refresh`,
    );
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unusable memory review/i);
    expect(res.body.error).toMatch(/nothing was changed/i);
    expect(await memoryContents(agent.id)).toEqual([kept.content]);
  });

  it("reports a missing ChatGPT sign-in as a setup problem, not a generic failure", async () => {
    const agent = await createAgent(`${RUN_TAG} Groomer Signed Out`);
    const kept = await seedMemory(agent.id, `${RUN_TAG} survives signed-out refresh`);
    await disconnectCodexCredential(authState.userId);
    fetchMock.mockClear();

    const res = await request(app).post(
      `/api/agents/${agent.id}/memory/refresh`,
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/reconnect ChatGPT|Providers/i);
    expect(res.body.error).not.toMatch(/provider key|try again/i);
    // Codex was never reached and no metered provider stepped in.
    expect(sdkCalls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await memoryContents(agent.id)).toEqual([kept.content]);
  });

  it("maps a ChatGPT authentication failure to an actionable 422", async () => {
    const agent = await createAgent(`${RUN_TAG} Groomer Locked Out`);
    const kept = await seedMemory(agent.id, `${RUN_TAG} survives auth failure`);
    turnScript = [failingTurn("401 unauthorized: please run codex login")];

    const res = await request(app).post(
      `/api/agents/${agent.id}/memory/refresh`,
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/ChatGPT session/i);
    // Sanitized: the raw CLI hint never reaches the browser.
    expect(res.body.error).not.toMatch(/codex login|401/);
    expect(await memoryContents(agent.id)).toEqual([kept.content]);
  });

  it("returns a clear busy message when another run holds the ChatGPT credential", async () => {
    const agent = await createAgent(`${RUN_TAG} Groomer Queued`);
    const kept = await seedMemory(agent.id, `${RUN_TAG} survives busy session`);
    setCodexTalkLeaseWait({ totalMs: 250, intervalMs: 100 });
    const fingerprint = await codexAuthFingerprint(authState.userId);
    await db.insert(providerLeasesTable).values({
      key: codexLeaseKey(fingerprint!),
      taskId: randomUUID(),
      holder: "another-process-entirely",
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(app).post(
      `/api/agents/${agent.id}/memory/refresh`,
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/busy/i);
    // The review never reached Codex and never stole the lease.
    expect(sdkCalls).toHaveLength(0);
    const [lease] = await db
      .select()
      .from(providerLeasesTable)
      .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint!)));
    expect(lease?.holder).toBe("another-process-entirely");
    expect(await memoryContents(agent.id)).toEqual([kept.content]);
  });

  it("maps an exhausted plan allowance to a 429", async () => {
    const agent = await createAgent(`${RUN_TAG} Groomer Broke`);
    const kept = await seedMemory(agent.id, `${RUN_TAG} survives allowance stop`);
    fetchMock.mockClear();
    turnScript = [failingTurn("You've hit your usage limit for the week")];

    const res = await request(app).post(
      `/api/agents/${agent.id}/memory/refresh`,
    );
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/allowance/i);
    // Fail closed: exhausted allowance never silently bills a metered key.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await memoryContents(agent.id)).toEqual([kept.content]);
  });

  it("maps provider rate limiting to a 429 without raw provider text", async () => {
    const agent = await createAgent(`${RUN_TAG} Groomer Throttled`);
    turnScript = [failingTurn("429 Too Many Requests, please slow down.")];

    const res = await request(app).post(
      `/api/agents/${agent.id}/memory/refresh`,
    );
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/rate-limit/i);
    expect(res.body.error).not.toMatch(/Too Many Requests/);
  });

  it("aborts a hung Codex turn at the deadline and reports a retryable timeout", async () => {
    const agent = await createAgent(`${RUN_TAG} Groomer Stuck`);
    const kept = await seedMemory(agent.id, `${RUN_TAG} survives timeout`);
    setMemoryRefreshTimeout(400);
    turnScript = [{ events: [], hangUntilAborted: true }];

    const res = await request(app).post(
      `/api/agents/${agent.id}/memory/refresh`,
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/did not finish/i);
    expect(res.body.error).toMatch(/timed out/i);
    expect(await memoryContents(agent.id)).toEqual([kept.content]);

    // The aborted turn still cleaned up: no conversation row, no work
    // folder, no held lease.
    const after = await leftovers(agent.id);
    expect(after.conversations).toHaveLength(0);
    expect(after.dirs).toEqual([]);
    const fingerprint = await codexAuthFingerprint(authState.userId);
    const leases = await db
      .select()
      .from(providerLeasesTable)
      .where(eq(providerLeasesTable.key, codexLeaseKey(fingerprint!)));
    expect(leases).toHaveLength(0);
  });

  it("never leaks raw detail from an unknown Codex runtime failure", async () => {
    const agent = await createAgent(`${RUN_TAG} Groomer Exploded`);
    const kept = await seedMemory(agent.id, `${RUN_TAG} survives runtime failure`);
    fetchMock.mockClear();
    turnScript = [
      failingTurn(
        "ECONNRESET at /home/runner/.codex/auth.json token=sk-secret-999",
      ),
    ];

    const res = await request(app).post(
      `/api/agents/${agent.id}/memory/refresh`,
    );
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Codex provider error/i);
    expect(res.body.error).not.toMatch(/ECONNRESET|auth\.json|sk-secret/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await memoryContents(agent.id)).toEqual([kept.content]);
  });
});
