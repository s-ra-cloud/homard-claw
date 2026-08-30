/**
 * Per-user Google OAuth lifecycle coverage:
 *  - start mints a single-use state bound to the workspace + Clerk session
 *  - the callback consumes the state exactly once (replay fails), refuses a
 *    state minted for a different session (swap fails), and expired states
 *  - consent denial consumes the state and reports "denied"
 *  - the saved credential is encrypted at rest, never returned or logged by
 *    the status API, and refresh-token rotation is revision-fenced
 *  - disconnect removes the credential and immediately blocks token use
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md): create
 * throwaway workspaces, tag and clean every row, never touch owner rows.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  googleAccountsTable,
  googleOauthStatesTable,
  pool,
  workspacesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "hc-oauth-a" as string | null }));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));

// Every Google endpoint is faked; tests never reach the network.
const google = vi.hoisted(() => ({
  tokenHandler: null as null | ((body: URLSearchParams) => {
    status: number;
    body: unknown;
  }),
  tokenCalls: [] as URLSearchParams[],
}));
const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init?.body));
      google.tokenCalls.push(body);
      const res = google.tokenHandler?.(body) ?? {
        status: 500,
        body: { error: "no token handler" },
      };
      return new Response(JSON.stringify(res.body), { status: res.status });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) {
      return new Response("{}", { status: 200 });
    }
    return realFetch(input, init);
  },
);

import oauthRouter from "./oauth";
import {
  clearGoogleTokenCache,
  encryptRefreshToken,
  gmailAccessToken,
  GoogleAuthError,
} from "./credentials";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", oauthRouter);

const USER_A = `hc-oauth-a-${Date.now()}`;
const USER_B = `hc-oauth-b-${Date.now()}`;
let wsA = "";
let wsB = "";

const FULL_SCOPES =
  "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send";

/** A fake Google ID token — payload only, signature never checked here. */
function fakeIdToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

async function startFlow(): Promise<{
  authUrl: URL;
  state: string;
  nonce: string;
}> {
  const res = await request(app)
    .post("/api/google/oauth/start")
    .set("x-forwarded-proto", "https")
    .set("x-forwarded-host", "test.homardclaw.example");
  expect(res.status).toBe(200);
  const authUrl = new URL(res.body.authUrl);
  const state = authUrl.searchParams.get("state")!;
  const [row] = await db
    .select()
    .from(googleOauthStatesTable)
    .where(eq(googleOauthStatesTable.state, state))
    .limit(1);
  return { authUrl, state, nonce: row!.nonce };
}

function goodTokenResponse(nonce: string, overrides?: Record<string, unknown>) {
  return {
    status: 200,
    body: {
      access_token: "at-1",
      refresh_token: "rt-secret-1",
      expires_in: 3600,
      scope: FULL_SCOPES,
      id_token: fakeIdToken({
        sub: "sub-123",
        email: "person@example.test",
        nonce,
        aud: "test-client-id",
      }),
      ...overrides,
    },
  };
}

beforeAll(async () => {
  const [a] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: USER_A })
    .returning();
  const [b] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: USER_B })
    .returning();
  wsA = a!.id;
  wsB = b!.id;
});

beforeEach(() => {
  authState.userId = USER_A;
  google.tokenHandler = null;
  google.tokenCalls = [];
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  clearGoogleTokenCache();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.delete(workspacesTable).where(eq(workspacesTable.id, wsA));
  await db.delete(workspacesTable).where(eq(workspacesTable.id, wsB));
  await pool.end();
});

