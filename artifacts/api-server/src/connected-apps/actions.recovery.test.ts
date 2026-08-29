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

  it("explains a drive.file edit denial instead of asking the owner to reconnect", async () => {
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
      "only edit spreadsheets it created",
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
