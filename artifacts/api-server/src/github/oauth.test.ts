/**
 * GitHub OAuth route coverage for reconnect de-duplication.
 *
 * Repeated starts/callbacks must never mint a burst of tokens: GitHub limits
 * one user/app/scope combination to ten tokens and revokes existing tokens
 * once that pool overflows.
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
  auditEventsTable,
  db,
  githubAccountsTable,
  githubOauthStatesTable,
  pool,
  workspacesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

const USER_ID = `github-oauth-burst-${Date.now()}`;
const authState = vi.hoisted(() => ({ userId: null as string | null }));
const github = vi.hoisted(() => ({
  tokenCalls: 0,
  userCalls: 0,
  tokenGate: null as Promise<void> | null,
  tokenEntered: null as (() => void) | null,
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      github.tokenCalls += 1;
      github.tokenEntered?.();
      if (github.tokenGate) await github.tokenGate;
      return new Response(
        JSON.stringify({
          access_token: `gho_burst_test_${github.tokenCalls}`,
          scope: "repo",
        }),
        { status: 200 },
      );
    }
    if (url === "https://api.github.com/user") {
      github.userCalls += 1;
      return new Response(
        JSON.stringify({ id: 263569102, login: "oauth-burst-test" }),
        { status: 200 },
      );
    }
    return realFetch(input);
  },
);

import oauthRouter from "./oauth";

const app = express();
app.use(express.json());
app.use("/api", oauthRouter);

let workspaceId = "";

function startRequest() {
  return request(app)
    .post("/api/github/oauth/start")
    .set("x-forwarded-proto", "https")
    .set("x-forwarded-host", "test.homardclaw.example");
}

beforeAll(async () => {
  const [workspace] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: USER_ID })
    .returning();
  workspaceId = workspace.id;
});

beforeEach(async () => {
  authState.userId = USER_ID;
  github.tokenCalls = 0;
  github.userCalls = 0;
  github.tokenGate = null;
  github.tokenEntered = null;
  vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "github-oauth-burst-client");
  vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "github-oauth-burst-secret");
  vi.stubEnv("SESSION_SECRET", "github-oauth-burst-session-secret-32-bytes");
  await db
    .delete(githubOauthStatesTable)
    .where(eq(githubOauthStatesTable.workspaceId, workspaceId));
  await db
    .delete(githubAccountsTable)
    .where(eq(githubAccountsTable.workspaceId, workspaceId));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  await pool.end();
});

describe("GitHub OAuth reconnect de-duplication", () => {
  it("shares one state across concurrent start requests and exchanges it once", async () => {
    const [first, second] = await Promise.all([startRequest(), startRequest()]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstState = new URL(first.body.authUrl).searchParams.get("state");
    const secondState = new URL(second.body.authUrl).searchParams.get("state");
    expect(firstState).toBeTruthy();
    expect(secondState).toBe(firstState);

    const [callbackA, callbackB] = await Promise.all([
      request(app)
        .get("/api/github/oauth/callback")
        .query({ state: firstState, code: "code-a" }),
      request(app)
        .get("/api/github/oauth/callback")
        .query({ state: firstState, code: "code-b" }),
    ]);
    expect([callbackA.status, callbackB.status]).toEqual([302, 302]);
    expect(github.tokenCalls).toBe(1);
    expect(github.userCalls).toBe(1);
    expect(
      [callbackA.headers.location, callbackB.headers.location].filter((url) =>
        String(url).includes("github=connected"),
      ),
    ).toHaveLength(1);
  });

  it("refuses a redundant start immediately after a successful connection", async () => {
    const start = await startRequest();
    const state = new URL(start.body.authUrl).searchParams.get("state");
    const callback = await request(app)
      .get("/api/github/oauth/callback")
      .query({ state, code: "code-a" });
    expect(callback.headers.location).toContain("github=connected");

    const redundant = await startRequest();
    expect(redundant.status).toBe(409);
    expect(redundant.body.error).toContain("connected moments ago");
    expect(github.tokenCalls).toBe(1);
  });

  it("lets only one of two distinct concurrent states exchange a token", async () => {
    const sameMillisecond = new Date();
    await db.insert(githubOauthStatesTable).values([
      {
        state: "distinct-state-a",
        workspaceId,
        clerkUserId: USER_ID,
        redirectUri:
          "https://test.homardclaw.example/api/github/oauth/callback",
        createdAt: sameMillisecond,
        expiresAt: new Date(sameMillisecond.getTime() + 60_000),
      },
      {
        state: "distinct-state-b",
        workspaceId,
        clerkUserId: USER_ID,
        redirectUri:
          "https://test.homardclaw.example/api/github/oauth/callback",
        createdAt: sameMillisecond,
        expiresAt: new Date(sameMillisecond.getTime() + 60_000),
      },
    ]);
    const auditsBefore = await db
      .select({ id: auditEventsTable.id })
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.workspaceId, workspaceId),
          eq(auditEventsTable.kind, "connected_app.github_connected"),
        ),
      );
    let releaseToken!: () => void;
    github.tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    let tokenEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      tokenEntered = resolve;
    });
    github.tokenEntered = tokenEntered;

    const callbacks = Promise.all([
      request(app)
        .get("/api/github/oauth/callback")
        .query({ state: "distinct-state-a", code: "code-a" }),
      request(app)
        .get("/api/github/oauth/callback")
        .query({ state: "distinct-state-b", code: "code-b" }),
    ]);
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(github.tokenCalls).toBe(1);
    releaseToken();
    const outcomes = await callbacks;
    expect(outcomes.every((response) => response.status === 302)).toBe(true);
    expect(github.tokenCalls).toBe(1);
    expect(github.userCalls).toBe(1);

    const auditsAfter = await db
      .select({ id: auditEventsTable.id })
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.workspaceId, workspaceId),
          eq(auditEventsTable.kind, "connected_app.github_connected"),
        ),
      );
    expect(auditsAfter).toHaveLength(auditsBefore.length + 1);
  });
});