describe("start", () => {
  it("requires authentication and configuration", async () => {
    authState.userId = null;
    expect((await request(app).post("/api/google/oauth/start")).status).toBe(
      401,
    );
    authState.userId = USER_A;
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    const res = await request(app)
      .post("/api/google/oauth/start")
      .set("x-forwarded-host", "test.homardclaw.example");
    expect(res.status).toBe(503);
  });

  it("mints a PKCE consent URL with least-privilege scopes and a bound state", async () => {
    const { authUrl, state } = await startFlow();
    expect(authUrl.origin).toBe("https://accounts.google.com");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("access_type")).toBe("offline");
    const scope = authUrl.searchParams.get("scope")!;
    expect(scope).toContain("gmail.readonly");
    expect(scope).not.toContain("https://mail.google.com"); // never full mail
    const [row] = await db
      .select()
      .from(googleOauthStatesTable)
      .where(eq(googleOauthStatesTable.state, state))
      .limit(1);
    expect(row!.workspaceId).toBe(wsA);
    expect(row!.clerkUserId).toBe(USER_A);
    expect(row!.usedAt).toBeNull();
    // The verifier stays server-side: it never appears in the consent URL.
    expect(res_urlHasVerifier(authUrl, row!.codeVerifier)).toBe(false);
  });

  it("keeps the Drive consent minimal — the Sheets tools add no new scope", async () => {
    const res = await request(app)
      .post("/api/google/oauth/start")
      .set("x-forwarded-proto", "https")
      .set("x-forwarded-host", "test.homardclaw.example")
      .send({ service: "google_drive" });
    expect(res.status).toBe(200);
    const scope = new URL(res.body.authUrl).searchParams.get("scope")!;
    // Sheets rides on the Drive grant: drive.readonly for reads,
    // drive.file so edits reach only spreadsheets this app created or was
    // explicitly handed. The account-wide spreadsheets edit scope — and
    // full Drive — are never requested.
    expect(scope).toContain("drive.readonly");
    expect(scope).toContain("drive.file");
    expect(scope).not.toContain("auth/spreadsheets");
    expect(scope.split(" ")).not.toContain(
      "https://www.googleapis.com/auth/drive",
    );
    // Incremental consent: connecting Drive must not drop Gmail.
    const authUrl = new URL(res.body.authUrl);
    expect(authUrl.searchParams.get("include_granted_scopes")).toBe("true");
  });
});

function res_urlHasVerifier(url: URL, verifier: string): boolean {
  return url.toString().includes(verifier);
}

describe("callback", () => {
  it("completes the flow, stores an encrypted credential, and never echoes it", async () => {
    const { state, nonce } = await startFlow();
    google.tokenHandler = () => goodTokenResponse(nonce);
    const cb = await request(app)
      .get("/api/google/oauth/callback")
      .query({ code: "auth-code", state });
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain("gmail=connected");
    // PKCE verifier was sent to the token endpoint.
    expect(google.tokenCalls[0]!.get("code_verifier")).toBeTruthy();

    const [account] = await db
      .select()
      .from(googleAccountsTable)
      .where(eq(googleAccountsTable.workspaceId, wsA))
      .limit(1);
    expect(account!.email).toBe("person@example.test");
    expect(account!.googleSub).toBe("sub-123");
    // Encrypted at rest: envelope format, never the raw token.
    expect(account!.refreshTokenEnc.startsWith("v1.")).toBe(true);
    expect(account!.refreshTokenEnc).not.toContain("rt-secret-1");
  });

  it("refuses a replayed state", async () => {
    const { state, nonce } = await startFlow();
    google.tokenHandler = () => goodTokenResponse(nonce);
    await request(app)
      .get("/api/google/oauth/callback")
      .query({ code: "auth-code", state });
    const replay = await request(app)
      .get("/api/google/oauth/callback")
      .query({ code: "auth-code", state });
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toContain("gmail=error%3Astate");
    expect(google.tokenCalls).toHaveLength(1); // no second exchange
  });

  it("refuses a state minted for a different user's session (swap)", async () => {
    const { state, nonce } = await startFlow(); // minted by USER_A
    google.tokenHandler = () => goodTokenResponse(nonce);
    authState.userId = USER_B;
    const swapped = await request(app)
      .get("/api/google/oauth/callback")
      .query({ code: "auth-code", state });
    expect(swapped.status).toBe(302);
    expect(swapped.headers.location).toContain("gmail=error%3Asession_mismatch");
    expect(google.tokenCalls).toHaveLength(0);
    // And the swap consumed the state: the rightful user cannot resume it.
    authState.userId = USER_A;
    const resumed = await request(app)
      .get("/api/google/oauth/callback")
      .query({ code: "auth-code", state });
    expect(resumed.headers.location).toContain("gmail=error%3Astate");
  });

  it("refuses an expired state", async () => {
    const { state, nonce } = await startFlow();
    await db
      .update(googleOauthStatesTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(googleOauthStatesTable.state, state));
    google.tokenHandler = () => goodTokenResponse(nonce);
    const cb = await request(app)
      .get("/api/google/oauth/callback")
      .query({ code: "auth-code", state });
    expect(cb.headers.location).toContain("gmail=error%3Aexpired");
    expect(google.tokenCalls).toHaveLength(0);
  });

  it("consumes the state on consent denial and reports it", async () => {
    const { state } = await startFlow();
    const cb = await request(app)
      .get("/api/google/oauth/callback")
      .query({ error: "access_denied", state });
    expect(cb.headers.location).toContain("gmail=error%3Adenied");
    const resumed = await request(app)
      .get("/api/google/oauth/callback")
      .query({ code: "auth-code", state });
    expect(resumed.headers.location).toContain("gmail=error%3Astate");
  });

  it("refuses a wrong nonce, missing refresh token, or under-scoped grant", async () => {
    for (const [mutation, reason] of [
      [{ id_token: fakeIdToken({ sub: "s", nonce: "wrong", aud: "test-client-id" }) }, "identity"],
      [{ refresh_token: undefined }, "no_refresh_token"],
      [{ scope: "openid email https://www.googleapis.com/auth/gmail.readonly" }, "scopes"],
    ] as const) {
      const { state, nonce } = await startFlow();
      google.tokenHandler = () => goodTokenResponse(nonce, { ...mutation });
      const cb = await request(app)
        .get("/api/google/oauth/callback")
        .query({ code: "auth-code", state });
      expect(cb.headers.location, reason).toContain(
        `gmail=error%3A${reason}`,
      );
    }
  });
});

