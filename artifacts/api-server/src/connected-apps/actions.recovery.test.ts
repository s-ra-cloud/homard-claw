/**
 * Crash-recovery coverage for approved external writes:
 *  - a stranded "executing" write whose idempotency marker is found at the
 *    provider is settled as executed — never re-sent
 *  - one the provider provably never received is re-queued and re-run
 *    exactly once, carrying the SAME idempotency marker
 *  - an inconclusive or failed verification settles as unknown-outcome and
 *    is never retried (the pre-verification behavior)
 *  - write executors embed the marker derived from the action row id
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md): all
 * provider traffic goes through a stubbed global fetch — never the network;
 * tag and clean up all created rows; the test agent stays paused so the
 * live queue worker ignores it; audit rows are append-only and accumulate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  appActionsTable,
  approvalsTable,
  db,
  githubAccountsTable,
  googleAccountsTable,
  pool,
  tasksTable,
  workspacesTable,
  type AppActionRecord,
} from "@workspace/db";
import { eq } from "drizzle-orm";

type ProxyCall = {
  connector: string;
  path: string;
  method: string;
  body: unknown;
};

const proxyState = vi.hoisted(() => ({
  calls: [] as {
    connector: string;
    path: string;
    method: string;
    body: unknown;
  }[],
  handler: null as
    | null
    | ((call: {
        connector: string;
        path: string;
        method: string;
        body: unknown;
      }) => { status: number; body: unknown }),
}));

// Every provider now talks over HTTPS as the workspace's own account.
// Route Gmail, Drive, and GitHub HTTP through the shared proxyState so one
// handler serves all providers; token refreshes are answered locally.
const realFetch = globalThis.fetch;
const PROVIDER_BASES: Record<string, string> = {
  "https://gmail.googleapis.com": "gmail",
  "https://www.googleapis.com": "google_drive",
  "https://api.github.com": "github",
};
vi.stubGlobal(
  "fetch",
  async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: "test-access", expires_in: 3600 }),
        { status: 200 },
      );
    }
    for (const [base, connector] of Object.entries(PROVIDER_BASES)) {
      if (!url.startsWith(base)) continue;
      const path = url.slice(base.length);
      let body: unknown;
      if (init?.body !== undefined) {
        try {
          body = JSON.parse(String(init.body));
        } catch {
          body = String(init.body); // raw media uploads stay verbatim
        }
      }
      const call = {
        connector,
        path,
        method: init?.method ?? "GET",
        body,
      };
      proxyState.calls.push(call);
      const res = proxyState.handler?.(call) ?? {
        status: 500,
        body: { error: "no handler installed" },
      };
      return new Response(
        typeof res.body === "string" ? res.body : JSON.stringify(res.body),
        { status: res.status },
      );
    }
    return realFetch(input, init);
  },
);

import {
  claimApprovedAction,
  executeClaimedAction,
  reconcileStaleExecutingActions,
} from "./actions";
import { executeOperation } from "./connections";
import { findOperation } from "./catalog";
import {
  clearGoogleTokenCache,
  encryptRefreshToken,
} from "../google/credentials";
import { encryptGithubToken } from "../github/credentials";

const RUN_TAG = `HC Recovery Test ${Date.now()}`;
let agentId: string;
let taskId: string;
let workspaceId: string;

function sendCalls(): ProxyCall[] {
  return proxyState.calls.filter(
    (c) => c.method === "POST" && c.path.includes("/messages/send"),
  );
}

async function insertApproval(): Promise<string> {
  const [row] = await db
    .insert(approvalsTable)
    .values({
      agentId,
      taskId,
      action: "app_action",
      details: RUN_TAG,
      status: "approved",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  return row.id;
}

/** Older than the eventual-consistency grace window, so absence is trusted. */
const OLD_ATTEMPT = () => new Date(Date.now() - 10 * 60 * 1000);

async function insertExecutingAction(input: {
  operation: string;
  app: string;
  params: Record<string, unknown>;
  approvalId?: string | null;
  /** Defaults to an attempt old enough for absence to be conclusive. */
  executingAt?: Date;
  recoveryRequeuedAt?: Date;
}): Promise<AppActionRecord> {
  const [row] = await db
    .insert(appActionsTable)
    .values({
      taskId,
      agentId,
      app: input.app,
      operation: input.operation,
      params: input.params,
      targetSummary: `${input.operation} ${RUN_TAG}`,
      status: "executing",
      approvalId: input.approvalId ?? null,
      decidedAt: new Date(),
      executingAt: input.executingAt ?? OLD_ATTEMPT(),
      recoveryRequeuedAt: input.recoveryRequeuedAt ?? null,
    })
    .returning();
  return row;
}

