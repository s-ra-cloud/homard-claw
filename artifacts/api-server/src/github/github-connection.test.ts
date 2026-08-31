/**
 * Regression coverage for GitHub connection stability (revoked tokens,
 * permission 403s, unreadable encrypted credentials, transient provider
 * failures):
 *  - refusal classification distinguishes a revoked token from a missing
 *    scope, a repository/organization permission denial, a rate limit, and
 *    a GitHub outage — a generic 401/403 never just claims "expired"
 *  - task execution surfaces those classes with owner-actionable text and
 *    a structured, secret-free log carrying workspace/action correlation
 *  - the live connection health check marks a known-bad credential as
 *    needing reconnection, keeps transient failures from flipping a stored
 *    credential to "broken", and caches briefly (invalidated on reconnect)
 *  - an undecryptable credential row (encryption secret changed since it
 *    was stored) is reported as reconnect-needed with a SESSION_SECRET
 *    explanation, at status time and by the startup diagnostic
 *  - no user-facing message or log line ever contains the token
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md): all
 * provider traffic goes through a stubbed global fetch — never the network;
 * tag and clean up all created rows; never clobber the live owner rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  githubAccountsTable,
  pool,
  workspacesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const TEST_TOKEN = "test-github-token-secret-value";

const githubState = vi.hoisted(() => ({
  calls: [] as { path: string; method: string }[],
  handler: null as
    | null
    | ((call: { path: string; method: string }) =>
        | { status: number; body: unknown; headers?: Record<string, string> }
        | never),
}));

const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const base = "https://api.github.com";
    if (!url.startsWith(base)) return realFetch(input, init);
    const call = { path: url.slice(base.length), method: init?.method ?? "GET" };
    githubState.calls.push(call);
    if (!githubState.handler) {
      throw new TypeError("fetch failed (no handler installed)");
    }
    const res = githubState.handler(call);
    return new Response(
      typeof res.body === "string" ? res.body : JSON.stringify(res.body),
      { status: res.status, headers: res.headers ?? {} },
    );
  },
);

import { executeOperation, connectionStatus } from "../connected-apps/connections";
import { findOperation } from "../connected-apps/catalog";
import {
  checkGithubConnectionHealth,
  clearGithubHealthCache,
  encryptGithubToken,
  githubAccessToken,
  logGithubCredentialStartupHealth,
} from "./credentials";
import { classifyGithubRefusal, describeGithubRefusal } from "./failures";
import { logger } from "../lib/logger";

let workspaceId: string;
let goodTokenEnc: string;

beforeAll(async () => {
  const [workspace] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `github-conn-test-${Date.now()}` })
    .returning();
  workspaceId = workspace.id;
  goodTokenEnc = encryptGithubToken(TEST_TOKEN);
  await db.insert(githubAccountsTable).values({
    workspaceId,
    clerkUserId: workspace.clerkUserId,
    githubUserId: "9999",
    login: "conn-tester",
    accessTokenEnc: goodTokenEnc,
    scopes: "repo",
  });
});

afterAll(async () => {
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  vi.unstubAllGlobals();
  await pool.end();
});

beforeEach(async () => {
  githubState.calls = [];
  githubState.handler = null;
  clearGithubHealthCache();
  vi.restoreAllMocks();
  // Undo any per-test credential corruption.
  await db
    .update(githubAccountsTable)
    .set({ accessTokenEnc: goodTokenEnc, scopes: "repo" })
    .where(eq(githubAccountsTable.workspaceId, workspaceId));
});

function headers(h: Record<string, string>): Headers {
  return new Headers(h);
}

describe("GitHub refusal classification", () => {
  it("classifies a 401 as a revoked/invalid token needing reconnection", () => {
    const refusal = classifyGithubRefusal(
      401,
      headers({ "x-github-request-id": "AAAA:1234:5678" }),
    );
    expect(refusal.failureClass).toBe("invalid_token");
    const described = describeGithubRefusal(refusal, 401)!;
    expect(described.kind).toBe("auth");
    expect(described.message).toContain("revoked or reset");
    expect(described.message).toContain("Reconnect GitHub");
    expect(described.message).toContain("does not need to be recreated");
    expect(described.message).toContain("AAAA:1234:5678");
  });

  it("classifies an exhausted rate limit as retryable, not an auth problem", () => {
    const refusal = classifyGithubRefusal(
      403,
      headers({ "x-ratelimit-remaining": "0" }),
    );
    expect(refusal.failureClass).toBe("rate_limited");
    const described = describeGithubRefusal(refusal, 403)!;
    expect(described.kind).toBe("failed");
    expect(described.message).toContain("still valid");
    expect(described.message).toContain("Retry");
  });

  it("classifies a 403 lacking the repo scope as a reconnectable grant problem", () => {
    const refusal = classifyGithubRefusal(
      403,
      headers({ "x-oauth-scopes": "gist, read:user" }),
    );
    expect(refusal.failureClass).toBe("missing_scope");
    expect(refusal.missingScopes).toEqual(["repo"]);
    const described = describeGithubRefusal(refusal, 403)!;
    expect(described.kind).toBe("auth");
    expect(described.message).toContain("repo");
  });

  it("classifies a plain 403 as repository/org authorization — reconnecting will not fix it", () => {
    const refusal = classifyGithubRefusal(403, headers({}));
    expect(refusal.failureClass).toBe("forbidden");
    const described = describeGithubRefusal(refusal, 403)!;
    expect(described.kind).toBe("failed");
    expect(described.message).toContain("Reconnecting alone will not fix this");
    expect(described.message).not.toContain("expired");
  });

  it("classifies a 5xx as a temporary GitHub outage", () => {
    const refusal = classifyGithubRefusal(502, headers({}));
    expect(refusal.failureClass).toBe("server_error");
    const described = describeGithubRefusal(refusal, 502)!;
    expect(described.kind).toBe("failed");
    expect(described.message).toContain("temporary");
    expect(described.message).toContain("nothing is wrong with the stored connection");
  });

  it("drops an unsafe request id instead of echoing it", () => {
    const refusal = classifyGithubRefusal(
      401,
      headers({ "x-github-request-id": "bad id <script>alert(1)</script>" }),
    );
    expect(refusal.requestId).toBeNull();
  });
});

describe("task execution failure mapping", () => {
  it("maps a 401 to a specific revoked-token auth outcome with safe correlation", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    githubState.handler = () => ({
      status: 401,
      body: { message: "Bad credentials" },
      headers: { "x-github-request-id": "C0DE:12:34" },
    });
    const outcome = await executeOperation(
      findOperation("github.list_repos")!,
      {},
      { actionId: "act-gh-1", workspaceId },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("auth");
      expect(outcome.message).toContain("revoked or reset");
      expect(outcome.message).toContain("C0DE:12:34");
      expect(outcome.message).not.toContain(TEST_TOKEN);
    }
    // The structured log carries correlation ids and the failure class —
    // and never the token.
    const call = warnSpy.mock.calls.find(
      ([fields]) =>
        typeof fields === "object" &&
        fields !== null &&
        (fields as Record<string, unknown>).component === "github_api",
    );
    expect(call).toBeDefined();
    const fields = call![0] as Record<string, unknown>;
    expect(fields.workspaceId).toBe(workspaceId);
    expect(fields.actionId).toBe("act-gh-1");
    expect(fields.failureClass).toBe("invalid_token");
    expect(fields.githubRequestId).toBe("C0DE:12:34");
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(TEST_TOKEN);
  });

  it("maps an exhausted rate limit to a retry-later failure, not a reconnect demand", async () => {
    githubState.handler = () => ({
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-remaining": "0" },
    });
    const outcome = await executeOperation(
      findOperation("github.list_repos")!,
      {},
      { actionId: null, workspaceId },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("failed");
      expect(outcome.message).toContain("rate-limiting");
      expect(outcome.message).toContain("still valid");
    }
  });

  it("maps a plain 403 to a repository-authorization failure without claiming expiration", async () => {
    githubState.handler = () => ({
      status: 403,
      body: { message: "Resource not accessible by integration" },
    });
    const outcome = await executeOperation(
      findOperation("github.read_file")!,
      { owner: "x", repo: "y", path: "README.md" },
      { actionId: null, workspaceId },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("failed");
      expect(outcome.message).toContain("repository");
      expect(outcome.message).not.toContain("expired");
    }
  });

  it("keeps an unreachable GitHub as a transient failure", async () => {
    githubState.handler = null; // stub throws → network failure
    const outcome = await executeOperation(
      findOperation("github.list_repos")!,
      {},
      { actionId: null, workspaceId },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("failed");
  });

  it("logs a secret-free diagnostic when the stored credential cannot be decrypted", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    await db
      .update(githubAccountsTable)
      .set({ accessTokenEnc: "v1.not-a-real-ciphertext" })
      .where(eq(githubAccountsTable.workspaceId, workspaceId));
    await expect(githubAccessToken(workspaceId)).rejects.toThrow();
    const call = errorSpy.mock.calls.find(
      ([fields]) =>
        typeof fields === "object" &&
        fields !== null &&
        (fields as Record<string, unknown>).failureClass ===
          "credential_unreadable",
    );
    expect(call).toBeDefined();
    expect((call![0] as Record<string, unknown>).workspaceId).toBe(workspaceId);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TEST_TOKEN);
  });
});

describe("connection health check and status", () => {
  it("reports connected when GitHub accepts the token with the repo scope", async () => {
    githubState.handler = () => ({
      status: 200,
      body: { login: "conn-tester" },
      headers: { "x-oauth-scopes": "repo, read:user" },
    });
    const status = await connectionStatus("github", workspaceId);
    expect(status.status).toBe("connected");
    expect(status.accountLabel).toBe("conn-tester");
  });

  it("surfaces a revoked token as needing reconnection, not as connected", async () => {
    githubState.handler = () => ({
      status: 401,
      body: { message: "Bad credentials" },
      headers: { "x-github-request-id": "DEAD:1" },
    });
    const status = await connectionStatus("github", workspaceId);
    expect(status.status).toBe("expired");
    expect(status.detail).toContain("revoked or reset");
    expect(status.detail).toContain("Reconnect GitHub");
    expect(status.detail).not.toContain(TEST_TOKEN);
  });

  it("surfaces live scope loss as needing reconnection", async () => {
    githubState.handler = () => ({
      status: 200,
      body: { login: "conn-tester" },
      headers: { "x-oauth-scopes": "gist" },
    });
    const status = await connectionStatus("github", workspaceId);
    expect(status.status).toBe("expired");
    expect(status.detail).toContain("repo");
  });

  it("treats an unreachable GitHub as unavailable — never as a broken credential", async () => {
    githubState.handler = null; // stub throws → network failure
    const status = await connectionStatus("github", workspaceId);
    expect(status.status).toBe("unavailable");
    expect(status.detail).toContain("usually temporary");
    expect(status.status).not.toBe("expired");
  });

  it("treats an authenticated rate limit as connected (the token provably works)", async () => {
    githubState.handler = () => ({
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-remaining": "0" },
    });
    const status = await connectionStatus("github", workspaceId);
    expect(status.status).toBe("connected");
    expect(status.detail).toContain("rate-limiting");
  });

  it("reports an undecryptable stored credential as reconnect-needed with a config explanation", async () => {
    await db
      .update(githubAccountsTable)
      .set({ accessTokenEnc: "v1.not-a-real-ciphertext" })
      .where(eq(githubAccountsTable.workspaceId, workspaceId));
    const status = await connectionStatus("github", workspaceId);
    expect(status.status).toBe("expired");
    expect(status.detail).toContain("SESSION_SECRET");
    expect(status.detail).toContain("does not need to be recreated");
    // Known-bad locally: GitHub was never called (nothing to send safely).
    expect(githubState.calls).toHaveLength(0);
  });

  it("detects stored missing scopes without a network call", async () => {
    await db
      .update(githubAccountsTable)
      .set({ scopes: "gist" })
      .where(eq(githubAccountsTable.workspaceId, workspaceId));
    const health = await checkGithubConnectionHealth(workspaceId);
    expect(health.state).toBe("reconnect_required");
    if (health.state === "reconnect_required") {
      expect(health.reason).toBe("missing_scope");
    }
    expect(githubState.calls).toHaveLength(0);
  });

  it("caches a verification briefly and re-verifies after cache invalidation", async () => {
    githubState.handler = () => ({
      status: 200,
      body: { login: "conn-tester" },
      headers: { "x-oauth-scopes": "repo" },
    });
    await checkGithubConnectionHealth(workspaceId);
    await checkGithubConnectionHealth(workspaceId);
    expect(githubState.calls).toHaveLength(1);

    // A revoked verdict does not linger once the cache is invalidated (a
    // reconnect clears it the same way) and the next check sees GitHub's
    // current answer.
    clearGithubHealthCache();
    githubState.handler = () => ({
      status: 401,
      body: { message: "Bad credentials" },
    });
    const bad = await checkGithubConnectionHealth(workspaceId);
    expect(bad.state).toBe("reconnect_required");
    clearGithubHealthCache();
    githubState.handler = () => ({
      status: 200,
      body: { login: "conn-tester" },
      headers: { "x-oauth-scopes": "repo" },
    });
    const good = await checkGithubConnectionHealth(workspaceId);
    expect(good.state).toBe("connected");
  });

  it("reports a workspace without a stored credential as not connected", async () => {
    const [stranger] = await db
      .insert(workspacesTable)
      .values({ clerkUserId: `github-conn-test-none-${Date.now()}` })
      .returning();
    try {
      const status = await connectionStatus("github", stranger.id);
      expect(status.status).toBe("not_connected");
      expect(githubState.calls).toHaveLength(0);
    } finally {
      await db.delete(workspacesTable).where(eq(workspacesTable.id, stranger.id));
    }
  });
});

describe("startup credential decryptability diagnostic", () => {
  it("names the workspace whose credential no longer decrypts, without leaking material", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    await db
      .update(githubAccountsTable)
      .set({ accessTokenEnc: "v1.not-a-real-ciphertext" })
      .where(eq(githubAccountsTable.workspaceId, workspaceId));
    const result = await logGithubCredentialStartupHealth();
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.unreadable).toBeGreaterThanOrEqual(1);
    const call = errorSpy.mock.calls.find(
      ([fields]) =>
        typeof fields === "object" &&
        fields !== null &&
        (fields as Record<string, unknown>).workspaceId === workspaceId,
    );
    expect(call).toBeDefined();
    expect((call![0] as Record<string, unknown>).failureClass).toBe(
      "encryption_key_mismatch",
    );
    expect(String(call![1])).toContain("reconnect GitHub");
    expect(String(call![1])).toContain("NOT required");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TEST_TOKEN);
  });

  it("passes cleanly when every credential decrypts with the current secret", async () => {
    const result = await logGithubCredentialStartupHealth();
    expect(result.checked).toBeGreaterThanOrEqual(1);
    // Other dev rows may exist; ours must not be counted unreadable.
    const errorSpy = vi.spyOn(logger, "error");
    await logGithubCredentialStartupHealth();
    const ours = errorSpy.mock.calls.find(
      ([fields]) =>
        typeof fields === "object" &&
        fields !== null &&
        (fields as Record<string, unknown>).workspaceId === workspaceId,
    );
    expect(ours).toBeUndefined();
  });
});