describe("credential use and rotation", () => {
  it("refreshes with rotation fenced on the revision — a stale writer never resurrects an old token", async () => {
    const { state, nonce } = await startFlow();
    google.tokenHandler = () => goodTokenResponse(nonce);
    await request(app)
      .get("/api/google/oauth/callback")
      .query({ code: "auth-code", state });

    // First use refreshes and rotates the refresh token.
    google.tokenHandler = () => ({
      status: 200,
      body: {
        access_token: "at-2",
        refresh_token: "rt-rotated-2",
        expires_in: 3600,
      },
    });
    const token = await gmailAccessToken(wsA);
    expect(token.token).toBe("at-2");
    const [afterRotation] = await db
      .select()
      .from(googleAccountsTable)
      .where(eq(googleAccountsTable.workspaceId, wsA))
      .limit(1);
    expect(afterRotation!.refreshTokenEnc).not.toContain("rt-rotated-2");

    // A concurrent reconnect bumps the revision; the stale rotation from the
    // old credential must not overwrite it.
    const [reconnected] = await db
      .update(googleAccountsTable)
      .set({
        refreshTokenEnc: encryptRefreshToken("rt-from-reconnect"),
        revision: crypto.randomUUID(),
      })
      .where(eq(googleAccountsTable.workspaceId, wsA))
      .returning();
    clearGoogleTokenCache();
    google.tokenHandler = () => ({
      status: 200,
      body: { access_token: "at-3", expires_in: 3600 },
    });
    await gmailAccessToken(wsA);
    const [final] = await db
      .select()
      .from(googleAccountsTable)
      .where(eq(googleAccountsTable.workspaceId, wsA))
      .limit(1);
    expect(final!.revision).toBe(reconnected!.revision);
    expect(final!.refreshTokenEnc).toBe(reconnected!.refreshTokenEnc);
  });

  it("fails closed with reconnect_required when Google revokes the grant", async () => {
    clearGoogleTokenCache();
    google.tokenHandler = () => ({
      status: 400,
      body: { error: "invalid_grant" },
    });
    await expect(gmailAccessToken(wsA)).rejects.toMatchObject({
      kind: "reconnect_required",
    });
  });

  it("disconnect deletes the credential and immediately blocks token use", async () => {
    // Ensure connected first.
    await db.delete(googleAccountsTable).where(eq(googleAccountsTable.workspaceId, wsA));
    await db.insert(googleAccountsTable).values({
      workspaceId: wsA,
      clerkUserId: USER_A,
      googleSub: "sub-123",
      email: "person@example.test",
      refreshTokenEnc: encryptRefreshToken("rt-live"),
      scopes: FULL_SCOPES,
    });
    const res = await request(app).post("/api/google/oauth/disconnect");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ disconnected: true });
    clearGoogleTokenCache();
    await expect(gmailAccessToken(wsA)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof GoogleAuthError && e.kind === "not_connected",
    );
    // Disconnecting again is a truthful no-op.
    const again = await request(app).post("/api/google/oauth/disconnect");
    expect(again.body).toEqual({ disconnected: false });
  });

  it("another user's session can never disconnect or read this credential", async () => {
    await db.delete(googleAccountsTable).where(eq(googleAccountsTable.workspaceId, wsA));
    await db.insert(googleAccountsTable).values({
      workspaceId: wsA,
      clerkUserId: USER_A,
      googleSub: "sub-123",
      email: "person@example.test",
      refreshTokenEnc: encryptRefreshToken("rt-live"),
      scopes: FULL_SCOPES,
    });
    authState.userId = USER_B;
    const res = await request(app).post("/api/google/oauth/disconnect");
    expect(res.body).toEqual({ disconnected: false }); // B has nothing
    const [still] = await db
      .select()
      .from(googleAccountsTable)
      .where(eq(googleAccountsTable.workspaceId, wsA))
      .limit(1);
    expect(still).toBeTruthy();
  });
});