async function reloadAction(id: string): Promise<AppActionRecord> {
  const [row] = await db
    .select()
    .from(appActionsTable)
    .where(eq(appActionsTable.id, id));
  return row;
}

beforeAll(async () => {
  const [workspace] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `recovery-test-${Date.now()}` })
    .returning();
  workspaceId = workspace.id;
  await db.insert(googleAccountsTable).values({
    workspaceId,
    clerkUserId: workspace.clerkUserId,
    googleSub: "test-sub",
    email: "tester@example.com",
    refreshTokenEnc: encryptRefreshToken("test-refresh-token"),
    scopes:
      "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
  });
  await db.insert(githubAccountsTable).values({
    workspaceId,
    clerkUserId: workspace.clerkUserId,
    githubUserId: "12345",
    login: "recovery-tester",
    accessTokenEnc: encryptGithubToken("test-github-token"),
    scopes: "repo",
  });
  const [agent] = await db
    .insert(agentsTable)
    .values({
      workspaceId,
      name: RUN_TAG,
      title: "Recovery Tester",
      mission: "Exercise crash recovery of connected-app writes.",
      securityPreset: "assistant",
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
      paused: true, // the live queue worker must never pick this agent up
    })
    .returning();
  agentId = agent.id;
  const [task] = await db
    .insert(tasksTable)
    .values({
      agentId,
      workspaceId,
      objective: `Recovery fixture ${RUN_TAG}`,
      status: "cancelled", // inert: never claimable by the live worker
      provider: "claude_max",
    })
    .returning();
  taskId = task.id;
});

beforeEach(() => {
  proxyState.calls = [];
  proxyState.handler = null;
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  clearGoogleTokenCache();
});

afterAll(async () => {
  await db.delete(appActionsTable).where(eq(appActionsTable.taskId, taskId));
  await db.delete(approvalsTable).where(eq(approvalsTable.taskId, taskId));
  await db.delete(tasksTable).where(eq(tasksTable.id, taskId));
  await db.delete(agentsTable).where(eq(agentsTable.id, agentId));
  await db
    .delete(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId));
  vi.unstubAllGlobals();
  await pool.end();
});

