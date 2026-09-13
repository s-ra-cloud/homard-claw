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
  db,
  googleAccountsTable,
  pool,
  workspacesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  DRIVE_SCOPES,
  clearGoogleTokenCache,
  driveAccessToken,
  encryptRefreshToken,
} from "./credentials";

const fetchState = vi.hoisted(() => ({
  handler: null as
    | null
    | ((
        input: string | URL | Request,
        init?: RequestInit,
      ) => Promise<Response>),
}));

vi.stubGlobal(
  "fetch",
  (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (fetchState.handler) return fetchState.handler(input, init);
    return Promise.reject(new Error("test fetch handler was not installed"));
  },
);

const USER_ID = `hc-google-credentials-${Date.now()}`;
let workspaceId = "";

async function installAccount(): Promise<void> {
  await db.delete(googleAccountsTable).where(eq(googleAccountsTable.workspaceId, workspaceId));
  await db.insert(googleAccountsTable).values({
    workspaceId,
    clerkUserId: USER_ID,
    googleSub: "google-sub-credentials",
    email: "credentials@example.test",
    refreshTokenEnc: encryptRefreshToken("refresh-token-for-tests"),
    scopes: DRIVE_SCOPES.join(" "),
  });
}

beforeAll(async () => {
  const [workspace] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: USER_ID })
    .returning({ id: workspacesTable.id });
  workspaceId = workspace.id;
});

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "google-credentials-test-secret");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "google-test-client");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-test-secret");
  clearGoogleTokenCache();
  fetchState.handler = async () =>
    new Response(
      JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
      { status: 200 },
    );
  await installAccount();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  await pool.end();
});

describe("bounded Drive credential refresh", () => {
  it("aborts a hanging refresh on caller cancellation and reports safe stages", async () => {
    let requestSignal: AbortSignal | undefined;
    let rejectRequest!: (error: unknown) => void;
    const requestStarted = new Promise<void>((resolve) => {
      fetchState.handler = (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        requestSignal?.addEventListener("abort", () => {
          rejectRequest(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
        resolve();
        return new Promise<Response>((_resolve, reject) => {
          rejectRequest = reject;
        });
      };
    });
    const controller = new AbortController();
    const stages: string[] = [];
    const token = driveAccessToken(workspaceId, {
      signal: controller.signal,
      onStage: (stage) => stages.push(stage),
    });

    await requestStarted;
    controller.abort();
    await expect(token).rejects.toMatchObject({
      kind: "unavailable",
      classification: "cancelled",
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(stages).toEqual(["credential", "refresh"]);
  });

  it("bounds a hanging response body and does not expose provider text", async () => {
    const providerSecret = "provider-body-secret";
    fetchState.handler = async () =>
      ({
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => {}),
      }) as Response;

    await expect(
      driveAccessToken(workspaceId, {
        deadlineAt: Date.now() + 20,
      }),
    ).rejects.toMatchObject({
      kind: "unavailable",
      classification: "timeout",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    clearGoogleTokenCache();
    fetchState.handler = async () =>
      new Response(JSON.stringify({ error: providerSecret }), { status: 503 });
    const failure = await driveAccessToken(workspaceId).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      kind: "unavailable",
      classification: "provider_refused",
      status: 503,
    });
    expect((failure as Error).message).not.toContain(providerSecret);
  });

  it("keeps a shared refresh alive when one caller cancels", async () => {
    let requestSignal: AbortSignal | undefined;
    let resolveResponse!: (response: Response) => void;
    const requestStarted = new Promise<void>((resolve) => {
      fetchState.handler = (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        resolve();
        return new Promise<Response>((response) => {
          resolveResponse = response;
        });
      };
    });
    const firstController = new AbortController();
    let secondStageResolve!: () => void;
    const secondStage = new Promise<void>((resolve) => {
      // The resolver is installed by the second caller's stage callback
      // below; this promise only gives that caller a deterministic point
      // before the first is cancelled.
      secondStageResolve = resolve;
    });
    const firstStages: string[] = [];
    const first = driveAccessToken(workspaceId, {
      signal: firstController.signal,
      onStage: (stage) => firstStages.push(stage),
    });
    await requestStarted;
    const second = driveAccessToken(workspaceId, {
      onStage: (stage) => {
        if (stage === "refresh") {
          secondStageResolve();
        }
      },
    });
    await secondStage;
    firstController.abort();
    await expect(first).rejects.toMatchObject({ classification: "cancelled" });
    expect(requestSignal?.aborted).toBe(false);
    resolveResponse(
      new Response(
        JSON.stringify({ access_token: "shared-access-token", expires_in: 3600 }),
        { status: 200 },
      ),
    );
    await expect(second).resolves.toMatchObject({
      token: "shared-access-token",
    });
    expect(firstStages).toContain("refresh");
  });
});