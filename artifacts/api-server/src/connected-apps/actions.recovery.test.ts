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
  "https://sheets.googleapis.com": "sheets",
  "https://docs.googleapis.com": "docs",
  "https://slides.googleapis.com": "slides",
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
import {
  APP_AUTH_PARK_ERROR_KIND,
  parkTaskForAppAuthRecovery,
  resumeTasksParkedForAppAuth,
} from "./auth-parked-tasks";
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
      "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive",
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

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("github code workflow executors", () => {
  const githubCalls = () =>
    proxyState.calls.filter((c) => c.connector === "github");

  it("lists branches with head SHAs and protection flags", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path === "/repos/x/y/branches?per_page=100") {
        return {
          status: 200,
          body: [
            { name: "main", commit: { sha: SHA_A }, protected: true },
            { name: "fix-1", commit: { sha: SHA_B } },
          ],
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("github.list_branches")!,
      { owner: "x", repo: "y" },
      { actionId: null, workspaceId },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.summary).toContain(`main @ ${SHA_A} (protected)`);
      expect(outcome.summary).toContain(`fix-1 @ ${SHA_B}`);
    }
  });

  it("lists a directory with blob SHAs at an explicit ref, and refuses files", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path === "/repos/x/y/contents/src?ref=fix-1") {
        return {
          status: 200,
          body: [
            { type: "dir", name: "lib" },
            { type: "file", name: "app.ts", sha: SHA_A, size: 120 },
          ],
        };
      }
      if (call.method === "GET" && call.path === "/repos/x/y/contents/src/app.ts") {
        return { status: 200, body: { type: "file", name: "app.ts" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const op = findOperation("github.list_directory")!;
    const outcome = await executeOperation(
      op,
      { owner: "x", repo: "y", path: "src", ref: "fix-1" },
      { actionId: null, workspaceId },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.summary).toContain("[dir] lib");
      expect(outcome.summary).toContain(`app.ts (120 bytes, blob ${SHA_A})`);
    }
    const onFile = await executeOperation(
      op,
      { owner: "x", repo: "y", path: "src/app.ts" },
      { actionId: null, workspaceId },
    );
    expect(onFile.ok).toBe(false);
    if (!onFile.ok) expect(onFile.message).toContain("file, not a directory");
  });

  it("rejects traversal paths and malformed refs without touching GitHub", async () => {
    const op = findOperation("github.list_directory")!;
    for (const params of [
      { owner: "x", repo: "y", path: "../secrets" },
      { owner: "x", repo: "y", path: "/etc" },
      { owner: "x", repo: "y", path: "a//b" },
      { owner: "x", repo: "y", path: "ok", ref: "main@{1}" },
      { owner: "x", repo: "y", path: "ok", ref: "-option" },
    ]) {
      const outcome = await executeOperation(op, params, {
        actionId: null,
        workspaceId,
      });
      expect(outcome.ok).toBe(false);
    }
    const put = findOperation("github.put_file")!;
    const bad = await executeOperation(
      put,
      { owner: "x", repo: "y", branch: "refs/heads/x", path: "a.txt", content: "c", message: "m" },
      { actionId: null, workspaceId },
    );
    expect(bad.ok).toBe(false);
    expect(githubCalls()).toHaveLength(0);
  });

  it("describes a pull request's merge state for merge planning", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path === "/repos/x/y/pulls/7") {
        return {
          status: 200,
          body: {
            number: 7,
            title: "Fix crash",
            state: "open",
            merged: false,
            mergeable: false,
            mergeable_state: "dirty",
            head: { ref: "fix-1", sha: SHA_A },
            base: { ref: "main", sha: SHA_B },
            html_url: "https://github.com/x/y/pull/7",
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("github.get_pull_request")!,
      { owner: "x", repo: "y", pullNumber: 7 },
      { actionId: null, workspaceId },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.summary).toContain("NO (conflicts or blocked)");
      expect(outcome.summary).toContain("state: dirty");
      expect(outcome.summary).toContain(`head: fix-1 @ ${SHA_A}`);
    }
  });

  it("creates a branch at the resolved SHA of an explicit source ref", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path === "/repos/x/y/commits/main") {
        return { status: 200, body: { sha: SHA_A } };
      }
      if (call.method === "POST" && call.path === "/repos/x/y/git/refs") {
        expect(call.body).toEqual({ ref: "refs/heads/fix-1", sha: SHA_A });
        return { status: 201, body: { ref: "refs/heads/fix-1" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("github.create_branch")!,
      { owner: "x", repo: "y", branch: "fix-1", fromRef: "main" },
      { actionId: "cccc", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.summary).toContain(`at ${SHA_A}`);
  });

  it("fails branch creation cleanly when the source ref does not exist", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path === "/repos/x/y/commits/ghost") {
        return { status: 404, body: { message: "Not Found" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("github.create_branch")!,
      { owner: "x", repo: "y", branch: "fix-1", fromRef: "ghost" },
      { actionId: "cccc", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("No branch was created");
    expect(githubCalls().some((c) => c.method === "POST")).toBe(false);
  });

  it("commits a file with base64 content, expected blob SHA, and the action marker", async () => {
    proxyState.handler = (call) => {
      if (call.method === "PUT" && call.path === "/repos/x/y/contents/src/app.ts") {
        return {
          status: 200,
          body: { commit: { sha: SHA_B }, content: { sha: SHA_A } },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("github.put_file")!,
      {
        owner: "x",
        repo: "y",
        branch: "fix-1",
        path: "src/app.ts",
        content: "const a = 1;\n",
        message: "Fix crash",
        expectedSha: SHA_A,
      },
      { actionId: "dddd", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    const body = githubCalls()[0].body as {
      message: string;
      content: string;
      branch: string;
      sha?: string;
    };
    expect(body.branch).toBe("fix-1");
    expect(body.sha).toBe(SHA_A);
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe(
      "const a = 1;\n",
    );
    expect(body.message).toBe("Fix crash\n\n<!-- homardclaw-action:dddd -->");
    if (outcome.ok) expect(outcome.summary).toContain(`commit ${SHA_B}`);
  });

  it("fails a stale or conflicting file write without overwriting", async () => {
    proxyState.handler = () => ({
      status: 409,
      body: { message: "src/app.ts does not match" },
    });
    const outcome = await executeOperation(
      findOperation("github.put_file")!,
      {
        owner: "x",
        repo: "y",
        branch: "fix-1",
        path: "src/app.ts",
        content: "new",
        message: "Update",
        expectedSha: SHA_A,
      },
      { actionId: "dddd", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain("nothing was written");
      expect(outcome.message).toContain("stale");
    }
    // A malformed expectedSha never reaches the provider at all.
    proxyState.calls = [];
    const badSha = await executeOperation(
      findOperation("github.put_file")!,
      { owner: "x", repo: "y", branch: "b", path: "a.txt", content: "c", message: "m", expectedSha: "abc" },
      { actionId: null, workspaceId },
    );
    expect(badSha.ok).toBe(false);
    expect(githubCalls()).toHaveLength(0);
  });

  it("opens a pull request carrying the hidden action marker", async () => {
    proxyState.handler = (call) => {
      if (call.method === "POST" && call.path === "/repos/x/y/pulls") {
        return {
          status: 201,
          body: { number: 12, html_url: "https://github.com/x/y/pull/12", head: { sha: SHA_A } },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("github.open_pull_request")!,
      { owner: "x", repo: "y", title: "Fix crash", head: "fix-1", base: "main", body: "Details" },
      { actionId: "eeee", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    const body = githubCalls()[0].body as { title: string; head: string; base: string; body: string };
    expect(body.head).toBe("fix-1");
    expect(body.base).toBe("main");
    expect(body.body).toBe("Details\n\n<!-- homardclaw-action:eeee -->");
    if (outcome.ok) expect(outcome.summary).toContain("#12");
  });

  it("merges only at the reviewed head SHA and explains a moved branch", async () => {
    proxyState.handler = (call) => {
      if (call.method === "PUT" && call.path === "/repos/x/y/pulls/7/merge") {
        const body = call.body as { sha: string };
        if (body.sha === SHA_A) {
          return { status: 200, body: { merged: true, sha: SHA_B } };
        }
        return { status: 409, body: { message: "Head branch was modified" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const op = findOperation("github.merge_pull_request")!;
    const merged = await executeOperation(
      op,
      { owner: "x", repo: "y", pullNumber: 7, expectedHeadSha: SHA_A },
      { actionId: "ffff", workspaceId },
    );
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(merged.summary).toContain(`merge commit ${SHA_B}`);
    expect((githubCalls()[0].body as { merge_method: string }).merge_method).toBe("merge");

    const moved = await executeOperation(
      op,
      { owner: "x", repo: "y", pullNumber: 7, expectedHeadSha: "c".repeat(40) },
      { actionId: "ffff", workspaceId },
    );
    expect(moved.ok).toBe(false);
    if (!moved.ok) {
      expect(moved.message).toContain("head branch moved");
      expect(moved.message).toContain("Nothing was merged");
    }
  });

  it("surfaces branch protection and merge-conflict refusals honestly", async () => {
    proxyState.handler = () => ({
      status: 405,
      body: { message: "Required status check is failing" },
    });
    const outcome = await executeOperation(
      findOperation("github.merge_pull_request")!,
      { owner: "x", repo: "y", pullNumber: 7, expectedHeadSha: SHA_A },
      { actionId: null, workspaceId },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain("nothing was merged");
      expect(outcome.message).toContain("Branch protection");
    }
    // Bounded method values only.
    const badMethod = await executeOperation(
      findOperation("github.merge_pull_request")!,
      { owner: "x", repo: "y", pullNumber: 7, expectedHeadSha: SHA_A, method: "force" },
      { actionId: null, workspaceId },
    );
    expect(badMethod.ok).toBe(false);
    if (!badMethod.ok) expect(badMethod.message).toContain("merge, squash, rebase");
  });

  it("maps a revoked GitHub authorization to an auth outcome, not a fake success", async () => {
    proxyState.handler = () => ({ status: 401, body: { message: "Bad credentials" } });
    const outcome = await executeOperation(
      findOperation("github.create_branch")!,
      { owner: "x", repo: "y", branch: "fix-1", fromRef: "main" },
      { actionId: null, workspaceId },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("auth");
  });

  it("refuses every code operation for a workspace with no GitHub connection", async () => {
    const [stranger] = await db
      .insert(workspacesTable)
      .values({ clerkUserId: `recovery-test-nogh-${Date.now()}` })
      .returning();
    try {
      const outcome = await executeOperation(
        findOperation("github.put_file")!,
        { owner: "x", repo: "y", branch: "b", path: "a.txt", content: "c", message: "m" },
        { actionId: null, workspaceId: stranger.id },
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.kind).toBe("auth");
      expect(githubCalls()).toHaveLength(0);
    } finally {
      await db.delete(workspacesTable).where(eq(workspacesTable.id, stranger.id));
    }
  });

  it("refuses every code operation without a workspace owner", async () => {
    const outcome = await executeOperation(
      findOperation("github.merge_pull_request")!,
      { owner: "x", repo: "y", pullNumber: 1, expectedHeadSha: SHA_A },
      { actionId: null, workspaceId: null },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("auth");
    expect(proxyState.calls).toHaveLength(0);
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

  it("confirms a stranded branch creation by the ref's existence — never recreates", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.create_branch",
      app: "github",
      params: { owner: "x", repo: "y", branch: "fix-1", fromRef: "main" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path === "/repos/x/y/git/ref/heads/fix-1") {
        return { status: 200, body: { object: { sha: SHA_A } } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("confirmed");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("executed");
    expect(row.resultSummary).toContain(SHA_A);
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("re-queues a provably absent branch creation and re-runs it exactly once", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.create_branch",
      app: "github",
      params: { owner: "x", repo: "y", branch: "fix-2", fromRef: "main" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path === "/repos/x/y/git/ref/heads/fix-2") {
        return { status: 404, body: { message: "Not Found" } };
      }
      if (call.method === "GET" && call.path === "/repos/x/y/commits/main") {
        return { status: 200, body: { sha: SHA_A } };
      }
      if (call.method === "POST" && call.path === "/repos/x/y/git/refs") {
        return { status: 201, body: { ref: "refs/heads/fix-2" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("requeued");
    const claimed = await claimApprovedAction(action.id);
    expect(claimed).not.toBeNull();
    expect(await claimApprovedAction(action.id)).toBeNull(); // exactly-once fence
    const { action: finalized } = await executeClaimedAction(claimed!, "Tester", workspaceId);
    expect(finalized.status).toBe("executed");
    expect(
      proxyState.calls.filter((c) => c.method === "POST"),
    ).toHaveLength(1);
  });

  it("confirms a stranded file commit by its commit-message marker", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.put_file",
      app: "github",
      params: {
        owner: "x",
        repo: "y",
        branch: "fix-1",
        path: "src/app.ts",
        content: "const a = 1;",
        message: "Fix crash",
        expectedSha: SHA_A,
      },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.startsWith("/repos/x/y/commits?")) {
        expect(call.path).toContain("sha=fix-1");
        expect(call.path).toContain("path=src%2Fapp.ts");
        return {
          status: 200,
          body: [
            { sha: SHA_B, commit: { message: "unrelated" } },
            {
              sha: SHA_A,
              commit: {
                message: `Fix crash\n\n<!-- homardclaw-action:${action.id} -->`,
              },
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
    expect(row.resultSummary).toContain(SHA_A);
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("treats an unreadable branch as unknown for a stranded commit — never guesses", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.put_file",
      app: "github",
      params: {
        owner: "x",
        repo: "y",
        branch: "gone",
        path: "a.txt",
        content: "c",
        message: "m",
      },
      approvalId,
    });
    // 404: the branch may never have been created — or repo access may have
    // been revoked after the commit landed. Both are ambiguous.
    proxyState.handler = () => ({ status: 404, body: { message: "Not Found" } });
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("outcome is unknown");
    expect(proxyState.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("confirms a stranded pull request by its hidden body marker", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.open_pull_request",
      app: "github",
      params: { owner: "x", repo: "y", title: "Fix", head: "fix-1", base: "main" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.startsWith("/repos/x/y/pulls?state=all")) {
        expect(decodeURIComponent(call.path)).toContain("head=x:fix-1");
        return {
          status: 200,
          body: [
            {
              number: 12,
              html_url: "u12",
              body: `<!-- homardclaw-action:${action.id} -->`,
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
    expect(row.resultSummary).toContain("#12");
  });

  it("confirms a stranded merge from the pull request's merged state", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.merge_pull_request",
      app: "github",
      params: { owner: "x", repo: "y", pullNumber: 7, expectedHeadSha: SHA_A },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path === "/repos/x/y/pulls/7") {
        return {
          status: 200,
          body: { merged: true, merge_commit_sha: SHA_B, state: "closed" },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("confirmed");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("executed");
    expect(row.resultSummary).toContain(SHA_B);
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("re-queues an unmerged stranded merge; the retry still gates on the head SHA", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.merge_pull_request",
      app: "github",
      params: { owner: "x", repo: "y", pullNumber: 9, expectedHeadSha: SHA_A },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path === "/repos/x/y/pulls/9") {
        return { status: 200, body: { merged: false, state: "open" } };
      }
      if (call.method === "PUT" && call.path === "/repos/x/y/pulls/9/merge") {
        expect((call.body as { sha: string }).sha).toBe(SHA_A);
        return { status: 200, body: { merged: true, sha: SHA_B } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("requeued");
    const claimed = await claimApprovedAction(action.id);
    expect(claimed).not.toBeNull();
    const { action: finalized } = await executeClaimedAction(claimed!, "Tester", workspaceId);
    expect(finalized.status).toBe("executed");
    expect(proxyState.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });
});

/** Handler fragment: the tab-resolution GET used by sheets mutations. */
function tabsResponse(tabs: { sheetId: number; title: string }[]) {
  return {
    status: 200,
    body: { sheets: tabs.map((properties) => ({ properties })) },
  };
}

function batchUpdateCalls(): ProxyCall[] {
  return proxyState.calls.filter(
    (c) => c.method === "POST" && c.path.includes(":batchUpdate"),
  );
}

describe("google sheets executors", () => {
  it("ships every mutation and its action marker in one atomic batchUpdate", async () => {
    const actionId = "99999999-8888-7777-6666-555555555555";
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/v4/spreadsheets/")) {
        return tabsResponse([{ sheetId: 31, title: "Data" }]);
      }
      if (call.method === "POST" && call.path.includes(":batchUpdate")) {
        return { status: 200, body: { replies: [{}, {}] } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const op = findOperation("google_drive.append_sheet_rows");
    expect(op).not.toBeNull();
    const outcome = await executeOperation(
      op!,
      {
        spreadsheetId: "sheet-1",
        tabTitle: "Data",
        values: '[["Ada",42],["Bob",7]]',
      },
      { actionId, workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain("Appended 2 row(s)");
    const [batch] = batchUpdateCalls();
    const body = batch.body as {
      requests: Record<string, Record<string, unknown>>[];
    };
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0].appendCells).toMatchObject({
      sheetId: 31,
      fields: "userEnteredValue",
    });
    expect(body.requests[1].createDeveloperMetadata).toEqual({
      developerMetadata: {
        metadataKey: "homardclawActionId",
        metadataValue: actionId,
        location: { spreadsheet: true },
        visibility: "DOCUMENT",
      },
    });
  });

  it("writes formulas only for leading '=' strings, typing other cells", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/v4/spreadsheets/")) {
        return tabsResponse([{ sheetId: 0, title: "Data" }]);
      }
      if (call.method === "POST" && call.path.includes(":batchUpdate")) {
        return { status: 200, body: { replies: [{}, {}] } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const op = findOperation("google_drive.write_sheet_range");
    const outcome = await executeOperation(
      op!,
      {
        spreadsheetId: "sheet-1",
        range: "Data!A1:C1",
        values: '[["label","=SUM(B2:B9)",3.5]]',
      },
      { actionId: "act-w1", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    const body = batchUpdateCalls()[0].body as {
      requests: {
        updateCells?: {
          range: Record<string, number>;
          rows: { values: { userEnteredValue?: Record<string, unknown> }[] }[];
        };
      }[];
    };
    const update = body.requests[0].updateCells!;
    expect(update.range).toEqual({
      sheetId: 0,
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: 3,
    });
    expect(update.rows[0].values.map((v) => v.userEnteredValue)).toEqual([
      { stringValue: "label" },
      { formulaValue: "=SUM(B2:B9)" },
      { numberValue: 3.5 },
    ]);
  });

  it("refuses a write whose values do not match the range — before any provider call", async () => {
    proxyState.handler = (call) => {
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const op = findOperation("google_drive.write_sheet_range");
    const outcome = await executeOperation(
      op!,
      { spreadsheetId: "s", range: "Data!A1:B2", values: '[["only one"]]' },
      { actionId: "act-w2", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("must match exactly");
    expect(proxyState.calls).toHaveLength(0);
  });

  it("requires an explicit tab on writes and bounded ranges on reads", async () => {
    proxyState.handler = (call) => {
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const write = await executeOperation(
      findOperation("google_drive.write_sheet_range")!,
      { spreadsheetId: "s", range: "A1:B2", values: '[["a","b"],["c","d"]]' },
      { actionId: "act-w3", workspaceId },
    );
    expect(write.ok).toBe(false);
    expect(!write.ok && write.message).toContain("tab");
    const openEnded = await executeOperation(
      findOperation("google_drive.read_sheet_range")!,
      { spreadsheetId: "s", range: "Data!A:A" },
      { actionId: null, workspaceId },
    );
    expect(openEnded.ok).toBe(false);
    expect(!openEnded.ok && openEnded.message).toContain("bounded");
    const oversized = await executeOperation(
      findOperation("google_drive.read_sheet_range")!,
      { spreadsheetId: "s", range: "Data!A1:Z201" }, // 26 x 201 = 5226 cells
      { actionId: null, workspaceId },
    );
    expect(oversized.ok).toBe(false);
    expect(!oversized.ok && oversized.message).toContain("5000");
    expect(proxyState.calls).toHaveLength(0);
  });

  it("resolves tab titles case-insensitively only when unambiguous", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/v4/spreadsheets/")) {
        return tabsResponse([{ sheetId: 5, title: "data" }]);
      }
      if (call.method === "POST" && call.path.includes(":batchUpdate")) {
        return { status: 200, body: { replies: [{}, {}] } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const op = findOperation("google_drive.append_sheet_rows");
    const relaxed = await executeOperation(
      op!,
      { spreadsheetId: "s", tabTitle: "Data", values: '[["x"]]' },
      { actionId: "act-a1", workspaceId },
    );
    expect(relaxed.ok).toBe(true);
    expect(relaxed.ok && relaxed.summary).toContain('"data"');

    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/v4/spreadsheets/")) {
        return tabsResponse([
          { sheetId: 5, title: "data" },
          { sheetId: 6, title: "DATA" },
        ]);
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const ambiguous = await executeOperation(
      op!,
      { spreadsheetId: "s", tabTitle: "Data", values: '[["x"]]' },
      { actionId: "act-a2", workspaceId },
    );
    expect(ambiguous.ok).toBe(false);
    expect(!ambiguous.ok && ambiguous.message).toContain("ambiguous");
    expect(!ambiguous.ok && ambiguous.message).toContain('"DATA"');
  });

  it("lists tabs the agent can disambiguate with when the title is missing", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/v4/spreadsheets/")) {
        return tabsResponse([{ sheetId: 1, title: "Budget" }]);
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.rename_sheet_tab")!,
      { spreadsheetId: "s", tabTitle: "Nope", newTitle: "Still nope" },
      { actionId: "act-r1", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain('"Budget"');
    expect(batchUpdateCalls()).toHaveLength(0);
  });

  it("explains a Sheets edit denial instead of asking the owner to reconnect", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/v4/spreadsheets/")) {
        return tabsResponse([{ sheetId: 2, title: "Data" }]);
      }
      if (call.method === "POST" && call.path.includes(":batchUpdate")) {
        return {
          status: 403,
          body: { error: { message: "The caller does not have permission" } },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.add_sheet_tab")!,
      { spreadsheetId: "not-ours", tabTitle: "Extra" },
      { actionId: "act-t1", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.kind).toBe("failed");
    expect(!outcome.ok && outcome.message).toContain(
      "edit rights on this spreadsheet",
    );
  });

  it("keeps a genuine missing-scope 403 as a reconnectable auth outcome", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/v4/spreadsheets/")) {
        return tabsResponse([{ sheetId: 2, title: "Data" }]);
      }
      if (call.method === "POST" && call.path.includes(":batchUpdate")) {
        return {
          status: 403,
          body: {
            error: {
              message:
                "Request had insufficient authentication scopes.",
            },
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.add_sheet_tab")!,
      { spreadsheetId: "s", tabTitle: "Extra" },
      { actionId: "act-t2", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.kind).toBe("auth");
  });

  it("creates a native spreadsheet through Drive with the action marker", async () => {
    proxyState.handler = (call) => {
      if (call.method === "POST" && call.path.includes("/drive/v3/files")) {
        return { status: 200, body: { id: "spread-1" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.create_spreadsheet")!,
      { name: "Q3 Budget" },
      { actionId: "act-c1", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain(
      "https://docs.google.com/spreadsheets/d/spread-1/edit",
    );
    const body = proxyState.calls[0].body as Record<string, unknown>;
    expect(body.mimeType).toBe("application/vnd.google-apps.spreadsheet");
    expect(body.appProperties).toEqual({ homardclawActionId: "act-c1" });
  });

  it("reads a bounded range and reports emptiness explicitly", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/values/")) {
        expect(decodeURIComponent(call.path)).toContain("'Data'!A1:B2");
        return { status: 200, body: { values: [["Name", "Total"], ["Ada", "42"]] } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const read = await executeOperation(
      findOperation("google_drive.read_sheet_range")!,
      { spreadsheetId: "s", range: "Data!A1:B2" },
      { actionId: null, workspaceId },
    );
    expect(read.ok).toBe(true);
    expect(read.ok && read.summary).toContain("Name | Total");

    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/values/")) {
        return { status: 200, body: {} };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const empty = await executeOperation(
      findOperation("google_drive.read_sheet_range")!,
      { spreadsheetId: "s", range: "Data!A1:B2" },
      { actionId: null, workspaceId },
    );
    expect(empty.ok).toBe(true);
    expect(empty.ok && empty.summary).toContain("is empty");
  });
});

describe("drive organization executors", () => {
  const FOLDER_MIME = "application/vnd.google-apps.folder";

  it("creates a folder with the action marker after validating the parent", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/parent-1")) {
        return {
          status: 200,
          body: { id: "parent-1", name: "Projects", mimeType: FOLDER_MIME },
        };
      }
      if (call.method === "POST" && call.path.includes("/drive/v3/files")) {
        return { status: 200, body: { id: "folder-9" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.create_folder")!,
      { name: "Invoices 2026", parentFolderId: "parent-1" },
      { actionId: "act-f1", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain("folder-9");
    const create = proxyState.calls.find((c) => c.method === "POST")!;
    const body = create.body as Record<string, unknown>;
    expect(body.mimeType).toBe(FOLDER_MIME);
    expect(body.parents).toEqual(["parent-1"]);
    expect(body.appProperties).toEqual({ homardclawActionId: "act-f1" });
  });

  it("refuses to create a folder inside a plain file", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/doc-1")) {
        return {
          status: 200,
          body: { id: "doc-1", name: "Notes.txt", mimeType: "text/plain" },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.create_folder")!,
      { name: "Sub", parentFolderId: "doc-1" },
      { actionId: "act-f2", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("not a folder");
    // Nothing was created after the failed validation.
    expect(proxyState.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("renames an item, sending the new name and marker in one PATCH", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/file-1")) {
        return {
          status: 200,
          body: { id: "file-1", name: "Old name", mimeType: "text/plain" },
        };
      }
      if (call.method === "PATCH" && call.path.includes("/drive/v3/files/file-1")) {
        return { status: 200, body: { id: "file-1", name: "New name" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.rename_item")!,
      { fileId: "file-1", newName: "New name" },
      { actionId: "act-r9", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain('"Old name"');
    expect(outcome.ok && outcome.summary).toContain('"New name"');
    const patch = proxyState.calls.find((c) => c.method === "PATCH")!;
    const body = patch.body as Record<string, unknown>;
    expect(body.name).toBe("New name");
    expect(body.appProperties).toEqual({ homardclawActionId: "act-r9" });
  });

  it("moves an item into a folder, replacing its previous parents", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/file-2")) {
        return {
          status: 200,
          body: {
            id: "file-2",
            name: "Report",
            mimeType: "text/plain",
            parents: ["old-parent"],
          },
        };
      }
      if (call.method === "GET" && call.path.includes("/drive/v3/files/dest-1")) {
        return {
          status: 200,
          body: { id: "dest-1", name: "Archive", mimeType: FOLDER_MIME },
        };
      }
      if (call.method === "PATCH" && call.path.includes("/drive/v3/files/file-2")) {
        expect(call.path).toContain("addParents=dest-1");
        expect(call.path).toContain("removeParents=old-parent");
        return {
          status: 200,
          body: { id: "file-2", name: "Report", parents: ["dest-1"] },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.move_item")!,
      { fileId: "file-2", destinationFolderId: "dest-1" },
      { actionId: "act-m1", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain('"Archive"');
    const patch = proxyState.calls.find((c) => c.method === "PATCH")!;
    expect(
      (patch.body as Record<string, unknown>).appProperties,
    ).toEqual({ homardclawActionId: "act-m1" });
  });

  it("finds shared-drive items in search and can move one by the returned id", async () => {
    // Discovery: the search must span shared drives, or organization of
    // shared-drive files is impossible without an externally supplied id.
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files?q=")) {
        expect(call.path).toContain("corpora=allDrives");
        expect(call.path).toContain("supportsAllDrives=true");
        expect(call.path).toContain("includeItemsFromAllDrives=true");
        return {
          status: 200,
          body: {
            files: [
              {
                id: "shared-file-1",
                name: "Team plan",
                mimeType: "text/plain",
                modifiedTime: "2026-08-30T10:00:00Z",
                driveId: "team-drive-1",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const search = await executeOperation(
      findOperation("google_drive.search")!,
      { query: "Team plan" },
      { actionId: "act-s1", workspaceId },
    );
    expect(search.ok).toBe(true);
    expect(search.ok && search.summary).toContain("shared-file-1");
    expect(search.ok && search.summary).toContain("in a shared drive");

    // The returned id then works for a move: every organization call sends
    // supportsAllDrives so shared-drive items are reachable.
    proxyState.handler = (call) => {
      expect(call.path).toContain("supportsAllDrives=true");
      if (call.method === "GET" && call.path.includes("/drive/v3/files/shared-file-1")) {
        return {
          status: 200,
          body: {
            id: "shared-file-1",
            name: "Team plan",
            mimeType: "text/plain",
            parents: ["shared-old-parent"],
          },
        };
      }
      if (call.method === "GET" && call.path.includes("/drive/v3/files/shared-dest")) {
        return {
          status: 200,
          body: { id: "shared-dest", name: "Archive", mimeType: FOLDER_MIME },
        };
      }
      if (call.method === "PATCH" && call.path.includes("/drive/v3/files/shared-file-1")) {
        expect(call.path).toContain("addParents=shared-dest");
        expect(call.path).toContain("removeParents=shared-old-parent");
        return {
          status: 200,
          body: { id: "shared-file-1", name: "Team plan", parents: ["shared-dest"] },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const moved = await executeOperation(
      findOperation("google_drive.move_item")!,
      { fileId: "shared-file-1", destinationFolderId: "shared-dest" },
      { actionId: "act-s2", workspaceId },
    );
    expect(moved.ok).toBe(true);
  });

  it("refuses to move into a destination that is not a folder", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/file-3")) {
        return {
          status: 200,
          body: { id: "file-3", name: "Sheet", mimeType: "text/plain", parents: ["p"] },
        };
      }
      if (call.method === "GET" && call.path.includes("/drive/v3/files/doc-2")) {
        return {
          status: 200,
          body: { id: "doc-2", name: "Plain doc", mimeType: "text/plain" },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.move_item")!,
      { fileId: "file-3", destinationFolderId: "doc-2" },
      { actionId: "act-m2", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("not a folder");
    expect(proxyState.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("translates an item-permission 403 on rename into an actionable failure", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/shared-1")) {
        return {
          status: 200,
          body: { id: "shared-1", name: "Someone else's", mimeType: "text/plain" },
        };
      }
      if (call.method === "PATCH") {
        return {
          status: 403,
          body: { error: { message: "The caller does not have permission" } },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.rename_item")!,
      { fileId: "shared-1", newName: "Mine now" },
      { actionId: "act-r10", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.kind).toBe("failed");
    expect(!outcome.ok && outcome.message).toContain("shared read-only");
  });

  it("fails closed with reconnect guidance when full Drive access was never granted", async () => {
    // A separate workspace whose Google grant predates the broad scope.
    const [oldWorkspace] = await db
      .insert(workspacesTable)
      .values({ clerkUserId: `recovery-test-oldscope-${Date.now()}` })
      .returning();
    await db.insert(googleAccountsTable).values({
      workspaceId: oldWorkspace.id,
      clerkUserId: oldWorkspace.clerkUserId,
      googleSub: "old-sub",
      email: "old@example.com",
      refreshTokenEnc: encryptRefreshToken("old-refresh-token"),
      scopes:
        "openid email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
    });
    proxyState.handler = (call) => {
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.rename_item")!,
      { fileId: "any", newName: "Renamed" },
      { actionId: "act-r11", workspaceId: oldWorkspace.id },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.kind).toBe("auth");
    expect(!outcome.ok && outcome.message).toContain("full Google Drive access");
    // Fails before Google is ever contacted.
    expect(proxyState.calls).toHaveLength(0);
    await db
      .delete(googleAccountsTable)
      .where(eq(googleAccountsTable.workspaceId, oldWorkspace.id));
    await db
      .delete(workspacesTable)
      .where(eq(workspacesTable.id, oldWorkspace.id));
  });
});

describe("drive organization crash recovery", () => {
  it("confirms a stranded rename by the item's embedded marker", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.rename_item",
      app: "google_drive",
      params: { fileId: "file-7", newName: "Final name" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/file-7")) {
        return {
          status: 200,
          body: {
            id: "file-7",
            name: "Final name",
            appProperties: { homardclawActionId: action.id },
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("confirmed");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("executed");
    expect(row.resultSummary).toContain('"Final name"');
    // Only the verification read hit the provider.
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("settles as unknown when the item carries someone else's marker — never a replay", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.move_item",
      app: "google_drive",
      params: { fileId: "file-8", destinationFolderId: "dest-9" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/file-8")) {
        return {
          status: 200,
          // A later action overwrote the single marker key. Our move may or
          // may not have landed first — recovery must NOT requeue it, or an
          // already-done move could replay over the later change.
          body: {
            id: "file-8",
            name: "Report",
            parents: ["dest-9"],
            appProperties: { homardclawActionId: "some-other-action" },
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("cannot be confirmed");
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("settles a marker-less move as unknown instead of claiming non-delivery", async () => {
    const action = await insertExecutingAction({
      operation: "google_drive.move_item",
      app: "google_drive",
      params: { fileId: "file-9", destinationFolderId: "dest-2" },
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/file-9")) {
        return {
          status: 200,
          // Looks untouched — but the marker is a mutable per-app key, so
          // absence cannot prove the interrupted PATCH never landed.
          body: { id: "file-9", name: "Report", parents: ["old-parent"], appProperties: {} },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("not retried");
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("google sheets crash recovery", () => {
  it("confirms a stranded sheets append by its embedded action marker", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.append_sheet_rows",
      app: "google_drive",
      params: { spreadsheetId: "sheet-1", tabTitle: "Data", values: '[["x"]]' },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (
        call.method === "POST" &&
        call.path.includes("developerMetadata:search")
      ) {
        const body = call.body as {
          dataFilters: { developerMetadataLookup: Record<string, string> }[];
        };
        expect(body.dataFilters[0].developerMetadataLookup).toEqual({
          metadataKey: "homardclawActionId",
          metadataValue: action.id,
        });
        return {
          status: 200,
          body: { matchedDeveloperMetadata: [{ developerMetadata: {} }] },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("confirmed");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("executed");
    expect(row.resultSummary).toContain("Confirmed");
    expect(batchUpdateCalls()).toHaveLength(0);
  });

  it("never replays on a fresh absent marker — the crashed batch may still be in flight", async () => {
    // The race the marker cannot rule out: our process died after sending
    // the batchUpdate, Google is still executing it, and recovery's
    // metadata search (which reads the document, not a lagging index)
    // simply runs BEFORE the batch commits. A retry here would duplicate
    // the append once the original lands. Fresh absence must settle as
    // unknown, with no provider mutation of any kind.
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.append_sheet_rows",
      app: "google_drive",
      params: { spreadsheetId: "sheet-1", tabTitle: "Data", values: '[["x"]]' },
      approvalId,
      executingAt: new Date(), // interrupted seconds ago
    });
    proxyState.handler = (call) => {
      if (
        call.method === "POST" &&
        call.path.includes("developerMetadata:search")
      ) {
        return { status: 200, body: {} }; // no marker — yet
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("too recent");
    // Nothing was re-run and nothing will be: no batchUpdate ever went out.
    expect(batchUpdateCalls()).toHaveLength(0);
    expect(await claimApprovedAction(action.id)).toBeNull();
  });

  it("re-queues a marker-absent mutation only after the in-flight grace window", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.append_sheet_rows",
      app: "google_drive",
      params: { spreadsheetId: "sheet-1", tabTitle: "Data", values: '[["x"]]' },
      approvalId,
      // Default executingAt is minutes old: the crashed request can no
      // longer be in flight, so absence is conclusive.
    });
    proxyState.handler = (call) => {
      if (
        call.method === "POST" &&
        call.path.includes("developerMetadata:search")
      ) {
        return { status: 200, body: {} }; // no marker: provably not applied
      }
      if (call.method === "GET" && call.path.includes("/v4/spreadsheets/")) {
        return tabsResponse([{ sheetId: 3, title: "Data" }]);
      }
      if (call.method === "POST" && call.path.includes(":batchUpdate")) {
        return { status: 200, body: { replies: [{}, {}] } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("requeued");
    expect((await reloadAction(action.id)).status).toBe("approved");
    expect(batchUpdateCalls()).toHaveLength(0);

    // The retry carries the SAME action marker, and the claim is the
    // exactly-once fence.
    const claimed = await claimApprovedAction(action.id);
    expect(claimed).not.toBeNull();
    expect(await claimApprovedAction(action.id)).toBeNull();
    const { action: finalized } = await executeClaimedAction(claimed!, "Tester", workspaceId);
    expect(finalized.status).toBe("executed");
    const batches = batchUpdateCalls();
    expect(batches).toHaveLength(1);
    const body = batches[0].body as {
      requests: { createDeveloperMetadata?: { developerMetadata: { metadataValue: string } } }[];
    };
    expect(
      body.requests[1].createDeveloperMetadata!.developerMetadata
        .metadataValue,
    ).toBe(action.id);
  });

  it("treats a fresh absence of a created spreadsheet as unknown (eventual index)", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.create_spreadsheet",
      app: "google_drive",
      params: { name: "Q3 Budget" },
      approvalId,
      executingAt: new Date(), // Drive's search index may lag
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("appProperties")) {
        return { status: 200, body: { files: [] } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("too recent");
  });

  it("confirms a stranded spreadsheet creation by its Drive marker", async () => {
    const action = await insertExecutingAction({
      operation: "google_drive.create_spreadsheet",
      app: "google_drive",
      params: { name: "Q3 Budget" },
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("appProperties")) {
        expect(decodeURIComponent(call.path)).toContain(action.id);
        return {
          status: 200,
          body: { files: [{ id: "spread-9", name: "Q3 Budget" }] },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("confirmed");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("executed");
    expect(row.resultSummary).toContain(
      "https://docs.google.com/spreadsheets/d/spread-9/edit",
    );
    // Only the verification read hit the provider — nothing was created.
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("google docs executors", () => {
  const DOC_REVISION = "rev-doc-1";

  it("reads a document into an indexed outline with its revisionId", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.method === "GET") {
        expect(call.path).toContain("/v1/documents/doc-1");
        expect(call.path).toContain("includeTabsContent=true");
        return {
          status: 200,
          body: {
            revisionId: DOC_REVISION,
            title: "Plan",
            tabs: [
              {
                tabProperties: { tabId: "t.0", title: "Plan" },
                documentTab: {
                  body: {
                    content: [
                      {
                        startIndex: 1,
                        endIndex: 6,
                        paragraph: {
                          paragraphStyle: { namedStyleType: "HEADING_1" },
                          elements: [{ textRun: { content: "Plan\n" } }],
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.read_doc")!,
      { fileId: "doc-1" },
      { actionId: null, workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain(DOC_REVISION);
    expect(outcome.ok && outcome.summary).toContain("[1..6) HEADING_1 Plan⏎");
    // A single-tab doc reads as a plain outline, without tab labels.
    expect(outcome.ok && outcome.summary).not.toContain("tabId t.0");
  });

  it("labels every tab of a multi-tab document so edits can target them", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: DOC_REVISION,
            title: "Plan",
            tabs: [
              {
                tabProperties: { tabId: "t.0", title: "Overview" },
                documentTab: {
                  body: {
                    content: [
                      {
                        startIndex: 1,
                        endIndex: 6,
                        paragraph: { elements: [{ textRun: { content: "One\n" } }] },
                      },
                    ],
                  },
                },
                childTabs: [
                  {
                    tabProperties: { tabId: "t.1", title: "Detail" },
                    documentTab: {
                      body: {
                        content: [
                          {
                            startIndex: 1,
                            endIndex: 6,
                            paragraph: {
                              elements: [{ textRun: { content: "Two\n" } }],
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.read_doc")!,
      { fileId: "doc-1" },
      { actionId: null, workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain("2 tabs");
    expect(outcome.ok && outcome.summary).toContain('tab "Overview" (tabId t.0)');
    expect(outcome.ok && outcome.summary).toContain('tab "Detail" (tabId t.1)');
  });

  it("sends every edit revision-fenced through writeControl", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.path.includes(":batchUpdate")) {
        return {
          status: 200,
          body: { writeControl: { requiredRevisionId: "rev-doc-2" } },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.insert_doc_text")!,
      {
        fileId: "doc-1",
        revisionId: DOC_REVISION,
        index: 6,
        text: "Hello",
        tabId: "t.1",
      },
      { actionId: "act-d1", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain("rev-doc-2");
    const [batch] = proxyState.calls.filter((c) => c.connector === "docs");
    const body = batch.body as {
      requests: Record<string, unknown>[];
      writeControl: { requiredRevisionId: string };
    };
    expect(
      (body.requests[0].insertText as { location: Record<string, unknown> })
        .location,
    ).toEqual({ index: 6, tabId: "t.1" });
    expect(body.writeControl).toEqual({ requiredRevisionId: DOC_REVISION });
    expect(body.requests).toEqual([
      { insertText: { location: { index: 6, tabId: "t.1" }, text: "Hello" } },
    ]);
  });

  it("translates a stale-revision 400 into a read-again failure, nothing applied", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.path.includes(":batchUpdate")) {
        return {
          status: 400,
          body: {
            error: {
              message:
                "The provided revision ID doesn't match the latest revision.",
            },
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.delete_doc_range")!,
      { fileId: "doc-1", revisionId: "rev-stale", startIndex: 2, endIndex: 5 },
      { actionId: "act-d2", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.kind).toBe("failed");
    expect(!outcome.ok && outcome.message).toContain("NOTHING was changed");
    expect(!outcome.ok && outcome.message).toContain("fresh revisionId");
  });

  it("refuses invalid ranges and empty formatting before any provider call", async () => {
    proxyState.handler = (call) => {
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const zeroStart = await executeOperation(
      findOperation("google_drive.delete_doc_range")!,
      { fileId: "d", revisionId: "r", startIndex: 0, endIndex: 4 },
      { actionId: "act-d3", workspaceId },
    );
    expect(zeroStart.ok).toBe(false);
    expect(!zeroStart.ok && zeroStart.message).toContain("at least 1");
    const noStyle = await executeOperation(
      findOperation("google_drive.format_doc_range")!,
      { fileId: "d", revisionId: "r", startIndex: 1, endIndex: 4 },
      { actionId: "act-d4", workspaceId },
    );
    expect(noStyle.ok).toBe(false);
    expect(!noStyle.ok && noStyle.message).toContain("No formatting");
    expect(proxyState.calls).toHaveLength(0);
  });

  it("builds formatting requests with an exact field mask", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.path.includes(":batchUpdate")) {
        return {
          status: 200,
          body: { writeControl: { requiredRevisionId: "rev-doc-3" } },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.format_doc_range")!,
      {
        fileId: "doc-1",
        revisionId: DOC_REVISION,
        startIndex: 2,
        endIndex: 9,
        bold: "true",
        strikethrough: "false",
      },
      { actionId: "act-d5", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    const body = proxyState.calls[0].body as {
      requests: { updateTextStyle: Record<string, unknown> }[];
    };
    expect(body.requests[0].updateTextStyle).toEqual({
      range: { startIndex: 2, endIndex: 9 },
      textStyle: { bold: true, strikethrough: false },
      fields: "bold,strikethrough",
    });
  });
});

describe("google slides executors", () => {
  const REV = "rev-slides-1";

  it("creates a presentation through one atomic Drive call with the marker", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "google_drive" && call.method === "POST") {
        return { status: 200, body: { id: "pres-9" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.create_presentation")!,
      { name: "Q3 Review" },
      { actionId: "act-p1", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain(
      "https://docs.google.com/presentation/d/pres-9/edit",
    );
    const body = proxyState.calls[0].body as Record<string, unknown>;
    expect(body.mimeType).toBe("application/vnd.google-apps.presentation");
    expect(body.appProperties).toEqual({ homardclawActionId: "act-p1" });
  });

  it("adds a slide with a deterministic action-derived object id", async () => {
    const actionId = "99999999-8888-7777-6666-555555555555";
    proxyState.handler = (call) => {
      if (call.connector === "slides" && call.path.includes(":batchUpdate")) {
        return {
          status: 200,
          body: {
            writeControl: { requiredRevisionId: "rev-slides-2" },
            replies: [{ createSlide: { objectId: `hc-${actionId}` } }],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.add_slide")!,
      {
        fileId: "pres-1",
        revisionId: REV,
        layout: "title_and_body",
        insertAtIndex: "2",
      },
      { actionId, workspaceId },
    );
    expect(outcome.ok).toBe(true);
    const body = proxyState.calls[0].body as {
      requests: { createSlide: Record<string, unknown> }[];
      writeControl: { requiredRevisionId: string };
    };
    expect(body.writeControl.requiredRevisionId).toBe(REV);
    expect(body.requests[0].createSlide).toEqual({
      objectId: `hc-${actionId}`,
      insertionIndex: 2,
      slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
    });
  });

  it("rejects unknown layouts, listing the vocabulary, before any call", async () => {
    proxyState.handler = (call) => {
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.add_slide")!,
      { fileId: "pres-1", revisionId: REV, layout: "fancy" },
      { actionId: "act-p2", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("title_and_body");
    expect(proxyState.calls).toHaveLength(0);
  });

  it("refuses to delete an object that is not a slide", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "slides" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: REV,
            slides: [{ objectId: "p1" }, { objectId: "p2" }],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.delete_slide")!,
      { fileId: "pres-1", revisionId: REV, slideObjectId: "title-box-3" },
      { actionId: "act-p3", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("not a slide");
    // The membership read went out; no mutation ever did.
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses to duplicate an object that is not a slide", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "slides" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: REV,
            slides: [{ objectId: "p1" }, { objectId: "p2" }],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.duplicate_slide")!,
      { fileId: "pres-1", revisionId: REV, slideObjectId: "title-box-3" },
      { actionId: "act-p3b", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("not a slide");
    // The membership read went out; no mutation ever did.
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("duplicates a verified slide with the action-derived copy id", async () => {
    const actionId = "10000000-0000-4000-8000-00000000000d";
    proxyState.handler = (call) => {
      if (call.connector === "slides" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: REV,
            slides: [{ objectId: "p1" }, { objectId: "p2" }],
          },
        };
      }
      if (call.connector === "slides" && call.path.includes(":batchUpdate")) {
        return {
          status: 200,
          body: {
            writeControl: { requiredRevisionId: "rev-slides-4" },
            replies: [{ duplicateObject: { objectId: `hc-${actionId}` } }],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.duplicate_slide")!,
      { fileId: "pres-1", revisionId: REV, slideObjectId: "p2" },
      { actionId, workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain(`hc-${actionId}`);
    const mutation = proxyState.calls.find((c) => c.method !== "GET")!;
    const body = mutation.body as {
      requests: { duplicateObject: Record<string, unknown> }[];
      writeControl: { requiredRevisionId: string };
    };
    expect(body.writeControl).toEqual({ requiredRevisionId: REV });
    expect(body.requests[0].duplicateObject).toEqual({
      objectId: "p2",
      objectIds: { p2: `hc-${actionId}` },
    });
  });

  it("scopes replace_slide_text to one slide when given, and fences the edit", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "slides" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: REV,
            slides: [
              { objectId: "p1", pageElements: [] },
              {
                objectId: "p2",
                pageElements: [
                  {
                    shape: {
                      text: {
                        textElements: [
                          { textRun: { content: "Q2 up, Q2 down\n" } },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          },
        };
      }
      if (call.connector === "slides" && call.path.includes(":batchUpdate")) {
        return {
          status: 200,
          body: {
            writeControl: { requiredRevisionId: "rev-slides-3" },
            replies: [{ replaceAllText: { occurrencesChanged: 2 } }],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.replace_slide_text")!,
      {
        fileId: "pres-1",
        revisionId: REV,
        findText: "Q2",
        replaceText: "Q3",
        slideObjectId: "p2",
      },
      { actionId: "act-p4", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain("2 occurrence(s)");
    const mutation = proxyState.calls.find((c) => c.method !== "GET")!;
    const body = mutation.body as {
      requests: { replaceAllText: Record<string, unknown> }[];
    };
    expect(body.requests[0].replaceAllText).toEqual({
      containsText: { text: "Q2", matchCase: true },
      replaceText: "Q3",
      pageObjectIds: ["p2"],
    });
  });

  it("refuses a replace_slide_text beyond the occurrence bound before any mutation", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "slides" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: REV,
            slides: [
              {
                objectId: "p1",
                pageElements: [
                  {
                    shape: {
                      text: {
                        textElements: [
                          { textRun: { content: "Q2 ".repeat(101) } },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.replace_slide_text")!,
      { fileId: "pres-1", revisionId: REV, findText: "Q2", replaceText: "Q3" },
      { actionId: "act-p4b", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("limited to 100");
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("counts a doc replace against the fenced revision and applies within the bound", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: REV,
            body: {
              content: [
                {
                  paragraph: {
                    elements: [{ textRun: { content: "alpha beta alpha\n" } }],
                  },
                },
              ],
            },
          },
        };
      }
      if (call.connector === "docs" && call.path.includes(":batchUpdate")) {
        return {
          status: 200,
          body: {
            writeControl: { requiredRevisionId: "rev-doc-9" },
            replies: [{ replaceAllText: { occurrencesChanged: 2 } }],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.replace_doc_text")!,
      { fileId: "doc-1", revisionId: REV, findText: "alpha", replaceText: "omega" },
      { actionId: "act-d10", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain("2 occurrence(s)");
  });

  it("refuses a doc replace beyond the occurrence bound before any mutation", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: REV,
            body: {
              content: [
                {
                  paragraph: {
                    elements: [{ textRun: { content: "alpha ".repeat(101) } }],
                  },
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.replace_doc_text")!,
      { fileId: "doc-1", revisionId: REV, findText: "alpha", replaceText: "x" },
      { actionId: "act-d11", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("limited to 100");
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("pins a multi-tab doc replace to exactly the tabs it counted", async () => {
    const tabWith = (tabId: string, text: string, childTabs: unknown[] = []) => ({
      tabProperties: { tabId },
      documentTab: {
        body: {
          content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
        },
      },
      childTabs,
    });
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: REV,
            tabs: [
              tabWith("t.0", "alpha one\n", [tabWith("t.2", "alpha nested\n")]),
              tabWith("t.1", "alpha two alpha three\n"),
            ],
          },
        };
      }
      if (call.connector === "docs" && call.path.includes(":batchUpdate")) {
        return {
          status: 200,
          body: {
            writeControl: { requiredRevisionId: "rev-doc-10" },
            replies: [{ replaceAllText: { occurrencesChanged: 4 } }],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.replace_doc_text")!,
      { fileId: "doc-1", revisionId: REV, findText: "alpha", replaceText: "x" },
      { actionId: "act-d10b", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain("4 occurrence(s)");
    const mutation = proxyState.calls.find((c) => c.method !== "GET")!;
    const body = mutation.body as {
      requests: { replaceAllText: Record<string, unknown> }[];
    };
    // Every tab — including the nested child tab — is named explicitly, so
    // the mutation's scope is provably the scope the pre-count measured.
    expect(body.requests[0].replaceAllText).toEqual({
      containsText: { text: "alpha", matchCase: true },
      replaceText: "x",
      tabsCriteria: { tabIds: ["t.0", "t.2", "t.1"] },
    });
  });

  it("counts occurrences across EVERY tab of a multi-tab doc before replacing", async () => {
    const tabWith = (tabId: string, text: string) => ({
      tabProperties: { tabId },
      documentTab: {
        body: {
          content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
        },
      },
    });
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.method === "GET") {
        expect(call.path).toContain("includeTabsContent=true");
        return {
          status: 200,
          body: {
            revisionId: REV,
            // 60 + 60 occurrences: each tab is under the bound, the whole
            // document (which is what an unscoped replaceAllText edits) is
            // not.
            tabs: [
              tabWith("t.0", "alpha ".repeat(60)),
              tabWith("t.1", "alpha ".repeat(60)),
            ],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.replace_doc_text")!,
      { fileId: "doc-1", revisionId: REV, findText: "alpha", replaceText: "x" },
      { actionId: "act-d11b", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("occurs 120 times");
    expect(!outcome.ok && outcome.message).toContain("limited to 100");
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses a doc replace whose pre-count read sees a moved revision, changing nothing", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: "rev-moved-on",
            body: {
              content: [
                {
                  paragraph: {
                    elements: [{ textRun: { content: "alpha\n" } }],
                  },
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.replace_doc_text")!,
      { fileId: "doc-1", revisionId: REV, findText: "alpha", replaceText: "x" },
      { actionId: "act-d12", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("NOTHING was changed");
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("reports a doc replace with no matches without dispatching a mutation", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: REV,
            body: {
              content: [
                {
                  paragraph: {
                    elements: [{ textRun: { content: "nothing here\n" } }],
                  },
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.replace_doc_text")!,
      { fileId: "doc-1", revisionId: REV, findText: "alpha", replaceText: "x" },
      { actionId: "act-d13", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain("found nowhere");
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses a stale revision on slides edits with nothing applied", async () => {
    proxyState.handler = (call) => {
      if (call.connector === "slides" && call.path.includes(":batchUpdate")) {
        return {
          status: 400,
          body: {
            error: { message: "The requested revision is not the most recent." },
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.insert_slide_text")!,
      {
        fileId: "pres-1",
        revisionId: "rev-stale",
        elementObjectId: "title-1",
        insertAtIndex: 0,
        text: "Hi",
      },
      { actionId: "act-p5", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("NOTHING was changed");
  });
});

describe("plain-text editing and trash executors", () => {
  it("edits a text file with read-modify-write and an atomic multipart marker", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("alt=media")) {
        return { status: 200, body: "hello world\nhello again\n" };
      }
      if (call.method === "GET" && call.path.includes("/drive/v3/files/txt-1")) {
        return {
          status: 200,
          body: { id: "txt-1", name: "notes.txt", mimeType: "text/plain", size: "24" },
        };
      }
      if (call.method === "PATCH" && call.path.includes("/upload/drive/v3/files/txt-1")) {
        expect(call.path).toContain("uploadType=multipart");
        return { status: 200, body: { id: "txt-1" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.update_text_file")!,
      { fileId: "txt-1", mode: "replace", findText: "hello", content: "goodbye" },
      { actionId: "act-t1", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain("2 occurrence(s)");
    const patch = proxyState.calls.find((c) => c.method === "PATCH")!;
    const raw = String(patch.body);
    // The marker metadata and the new content travel in ONE request.
    expect(raw).toContain('"homardclawActionId":"act-t1"');
    expect(raw).toContain("goodbye world\ngoodbye again\n");
  });

  it("refuses to delete a spreadsheet's final tab before any mutation", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/v4/spreadsheets/")) {
        return tabsResponse([{ sheetId: 0, title: "Only" }]);
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.delete_sheet_tab")!,
      { spreadsheetId: "sheet-1", tabTitle: "Only" },
      { actionId: "act-lt1", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("only tab");
    expect(!outcome.ok && outcome.message).toContain("trash_item");
    expect(batchUpdateCalls()).toHaveLength(0);
  });

  it("verifies octet-stream content is really text before editing it", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("alt=media")) {
        return { status: 200, body: "PK\u0003\u0004\u0000binary" };
      }
      if (call.method === "GET" && call.path.includes("/drive/v3/files/blob-1")) {
        return {
          status: 200,
          body: {
            id: "blob-1",
            name: "archive",
            mimeType: "application/octet-stream",
            size: "12",
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    // Even overwrite mode downloads first: the label alone proves nothing.
    const outcome = await executeOperation(
      findOperation("google_drive.update_text_file")!,
      { fileId: "blob-1", mode: "overwrite", content: "text now" },
      { actionId: "act-t6", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("binary");
    expect(proxyState.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("refuses a derived edit when the file's revision moved during preparation", async () => {
    let metadataReads = 0;
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("alt=media")) {
        return { status: 200, body: "line one\n" };
      }
      if (call.method === "GET" && call.path.includes("headRevisionId")) {
        metadataReads += 1;
        return {
          status: 200,
          body: {
            id: "txt-3",
            name: "log.txt",
            mimeType: "text/plain",
            size: "9",
            // First read fences at rev-1; the pre-upload re-check sees rev-2.
            headRevisionId: metadataReads === 1 ? "rev-1" : "rev-2",
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.update_text_file")!,
      { fileId: "txt-3", mode: "append", content: "line two\n" },
      { actionId: "act-t7", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("changed while");
    expect(metadataReads).toBe(2);
    expect(proxyState.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("refuses native Google files and non-text files without touching content", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/gdoc-1")) {
        return {
          status: 200,
          body: {
            id: "gdoc-1",
            name: "Plan",
            mimeType: "application/vnd.google-apps.document",
          },
        };
      }
      if (call.method === "GET" && call.path.includes("/drive/v3/files/img-1")) {
        return {
          status: 200,
          body: { id: "img-1", name: "photo.png", mimeType: "image/png", size: "5" },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const native = await executeOperation(
      findOperation("google_drive.update_text_file")!,
      { fileId: "gdoc-1", mode: "overwrite", content: "x" },
      { actionId: "act-t2", workspaceId },
    );
    expect(native.ok).toBe(false);
    expect(!native.ok && native.message).toContain("Docs, Sheets, or Slides");
    const binary = await executeOperation(
      findOperation("google_drive.update_text_file")!,
      { fileId: "img-1", mode: "overwrite", content: "x" },
      { actionId: "act-t3", workspaceId },
    );
    expect(binary.ok).toBe(false);
    expect(!binary.ok && binary.message).toContain("not a plain-text file");
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("fails a replace whose findText matches nothing, changing nothing", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("alt=media")) {
        return { status: 200, body: "alpha beta" };
      }
      if (call.method === "GET" && call.path.includes("/drive/v3/files/txt-2")) {
        return {
          status: 200,
          body: { id: "txt-2", name: "a.txt", mimeType: "text/plain", size: "10" },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.update_text_file")!,
      { fileId: "txt-2", mode: "replace", findText: "gamma", content: "delta" },
      { actionId: "act-t4", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("found nowhere");
    expect(proxyState.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("moves a folder to the Trash with the marker in the same PATCH", async () => {
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/folder-1")) {
        return {
          status: 200,
          body: {
            id: "folder-1",
            name: "Old projects",
            mimeType: "application/vnd.google-apps.folder",
          },
        };
      }
      if (call.method === "PATCH" && call.path.includes("/drive/v3/files/folder-1")) {
        return { status: 200, body: { id: "folder-1", trashed: true } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const outcome = await executeOperation(
      findOperation("google_drive.trash_item")!,
      { fileId: "folder-1" },
      { actionId: "act-t5", workspaceId },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain("Trash");
    expect(outcome.ok && outcome.summary).toContain("Everything inside the folder");
    const patch = proxyState.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({
      trashed: true,
      appProperties: { homardclawActionId: "act-t5" },
    });
  });
});

describe("docs, slides, text-file, and trash crash recovery", () => {
  it("requeues a fenced doc edit when the revision provably never moved", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.insert_doc_text",
      app: "google_drive",
      params: { fileId: "doc-1", revisionId: "rev-A", index: 3, text: "Hi" },
      approvalId,
      executingAt: new Date(), // freshness is irrelevant: the fence decides
    });
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.method === "GET") {
        return { status: 200, body: { revisionId: "rev-A" } };
      }
      if (call.connector === "docs" && call.path.includes(":batchUpdate")) {
        return {
          status: 200,
          body: { writeControl: { requiredRevisionId: "rev-B" } },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("requeued");
    expect((await reloadAction(action.id)).status).toBe("approved");
    // The retry carries the SAME fence, so even a lost race cannot double-apply.
    const claimed = await claimApprovedAction(action.id);
    const { action: finalized } = await executeClaimedAction(claimed!, "Tester", workspaceId);
    expect(finalized.status).toBe("executed");
    const batch = proxyState.calls.find((c) => c.path.includes(":batchUpdate"))!;
    expect(
      (batch.body as { writeControl: { requiredRevisionId: string } })
        .writeControl.requiredRevisionId,
    ).toBe("rev-A");
  });

  it("settles a doc edit as unknown once the revision has advanced — never a replay", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.replace_doc_text",
      app: "google_drive",
      params: { fileId: "doc-1", revisionId: "rev-A", findText: "a", replaceText: "b" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.connector === "docs" && call.method === "GET") {
        return { status: 200, body: { revisionId: "rev-C" } };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("not retried");
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("confirms a stranded add_slide by its action-pinned object id", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.add_slide",
      app: "google_drive",
      params: { fileId: "pres-1", revisionId: "rev-A", layout: "blank" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.connector === "slides" && call.method === "GET") {
        return {
          status: 200,
          body: {
            revisionId: "rev-B",
            slides: [{ objectId: "p1" }, { objectId: `hc-${action.id}` }],
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("confirmed");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("executed");
    expect(row.resultSummary).toContain(`hc-${action.id}`);
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("requeues an absent add_slide only under an unmoved revision fence", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.add_slide",
      app: "google_drive",
      params: { fileId: "pres-1", revisionId: "rev-A", layout: "blank" },
      approvalId,
      executingAt: new Date(),
    });
    proxyState.handler = (call) => {
      if (call.connector === "slides" && call.method === "GET") {
        return {
          status: 200,
          body: { revisionId: "rev-A", slides: [{ objectId: "p1" }] },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("requeued");
    expect((await reloadAction(action.id)).status).toBe("approved");
  });

  it("requeues a crashed duplicate whose target was a page element, not a slide", async () => {
    // The copy id is action-derived, so its absence under an unmoved
    // revision proves the batch never landed — regardless of the bogus
    // target. The requeued retry then hits the executor's slide-membership
    // guard and fails cleanly instead of duplicating a text box.
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.duplicate_slide",
      app: "google_drive",
      params: {
        fileId: "pres-1",
        revisionId: "rev-A",
        slideObjectId: "title-box-3",
      },
      approvalId,
      executingAt: new Date(),
    });
    proxyState.handler = (call) => {
      if (call.connector === "slides" && call.method === "GET") {
        return {
          status: 200,
          body: { revisionId: "rev-A", slides: [{ objectId: "p1" }] },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("requeued");
    expect((await reloadAction(action.id)).status).toBe("approved");
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("settles an absent add_slide as unknown when the revision moved on", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.duplicate_slide",
      app: "google_drive",
      params: { fileId: "pres-1", revisionId: "rev-A", slideObjectId: "p1" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.connector === "slides" && call.method === "GET") {
        return {
          status: 200,
          body: { revisionId: "rev-D", slides: [{ objectId: "p1" }] },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    expect((await reloadAction(action.id)).status).toBe("failed");
  });

  it("confirms a stranded text-file edit by its embedded marker", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.update_text_file",
      app: "google_drive",
      params: { fileId: "txt-1", mode: "append", content: "more" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/txt-1")) {
        return {
          status: 200,
          body: {
            id: "txt-1",
            name: "notes.txt",
            appProperties: { homardclawActionId: action.id },
          },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("confirmed");
    expect((await reloadAction(action.id)).status).toBe("executed");
  });

  it("settles a marker-less text-file edit as unknown — the marker is mutable", async () => {
    const action = await insertExecutingAction({
      operation: "google_drive.update_text_file",
      app: "google_drive",
      params: { fileId: "txt-1", mode: "overwrite", content: "fresh" },
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/txt-1")) {
        return {
          status: 200,
          body: { id: "txt-1", name: "notes.txt", appProperties: {} },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("not retried");
  });

  it("confirms a stranded trash by the item being in the Trash", async () => {
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "google_drive.trash_item",
      app: "google_drive",
      params: { fileId: "file-5" },
      approvalId,
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/file-5")) {
        return {
          status: 200,
          // Marker overwritten by a later action, but the approved end
          // state — the item is in the Trash — holds.
          body: { id: "file-5", name: "Draft", trashed: true, appProperties: {} },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("confirmed");
    expect((await reloadAction(action.id)).status).toBe("executed");
  });

  it("never re-trashes an item that is out of the Trash without our marker", async () => {
    const action = await insertExecutingAction({
      operation: "google_drive.trash_item",
      app: "google_drive",
      params: { fileId: "file-6" },
    });
    proxyState.handler = (call) => {
      if (call.method === "GET" && call.path.includes("/drive/v3/files/file-6")) {
        return {
          status: 200,
          // Untrashed, no marker: the PATCH may have landed and the owner
          // restored the item since. Re-trashing would override the owner.
          body: { id: "file-6", name: "Draft", trashed: false, appProperties: {} },
        };
      }
      throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
    };
    const [resolved] = await reconcileStaleExecutingActions(taskId, "Tester", workspaceId);
    expect(resolved.resolution).toBe("unknown");
    const row = await reloadAction(action.id);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("not retried");
    expect(proxyState.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("auth-refused approved actions are preserved, not failed", () => {
  const commentCalls = () =>
    proxyState.calls.filter(
      (c) =>
        c.connector === "github" &&
        c.method === "POST" &&
        c.path.includes("/comments"),
    );

  /** Force the GitHub App path off so a 401 refusal is a pure OAuth refusal
   *  with no recovery side-channel: present-but-empty is "absent". */
  function withoutGithubApp(): void {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_SLUG", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
  }

  const refuseThenAccept = (behavior: { refuse: boolean }) => {
    proxyState.handler = (call) => {
      if (call.connector !== "github") {
        throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
      }
      return behavior.refuse
        ? { status: 401, body: { message: "Bad credentials" } }
        : { status: 200, body: { html_url: "https://github.com/x/y/issues/1#c9" } };
    };
  };

  it("parks the action on a pre-execution credential refusal and re-runs it exactly once with the SAME marker", async () => {
    withoutGithubApp();
    const behavior = { refuse: true };
    refuseThenAccept(behavior);
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.comment_on_issue",
      app: "github",
      params: { owner: "x", repo: "y", issueNumber: 1, body: "LGTM" },
      approvalId,
      executingAt: new Date(),
    });

    const { action: parked, outcome } = await executeClaimedAction(
      action,
      "Tester",
      workspaceId,
      { allowAuthPark: true },
    );
    // Preserved: back to approved with the single-retry fence spent-able
    // exactly once, the approval untouched, the refusal recorded.
    expect(outcome.ok).toBe(false);
    expect(parked.status).toBe("approved");
    expect(parked.approvalId).toBe(approvalId);
    expect(parked.recoveryRequeuedAt).not.toBeNull();
    expect(parked.errorMessage).toMatch(/GitHub|credential|Reconnect/i);
    expect(parked.executedAt).toBeNull();

    // Connection repaired: the ordinary claim fence re-runs it exactly once.
    behavior.refuse = false;
    const claimed = await claimApprovedAction(action.id);
    expect(claimed).not.toBeNull();
    expect(await claimApprovedAction(action.id)).toBeNull();
    const { action: finalized } = await executeClaimedAction(
      claimed!,
      "Tester",
      workspaceId,
      { allowAuthPark: true },
    );
    expect(finalized.status).toBe("executed");
    const posts = commentCalls();
    // One refused POST, one successful POST — and the retry carries the
    // SAME idempotency marker derived from the original action id.
    expect(posts).toHaveLength(2);
    expect((posts[1].body as { body: string }).body).toContain(
      `<!-- homardclaw-action:${action.id} -->`,
    );
  });

  it("parks a create_issue action on a pre-execution credential refusal, never reports success on the 401, and re-runs it exactly once with the SAME marker", async () => {
    withoutGithubApp();
    const behavior = { refuse: true };
    proxyState.handler = (call) => {
      if (call.connector !== "github") {
        throw new Error(`unexpected provider call: ${call.method} ${call.path}`);
      }
      return behavior.refuse
        ? { status: 401, body: { message: "Bad credentials" } }
        : {
            status: 201,
            body: { number: 9, html_url: "https://github.com/x/y/issues/9" },
          };
    };
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.create_issue",
      app: "github",
      params: { owner: "x", repo: "y", title: "Bug", body: "It broke" },
      approvalId,
      executingAt: new Date(),
    });

    const { action: parked, outcome } = await executeClaimedAction(
      action,
      "Tester",
      workspaceId,
      { allowAuthPark: true },
    );
    // The 401 must never be reported as success: the action is preserved
    // (approved, not executed) with the single-retry fence spent-able
    // exactly once, the original approval untouched.
    expect(outcome.ok).toBe(false);
    expect(parked.status).toBe("approved");
    expect(parked.approvalId).toBe(approvalId);
    expect(parked.recoveryRequeuedAt).not.toBeNull();
    expect(parked.errorMessage).toMatch(/GitHub|credential|Reconnect/i);
    expect(parked.executedAt).toBeNull();
    expect(parked.resultSummary).toBeNull();

    // Connection repaired: the ordinary claim fence re-runs it exactly once.
    behavior.refuse = false;
    const claimed = await claimApprovedAction(action.id);
    expect(claimed).not.toBeNull();
    expect(await claimApprovedAction(action.id)).toBeNull();
    const { action: finalized } = await executeClaimedAction(
      claimed!,
      "Tester",
      workspaceId,
      { allowAuthPark: true },
    );
    expect(finalized.status).toBe("executed");
    expect(finalized.resultSummary).toContain("#9");
    const posts = proxyState.calls.filter(
      (c) =>
        c.connector === "github" &&
        c.method === "POST" &&
        c.path === "/repos/x/y/issues",
    );
    // One refused POST, one successful POST — and the retry carries the
    // SAME idempotency marker derived from the original action id.
    expect(posts).toHaveLength(2);
    expect((posts[1].body as { body: string }).body).toContain(
      `<!-- homardclaw-action:${action.id} -->`,
    );
  });

  it("fails honestly when the retry fence is already spent", async () => {
    withoutGithubApp();
    refuseThenAccept({ refuse: true });
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.comment_on_issue",
      app: "github",
      params: { owner: "x", repo: "y", issueNumber: 2, body: "Again" },
      approvalId,
      executingAt: new Date(),
      recoveryRequeuedAt: new Date(), // fence already spent
    });
    const { action: finalized } = await executeClaimedAction(
      action,
      "Tester",
      workspaceId,
      { allowAuthPark: true },
    );
    expect(finalized.status).toBe("failed");
    expect(finalized.errorMessage).toBeTruthy();
  });

  it("never parks without opt-in or without an approval", async () => {
    withoutGithubApp();
    refuseThenAccept({ refuse: true });
    const approvalId = await insertApproval();
    const optedOut = await insertExecutingAction({
      operation: "github.comment_on_issue",
      app: "github",
      params: { owner: "x", repo: "y", issueNumber: 3, body: "No park" },
      approvalId,
      executingAt: new Date(),
    });
    const { action: failedA } = await executeClaimedAction(
      optedOut,
      "Tester",
      workspaceId,
    );
    expect(failedA.status).toBe("failed");

    const unapproved = await insertExecutingAction({
      operation: "github.comment_on_issue",
      app: "github",
      params: { owner: "x", repo: "y", issueNumber: 4, body: "No approval" },
      approvalId: null,
      executingAt: new Date(),
    });
    const { action: failedB } = await executeClaimedAction(
      unapproved,
      "Tester",
      workspaceId,
      { allowAuthPark: true },
    );
    expect(failedB.status).toBe("failed");
  });

  it("marks only pre-execution refusals parkable — a provider 401 mid-catalog write stays a refusal, an ambiguous 500 never parks", async () => {
    withoutGithubApp();
    proxyState.handler = () => ({ status: 500, body: { message: "boom" } });
    const approvalId = await insertApproval();
    const action = await insertExecutingAction({
      operation: "github.comment_on_issue",
      app: "github",
      params: { owner: "x", repo: "y", issueNumber: 5, body: "Ambiguous" },
      approvalId,
      executingAt: new Date(),
    });
    const { action: finalized } = await executeClaimedAction(
      action,
      "Tester",
      workspaceId,
      { allowAuthPark: true },
    );
    // A 500 might have executed on the provider's side: it must finalize
    // (failed), never park for an automatic re-send.
    expect(finalized.status).toBe("failed");
  });
});

describe("tasks parked for connected-app credential recovery", () => {
  async function insertRunningTask(ws: string): Promise<{ id: string; attempts: number }> {
    const [row] = await db
      .insert(tasksTable)
      .values({
        agentId,
        workspaceId: ws,
        objective: `Auth-park fixture ${RUN_TAG}`,
        status: "running",
        attempts: 1,
        provider: "claude_max",
      })
      .returning();
    return { id: row.id, attempts: row.attempts };
  }

  async function taskRow(id: string) {
    const [row] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, id));
    return row;
  }

  it("parks a running task with a delayed retry and releases it when the workspace reconnects", async () => {
    const task = await insertRunningTask(workspaceId);
    try {
      expect(
        await parkTaskForAppAuthRecovery({
          taskId: task.id,
          attempts: task.attempts,
          workspaceId,
          message: "GitHub refused the stored credential.",
          refusedAt: new Date(),
        }),
      ).toBe(true);
      let row = await taskRow(task.id);
      expect(row.status).toBe("queued");
      expect(row.errorKind).toBe(APP_AUTH_PARK_ERROR_KIND);
      // Not immediately claimable: the retry waits for the reconnect.
      expect(row.notBefore!.getTime()).toBeGreaterThan(Date.now() + 60_000);

      // The reconnect releases it right away…
      expect(await resumeTasksParkedForAppAuth(workspaceId)).toBe(1);
      row = await taskRow(task.id);
      expect(row.notBefore!.getTime()).toBeLessThanOrEqual(Date.now());
      // …and a second resume is a no-op (nothing still waiting).
      expect(await resumeTasksParkedForAppAuth(workspaceId)).toBe(0);
    } finally {
      await db.delete(tasksTable).where(eq(tasksTable.id, task.id));
    }
  });

  it("releases the park immediately when the reconnect raced ahead of the task-park", async () => {
    // The race the code review flagged: the OAuth/App-setup callback lands
    // BETWEEN the action being preserved and the task-park write. At that
    // instant the task is still "running", so resumeTasksParkedForAppAuth
    // finds nothing — the post-park recheck against the credential row's
    // updatedAt must release it instead of stranding it for 30 minutes.
    const task = await insertRunningTask(workspaceId);
    try {
      const refusedAt = new Date(Date.now() - 5_000);
      // Reconnect already happened: credential row fresher than the refusal.
      await db
        .update(githubAccountsTable)
        .set({ updatedAt: new Date() })
        .where(eq(githubAccountsTable.workspaceId, workspaceId));
      expect(
        await parkTaskForAppAuthRecovery({
          taskId: task.id,
          attempts: task.attempts,
          workspaceId,
          message: "refused just before the reconnect landed",
          refusedAt,
        }),
      ).toBe(true);
      const row = await taskRow(task.id);
      expect(row.status).toBe("queued");
      // Immediately claimable — the reconnect was not missed.
      expect(row.notBefore!.getTime()).toBeLessThanOrEqual(Date.now());
    } finally {
      await db.delete(tasksTable).where(eq(tasksTable.id, task.id));
    }
  });

  it("parking is fenced on the exact running attempt — a settled or retried task is never overwritten", async () => {
    const task = await insertRunningTask(workspaceId);
    try {
      await db
        .update(tasksTable)
        .set({ status: "done" })
        .where(eq(tasksTable.id, task.id));
      expect(
        await parkTaskForAppAuthRecovery({
          taskId: task.id,
          attempts: task.attempts,
          workspaceId,
          message: "too late",
          refusedAt: new Date(),
        }),
      ).toBe(false);
      expect((await taskRow(task.id)).status).toBe("done");
    } finally {
      await db.delete(tasksTable).where(eq(tasksTable.id, task.id));
    }
  });

  it("a reconnect never nudges a foreign workspace's parked tasks or ordinary scheduled tasks", async () => {
    const [foreignWs] = await db
      .insert(workspacesTable)
      .values({ clerkUserId: `auth-park-foreign-${Date.now()}` })
      .returning();
    const foreign = await insertRunningTask(foreignWs.id);
    const local = await insertRunningTask(workspaceId);
    const scheduledNotBefore = new Date(Date.now() + 60 * 60 * 1000);
    const [scheduled] = await db
      .insert(tasksTable)
      .values({
        agentId,
        workspaceId,
        objective: `Ordinary scheduled fixture ${RUN_TAG}`,
        status: "queued",
        notBefore: scheduledNotBefore, // ordinary delay, NOT an auth park
        provider: "claude_max",
      })
      .returning();
    try {
      await parkTaskForAppAuthRecovery({
        taskId: foreign.id,
        attempts: foreign.attempts,
        workspaceId: foreignWs.id,
        message: "foreign park",
        refusedAt: new Date(),
      });
      await parkTaskForAppAuthRecovery({
        taskId: local.id,
        attempts: local.attempts,
        workspaceId,
        message: "local park",
        refusedAt: new Date(),
      });
      expect(await resumeTasksParkedForAppAuth(workspaceId)).toBe(1);
      // The foreign park still waits; the ordinary scheduled task kept its
      // own notBefore untouched.
      expect((await taskRow(foreign.id)).notBefore!.getTime()).toBeGreaterThan(
        Date.now(),
      );
      expect((await taskRow(scheduled.id)).notBefore!.getTime()).toBe(
        scheduledNotBefore.getTime(),
      );
    } finally {
      await db.delete(tasksTable).where(eq(tasksTable.id, foreign.id));
      await db.delete(tasksTable).where(eq(tasksTable.id, local.id));
      await db.delete(tasksTable).where(eq(tasksTable.id, scheduled.id));
      await db.delete(workspacesTable).where(eq(workspacesTable.id, foreignWs.id));
    }
  });
});