describe("idempotency markers on write executors", () => {
  it("embeds a deterministic Message-ID in a sent email", async () => {
    proxyState.handler = () => ({ status: 200, body: { id: "msg-1" } });
    const op = findOperation("gmail.send_email");
    expect(op).not.toBeNull();
    const outcome = await executeOperation(
      op!,
      { to: "a@b.c", subject: "Hi", body: "Hello" },
      { actionId: "11111111-2222-3333-4444-555555555555", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    const raw = (sendCalls()[0].body as { raw: string }).raw;
    const message = Buffer.from(raw, "base64url").toString("utf8");
    expect(message).toContain(
      "Message-ID: <homardclaw-action-11111111-2222-3333-4444-555555555555@agents.homardclaw>",
    );
  });

  it("keeps the deterministic Message-ID on a formatted (HTML) send", async () => {
    proxyState.handler = () => ({ status: 200, body: { id: "msg-2" } });
    const op = findOperation("gmail.send_email");
    const outcome = await executeOperation(
      op!,
      {
        to: "a@b.c",
        subject: "Hi",
        body: "See https://example.com",
        bodyHtml: '<p>See <a href="https://example.com">our site</a></p><script>x()</script>',
      },
      { actionId: "66666666-7777-8888-9999-000000000000", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    const raw = (sendCalls()[0].body as { raw: string }).raw;
    const message = Buffer.from(raw, "base64url").toString("utf8");
    expect(message).toContain(
      "Message-ID: <homardclaw-action-66666666-7777-8888-9999-000000000000@agents.homardclaw>",
    );
    expect(message).toContain("multipart/alternative");
    expect(message).toContain("text/plain");
    expect(message).toContain("text/html");
    // Sanitized: the script never reaches the wire (parts are base64).
    const htmlPart = Buffer.from(
      message.split("text/html")[1]!.split("\r\n\r\n")[1]!.split("--")[0]!.replace(/\r\n/g, ""),
      "base64",
    ).toString("utf8");
    expect(htmlPart).toContain('<a href="https://example.com">our site</a>');
    expect(htmlPart).not.toContain("script");
  });

  it("embeds a hidden marker in a GitHub comment body", async () => {
    proxyState.handler = () => ({
      status: 200,
      body: { html_url: "https://github.com/x/y/issues/1#c1" },
    });
    const op = findOperation("github.comment_on_issue");
    const outcome = await executeOperation(
      op!,
      { owner: "x", repo: "y", issueNumber: 1, body: "LGTM" },
      { actionId: "aaaa", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    const body = (proxyState.calls[0].body as { body: string }).body;
    expect(body).toBe("LGTM\n\n<!-- homardclaw-action:aaaa -->");
  });
});

describe("drive reads by MIME type", () => {
  const readOp = () => findOperation("google_drive.read_file")!;
  const ctx = () => ({ actionId: null, workspaceId });

  /** Answer the metadata request with the given file, then the read. */
  function stubDriveFile(input: {
    mimeType: string;
    exportBody?: string;
    mediaBody?: string;
    readStatus?: number;
    readErrorBody?: unknown;
  }) {
    proxyState.handler = (call) => {
      if (call.path.includes("fields=")) {
        return {
          status: 200,
          body: { id: "f1", name: "Budget", mimeType: input.mimeType },
        };
      }
      if (input.readStatus && input.readStatus !== 200) {
        return { status: input.readStatus, body: input.readErrorBody ?? { error: "nope" } };
      }
      return { status: 200, body: input.exportBody ?? input.mediaBody ?? "" };
    };
  }

  const driveCalls = () => proxyState.calls.filter((c) => c.connector === "google_drive");

  it("exports a Google Sheet as CSV and returns its rows", async () => {
    stubDriveFile({
      mimeType: "application/vnd.google-apps.spreadsheet",
      exportBody: "item,cost\nrent,1200\ncoffee,7",
    });
    const outcome = await executeOperation(readOp(), { fileId: "f1" }, ctx());
    expect(outcome.ok).toBe(true);
    const readCall = driveCalls()[1];
    expect(readCall.path).toContain("/export?mimeType=text%2Fcsv");
    expect(readCall.path).not.toContain("text%2Fplain");
    if (outcome.ok) {
      expect(outcome.summary).toContain('"Budget"');
      expect(outcome.summary).toContain("application/vnd.google-apps.spreadsheet");
      expect(outcome.summary).toContain("rent,1200");
      expect(outcome.summary).toContain("coffee,7");
    }
  });

  it("still exports a Google Doc as plain text", async () => {
    stubDriveFile({
      mimeType: "application/vnd.google-apps.document",
      exportBody: "Meeting notes",
    });
    const outcome = await executeOperation(readOp(), { fileId: "f1" }, ctx());
    expect(outcome.ok).toBe(true);
    expect(driveCalls()[1].path).toContain("/export?mimeType=text%2Fplain");
    if (outcome.ok) expect(outcome.summary).toContain("Meeting notes");
  });

  it("downloads an ordinary uploaded file as-is", async () => {
    stubDriveFile({ mimeType: "text/markdown", mediaBody: "# Readme" });
    const outcome = await executeOperation(readOp(), { fileId: "f1" }, ctx());
    expect(outcome.ok).toBe(true);
    expect(driveCalls()[1].path).toContain("alt=media");
    expect(driveCalls()[1].path).not.toContain("/export");
    if (outcome.ok) expect(outcome.summary).toContain("# Readme");
  });

  it("truncates an oversized spreadsheet export", async () => {
    stubDriveFile({
      mimeType: "application/vnd.google-apps.spreadsheet",
      exportBody: "col\n" + "x".repeat(10_000),
    });
    const outcome = await executeOperation(readOp(), { fileId: "f1" }, ctx());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.summary).toContain("[truncated]");
      expect(outcome.summary.length).toBeLessThan(6_000);
    }
  });

  it("surfaces a provider failure on the export as a failed outcome", async () => {
    stubDriveFile({
      mimeType: "application/vnd.google-apps.spreadsheet",
      readStatus: 500,
      readErrorBody: { error: "backend" },
    });
    const outcome = await executeOperation(readOp(), { fileId: "f1" }, ctx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("failed");
  });

  it("surfaces a revoked authorization as an auth outcome", async () => {
    stubDriveFile({
      mimeType: "application/vnd.google-apps.spreadsheet",
      readStatus: 403,
      readErrorBody: { error: "insufficient scope" },
    });
    const outcome = await executeOperation(readOp(), { fileId: "f1" }, ctx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("auth");
  });
});

describe("reconcileStaleExecutingActions", () => {
  it("confirms a stranded send the provider proves happened — without re-sending", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "gmail.send_email",
      app: "gmail",
      params: { to: "a@b.c", subject: "Crash", body: "Did I go out?" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("rfc822msgid")) {
        expect(decodeURIComponent(call.path)).toContain(
          `homardclaw-action-${action.id}@agents.homardclaw`,
        );
        return { status: 200, body: { messages: [{ id: "found-1" }] } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("confirmed");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("executed");
    expect(row.resultSummary).toContain("Confirmed");
    expect(sendCalls()).toHaveLength(0);
  });

  it("re-queues a verified-absent approved send and re-runs it exactly once", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "gmail.send_email",
      app: "gmail",
      params: { to: "a@b.c", subject: "Crash", body: "Never left" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("rfc822msgid")) {
        return { status: 200, body: {} }; // no messages: provably not sent
      }
      if (call.method === "POST" && call.path.includes("/messages/send")) {
        return { status: 200, body: { id: "sent-1" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("requeued");
    expect((await reloadAction(action.id)).status).toBe("approved");
    expect(sendCalls()).toHaveLength(0);

    // The normal approved path picks it back up: claim is the exactly-once
    // fence, and the retry carries the SAME Message-ID as the crashed run.
    // The re-queue is durably marked as the one recovery retry.
    expect((await reloadAction(action.id)).recoveryRequeuedAt).not.toBeNull();
    const claimed = await claimApprovedAction(action.id);
    expect(claimed).not.toBeNull();
    expect(claimed!.executingAt).not.toBeNull();
    expect(await claimApprovedAction(action.id)).toBeNull();
    const { action: finalized } = await executeClaimedAction(claimed!, "Tester", workspaceId);
    expect(finalized.status).toBe("executed");
    expect(sendCalls()).toHaveLength(1);
    const raw = (sendCalls()[0].body as { raw: string }).raw;
    expect(Buffer.from(raw, "base64url").toString("utf8")).toContain(
      `Message-ID: <homardclaw-action-${action.id}@agents.homardclaw>`,
    );
  });

  it("settles as unknown when the verification read itself fails, and never retries", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "gmail.send_email",
      app: "gmail",
      params: { to: "a@b.c", subject: "Crash", body: "???" },
      approvalId,
    });
    proxyState.handler = () => ({ status: 503, body: "provider down" });
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("outcome is unknown");
    expect(sendCalls()).toHaveLength(0);
  });

  it("treats a fresh absence from an eventually consistent index as unknown", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "gmail.send_email",
      app: "gmail",
      params: { to: "a@b.c", subject: "Crash", body: "Fresh" },
      approvalId,
      executingAt: new Date(), // interrupted seconds ago: index may lag
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("rfc822msgid")) {
        return { status: 200, body: {} };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("too recent");
    expect(sendCalls()).toHaveLength(0);
  });

  it("never re-queues the same action twice across repeated crashes", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "gmail.send_email",
      app: "gmail",
      params: { to: "a@b.c", subject: "Crash", body: "Twice?" },
      approvalId,
      recoveryRequeuedAt: OLD_ATTEMPT(), // already used its one recovery retry
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("rfc822msgid")) {
        return { status: 200, body: {} };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("already retried once");
    expect(sendCalls()).toHaveLength(0);
  });

  it("completes a Drive file left without content by an interrupted upload", async () => {
    const action = await insertExecutingAction({
      operation: "google_drive.create_file",
      app: "google_drive",
      params: { name: "notes.txt", content: "hello world" },
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("appProperties")) {
        return {
          status: 200,
          body: { files: [{ id: "f-1", name: "notes.txt", size: "0" }] },
        };
      }
      if (call.method === "PATCH" && call.path.includes("/upload/")) {
        expect(call.path).toContain("f-1");
        expect(call.body).toBe("hello world");
        return { status: 200, body: { id: "f-1" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("confirmed");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("executed");
    expect(row.resultSummary).toContain("completed during recovery");
    // Exactly one completion upload, no second file creation.
    expect(
      proxyState.calls.filter((c) => c.method === "PATCH"),
    ).toHaveLength(1);
    expect(proxyState.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("settles an unverifiable operation as unknown without any provider call", async () => {
    const action = await insertExecutingAction({
      operation: "gmail.create_draft",
      app: "gmail",
      params: { to: "a@b.c", subject: "Draft", body: "..." },
    });
    proxyState.handler = (call) => {
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    expect((await reloadAction(action.id)).status).toBe("failed");
    expect(proxyState.calls).toHaveLength(0);
  });

  it("records verified non-delivery for a stranded write without an approval", async () => {
    const action = await insertExecutingAction({
      operation: "google_drive.create_file",
      app: "google_drive",
      params: { name: "notes.txt", content: "hello" },
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("appProperties")) {
        expect(decodeURIComponent(call.path)).toContain(action.id);
        return { status: 200, body: { files: [] } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("not_executed");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("never went through");
    // Only the verification read hit the provider — nothing was created.
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("confirms a stranded GitHub issue by its hidden body marker", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.create_issue",
      app: "github",
      params: { owner: "x", repo: "y", title: "Bug", body: "It broke" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/issues?state=all")) {
        return {
          status: 200,
          body: [
            { number: 7, html_url: "u7", body: "unrelated" },
            {
              number: 8,
              html_url: "u8",
              body: `It broke\n\n<!-- homardclaw-action:${action.id} -->`,
            },
          ],
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("confirmed");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("executed");
    expect(row.resultSummary).toContain("#8");
  });
});
