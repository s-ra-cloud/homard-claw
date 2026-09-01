/**
 * Coverage for GitHub App installation authentication ("stop GitHub access
 * from expiring"):
 *  - installation tokens are minted on demand, cached until shortly before
 *    expiry, and refreshed automatically; concurrent callers share ONE mint
 *  - an installation-token 401 during an action is retried exactly once
 *    with a freshly minted token; a second 401 is reported truthfully
 *  - a removed installation is reconnect_required ("reinstall"), an
 *    app-credential problem is unavailable (server config), an outage stays
 *    transient — never a false "broken"
 *  - workspaces without an installation keep using their legacy OAuth
 *    token, untouched
 *  - setup binding verifies the installation with GitHub and refuses an
 *    installation already claimed by another workspace
 *  - no log line or owner-facing message ever contains a minted token or
 *    the private key
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md): all
 * provider traffic goes through a stubbed global fetch — never the network;
 * tag and clean up all created rows; never clobber the live owner rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  db,
  githubAccountsTable,
  githubInstallationsTable,
  pool,
  workspacesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const MINTED_TOKEN = "ghs_test-minted-installation-token";
const OAUTH_TOKEN = "gho_test-legacy-oauth-token";
const INSTALLATION_ID = "424242";

type StubResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

const githubState = vi.hoisted(() => ({
  calls: [] as { path: string; method: string; auth: string }[],
  handler: null as
    | null
    | ((call: { path: string; method: string; auth: string }) =>
        | StubResponse
        | Promise<StubResponse>
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
    const authHeader = String(
      (init?.headers as Record<string, string> | undefined)?.Authorization ??
        "",
    );
    const call = {
      path: url.slice(base.length),
      method: init?.method ?? "GET",
      // "jwt" (app-signed) vs the concrete bearer token, so tests can
      // assert which identity was used without echoing key material.
      auth: authHeader.includes(".") ? "jwt" : authHeader.replace("Bearer ", ""),
    };
    githubState.calls.push(call);
    if (!githubState.handler) {
      throw new TypeError("fetch failed (no handler installed)");
    }
    const res = await githubState.handler(call);
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
  githubAuth,
  githubAuthMethod,
  recoverPersonalGithubAppBinding,
} from "./credentials";
import {
  clearGithubInstallationTokenCache,
  fetchInstallation,
  githubAppConfig,
  githubInstallationToken,
  invalidateGithubInstallationToken,
} from "./app-auth";
import { completeInstallationSetup } from "./install";
import { logger } from "../lib/logger";

let appWorkspaceId: string; // installation-backed
let oauthWorkspaceId: string; // legacy OAuth only
const savedEnv: Record<string, string | undefined> = {};

/** GitHub's happy-path responses for this suite's installation. */
function happyHandler(overrides?: {
  mint?: (call: { path: string }) => { status: number; body: unknown } | null;
  api?: (call: { path: string; method: string; auth: string }) =>
    | { status: number; body: unknown; headers?: Record<string, string> }
    | null;
}) {
  return (call: { path: string; method: string; auth: string }) => {
    if (call.path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      const custom = overrides?.mint?.(call);
      if (custom) return custom;
      return {
        status: 201,
        body: {
          token: MINTED_TOKEN,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      };
    }
    if (call.path === `/app/installations/${INSTALLATION_ID}`) {
      return {
        status: 200,
        body: {
          id: Number(INSTALLATION_ID),
          account: { login: "claw-org", type: "Organization" },
          repository_selection: "selected",
          suspended_at: null,
        },
      };
    }
    const custom = overrides?.api?.(call);
    if (custom) return custom;
    return { status: 200, body: [] };
  };
}

beforeAll(async () => {
  for (const key of [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_PEM",
    "GITHUB_APP_PRIVATE_KEY_BASE64",
  ]) {
    savedEnv[key] = process.env[key];
  }
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GITHUB_APP_ID = "31337";
  process.env.GITHUB_APP_SLUG = "homardclaw-test";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();

  const [appWs] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `github-app-test-${Date.now()}` })
    .returning();
  appWorkspaceId = appWs.id;
  await db.insert(githubInstallationsTable).values({
    workspaceId: appWorkspaceId,
    clerkUserId: appWs.clerkUserId,
    installationId: INSTALLATION_ID,
    accountLogin: "claw-org",
    accountType: "Organization",
    repositorySelection: "selected",
  });
  // A leftover OAuth row must NOT be consulted while the installation exists.
  await db.insert(githubAccountsTable).values({
    workspaceId: appWorkspaceId,
    clerkUserId: appWs.clerkUserId,
    githubUserId: "1111",
    login: "legacy-login",
    accessTokenEnc: encryptGithubToken(OAUTH_TOKEN),
    scopes: "repo",
  });

  const [oauthWs] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `github-app-oauth-test-${Date.now()}` })
    .returning();
  oauthWorkspaceId = oauthWs.id;
  await db.insert(githubAccountsTable).values({
    workspaceId: oauthWorkspaceId,
    clerkUserId: oauthWs.clerkUserId,
    githubUserId: "2222",
    login: "oauth-only",
    accessTokenEnc: encryptGithubToken(OAUTH_TOKEN),
    scopes: "repo",
  });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await db
    .delete(workspacesTable)
    .where(eq(workspacesTable.id, appWorkspaceId));
  await db
    .delete(workspacesTable)
    .where(eq(workspacesTable.id, oauthWorkspaceId));
  vi.unstubAllGlobals();
  await pool.end();
});

beforeEach(async () => {
  githubState.calls = [];
  githubState.handler = null;
  clearGithubHealthCache();
  clearGithubInstallationTokenCache();
  vi.restoreAllMocks();
  // Undo any per-test installation mutations.
  await db
    .insert(githubInstallationsTable)
    .values({
      workspaceId: appWorkspaceId,
      clerkUserId: "restored",
      installationId: INSTALLATION_ID,
      accountLogin: "claw-org",
      accountType: "Organization",
      repositorySelection: "selected",
    })
    .onConflictDoUpdate({
      target: githubInstallationsTable.workspaceId,
      set: {
        installationId: INSTALLATION_ID,
        accountLogin: "claw-org",
        accountType: "Organization",
        repositorySelection: "selected",
        updatedAt: new Date(),
      },
    });
});

function mintCalls(): number {
  return githubState.calls.filter((c) =>
    c.path.endsWith("/access_tokens"),
  ).length;
}

describe("installation token minting and caching", () => {
  it("mints once and reuses the cached token until expiry", async () => {
    githubState.handler = happyHandler();
    const first = await githubInstallationToken(appWorkspaceId);
    const second = await githubInstallationToken(appWorkspaceId);
    expect(first?.token).toBe(MINTED_TOKEN);
    expect(second?.token).toBe(MINTED_TOKEN);
    expect(first?.accountLogin).toBe("claw-org");
    expect(mintCalls()).toBe(1);
    // Minting authenticates as the app (JWT), never with a stored token.
    expect(
      githubState.calls.find((c) => c.path.endsWith("/access_tokens"))?.auth,
    ).toBe("jwt");
  });

  it("re-mints when the cached token is about to expire", async () => {
    let minted = 0;
    githubState.handler = happyHandler({
      mint: () => {
        minted += 1;
        return {
          status: 201,
          body: {
            token: `${MINTED_TOKEN}-${minted}`,
            // Inside the 5-minute safety margin ⇒ treated as already stale.
            expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
          },
        };
      },
    });
    await githubInstallationToken(appWorkspaceId);
    await githubInstallationToken(appWorkspaceId);
    expect(mintCalls()).toBe(2);
  });

  it("shares one mint across concurrent callers (single-flight)", async () => {
    githubState.handler = happyHandler();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        githubInstallationToken(appWorkspaceId),
      ),
    );
    expect(new Set(results.map((r) => r?.token)).size).toBe(1);
    expect(mintCalls()).toBe(1);
  });

  it("returns null (OAuth fallback cue) when no installation row exists", async () => {
    githubState.handler = happyHandler();
    expect(await githubInstallationToken(oauthWorkspaceId)).toBeNull();
    expect(githubState.calls.length).toBe(0);
  });
});

describe("lost setup-callback recovery", () => {
  it("repairs an exact personal-account installation after OAuth is revoked and retries once as the app", async () => {
    const RECOVERED_INSTALLATION_ID = "737373";
    githubState.handler = (call) => {
      if (
        call.path === "/repos/oauth-only/demo/issues?state=open&per_page=20" &&
        call.auth === OAUTH_TOKEN
      ) {
        return { status: 401, body: { message: "Bad credentials" } };
      }
      if (call.path === "/app/installations?per_page=100&page=1") {
        return {
          status: 200,
          body: Array.from({ length: 100 }, (_, index) => ({
            id: 600000 + index,
            account: {
              id: 700000 + index,
              login: `foreign-${index}`,
              type: "User",
            },
            repository_selection: "selected",
            suspended_at: null,
          })),
        };
      }
      if (call.path === "/app/installations?per_page=100&page=2") {
        return {
          status: 200,
          body: [
            {
              id: Number(RECOVERED_INSTALLATION_ID),
              account: { id: 2222, login: "oauth-only", type: "User" },
              repository_selection: "selected",
              suspended_at: null,
            },
          ],
        };
      }
      if (
        call.path ===
        `/app/installations/${RECOVERED_INSTALLATION_ID}/access_tokens`
      ) {
        return {
          status: 201,
          body: {
            token: MINTED_TOKEN,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        };
      }
      if (
        call.path === "/repos/oauth-only/demo/issues?state=open&per_page=20" &&
        call.auth === MINTED_TOKEN
      ) {
        return { status: 200, body: [] };
      }
      throw new Error(`unexpected GitHub call: ${call.method} ${call.path}`);
    };

    try {
      const outcome = await executeOperation(
        findOperation("github.list_issues")!,
        { owner: "oauth-only", repo: "demo", state: "open" },
        { actionId: "recover-app-1", workspaceId: oauthWorkspaceId },
      );
      expect(outcome.ok).toBe(true);
      expect(githubState.calls.map((call) => call.auth)).toEqual([
        OAUTH_TOKEN,
        "jwt",
        "jwt",
        "jwt",
        MINTED_TOKEN,
      ]);
      const [binding] = await db
        .select()
        .from(githubInstallationsTable)
        .where(eq(githubInstallationsTable.workspaceId, oauthWorkspaceId))
        .limit(1);
      expect(binding).toMatchObject({
        installationId: RECOVERED_INSTALLATION_ID,
        accountLogin: "oauth-only",
        accountType: "User",
      });
    } finally {
      await db
        .delete(githubInstallationsTable)
        .where(eq(githubInstallationsTable.workspaceId, oauthWorkspaceId));
    }
  });

  it("never binds an organization or a different personal account", async () => {
    githubState.handler = (call) => {
      if (call.path === "/app/installations?per_page=100&page=1") {
        return {
          status: 200,
          body: [
            {
              // Same display login is not enough: organizations are excluded.
              id: 818181,
              account: { id: 2222, login: "oauth-only", type: "Organization" },
              repository_selection: "all",
            },
            {
              // Personal install, but its immutable account id is foreign.
              id: 919191,
              account: { id: 9999, login: "oauth-only", type: "User" },
              repository_selection: "all",
            },
          ],
        };
      }
      throw new Error(`unexpected GitHub call: ${call.method} ${call.path}`);
    };

    expect(
      await recoverPersonalGithubAppBinding(oauthWorkspaceId),
    ).toBe(false);
    const [binding] = await db
      .select()
      .from(githubInstallationsTable)
      .where(eq(githubInstallationsTable.workspaceId, oauthWorkspaceId))
      .limit(1);
    expect(binding).toBeUndefined();
  });
});

describe("combined auth resolution", () => {
  it("prefers the installation even when a legacy OAuth row exists", async () => {
    githubState.handler = happyHandler();
    const auth = await githubAuth(appWorkspaceId);
    expect(auth.source).toBe("installation");
    expect(auth.token).toBe(MINTED_TOKEN);
    expect(auth.login).toBe("claw-org");
    expect(await githubAuthMethod(appWorkspaceId)).toBe("github_app");
  });

  it("falls back to the stored OAuth token when no installation exists", async () => {
    githubState.handler = happyHandler();
    const auth = await githubAuth(oauthWorkspaceId);
    expect(auth.source).toBe("oauth");
    expect(auth.token).toBe(OAUTH_TOKEN);
    expect(await githubAuthMethod(oauthWorkspaceId)).toBe("oauth");
    expect(mintCalls()).toBe(0);
  });

  it("reports a removed installation as reinstall-needed, not as a generic error", async () => {
    githubState.handler = (call) => {
      if (call.path.endsWith("/access_tokens")) {
        return { status: 404, body: { message: "Not Found" } };
      }
      return { status: 200, body: [] };
    };
    await expect(githubAuth(appWorkspaceId)).rejects.toMatchObject({
      kind: "reconnect_required",
    });
    await expect(githubAuth(appWorkspaceId)).rejects.toThrow(/[Rr]einstall/);
  });

  it("keeps an outage transient and a bad app key a server-config problem", async () => {
    githubState.handler = (call) =>
      call.path.endsWith("/access_tokens")
        ? { status: 502, body: "bad gateway" }
        : { status: 200, body: [] };
    await expect(githubAuth(appWorkspaceId)).rejects.toMatchObject({
      kind: "unavailable",
    });
    githubState.handler = (call) =>
      call.path.endsWith("/access_tokens")
        ? { status: 401, body: { message: "Bad JWT" } }
        : { status: 200, body: [] };
    await expect(githubAuth(appWorkspaceId)).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(githubAuth(appWorkspaceId)).rejects.toThrow(
      /app credentials|configuration/,
    );
  });
});

describe("retry-once on an expired installation token", () => {
  it("retries exactly once with a fresh token and succeeds", async () => {
    let minted = 0;
    let apiCalls = 0;
    githubState.handler = (call) => {
      if (call.path.endsWith("/access_tokens")) {
        minted += 1;
        return {
          status: 201,
          body: {
            token: `${MINTED_TOKEN}-${minted}`,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        };
      }
      if (call.path.startsWith("/installation/repositories")) {
        apiCalls += 1;
        // First token is stale (as if it aged out mid-flight).
        if (call.auth === `${MINTED_TOKEN}-1`) {
          return { status: 401, body: { message: "Bad credentials" } };
        }
        return {
          status: 200,
          body: {
            repositories: [
              { full_name: "claw-org/pinchers", private: true },
            ],
          },
        };
      }
      return { status: 200, body: [] };
    };
    const outcome = await executeOperation(
      findOperation("github.list_repos")!,
      {},
      { actionId: "act-app-1", workspaceId: appWorkspaceId },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.summary).toContain("claw-org/pinchers");
    expect(apiCalls).toBe(2);
    expect(minted).toBe(2);
  });

  it("stops after the second 401 with truthful installation-specific guidance", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    let apiCalls = 0;
    githubState.handler = (call) => {
      if (call.path.endsWith("/access_tokens")) {
        return {
          status: 201,
          body: {
            token: MINTED_TOKEN,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        };
      }
      if (call.path.startsWith("/repos/")) {
        apiCalls += 1;
        return {
          status: 401,
          body: { message: "Bad credentials" },
          headers: { "x-github-request-id": "APP1:2:3" },
        };
      }
      return { status: 200, body: [] };
    };
    const outcome = await executeOperation(
      findOperation("github.list_branches")!,
      { owner: "claw-org", repo: "pinchers" },
      { actionId: null, workspaceId: appWorkspaceId },
    );
    expect(apiCalls).toBe(2); // exactly one retry, never a loop
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("auth");
      expect(outcome.message).toContain("refreshed automatically");
      expect(outcome.message).not.toContain("Reconnect GitHub on the Connected Apps page to restore access");
      expect(outcome.message).not.toContain(MINTED_TOKEN);
    }
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(MINTED_TOKEN);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("PRIVATE KEY");
  });

  it("never retries an OAuth 401 (static tokens cannot refresh)", async () => {
    let apiCalls = 0;
    githubState.handler = (call) => {
      if (call.path.startsWith("/user/repos")) {
        apiCalls += 1;
        return { status: 401, body: { message: "Bad credentials" } };
      }
      return { status: 200, body: [] };
    };
    const outcome = await executeOperation(
      findOperation("github.list_repos")!,
      {},
      { actionId: null, workspaceId: oauthWorkspaceId },
    );
    expect(apiCalls).toBe(1);
    expect(outcome.ok).toBe(false);
  });

  it("maps an installation 403 to repository-selection guidance", async () => {
    githubState.handler = happyHandler({
      api: (call) =>
        call.path.startsWith("/repos/")
          ? {
              status: 403,
              body: { message: "Resource not accessible by integration" },
            }
          : null,
    });
    const outcome = await executeOperation(
      findOperation("github.read_file")!,
      { owner: "claw-org", repo: "hidden", path: "README.md" },
      { actionId: null, workspaceId: appWorkspaceId },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("failed");
      expect(outcome.message).toContain("GitHub App installation");
      expect(outcome.message).toContain("repositories selected");
      expect(outcome.message).not.toContain("Reconnecting");
    }
  });
});

describe("installation-aware connection health", () => {
  it("reports a live installation as connected via the app", async () => {
    githubState.handler = happyHandler();
    const health = await checkGithubConnectionHealth(appWorkspaceId);
    expect(health).toMatchObject({
      state: "connected",
      login: "claw-org",
      method: "github_app",
    });
    // Verified as the app — no user-token call involved.
    expect(githubState.calls.every((c) => c.auth === "jwt")).toBe(true);
  });

  it("reports a removed installation as reconnect_required/installation_removed", async () => {
    githubState.handler = (call) =>
      call.path === `/app/installations/${INSTALLATION_ID}`
        ? { status: 404, body: { message: "Not Found" } }
        : { status: 200, body: [] };
    const health = await checkGithubConnectionHealth(appWorkspaceId);
    expect(health).toMatchObject({
      state: "reconnect_required",
      reason: "installation_removed",
      method: "github_app",
    });
    if (health.state === "reconnect_required") {
      expect(health.detail).toContain("Reinstall");
    }
    // Status surface: reconnect-needed shows as "expired" to the UI.
    const status = await connectionStatus("github", appWorkspaceId);
    expect(status.status).toBe("expired");
  });

  it("reports a suspended installation as reconnect_required without breaking anything else", async () => {
    githubState.handler = (call) =>
      call.path === `/app/installations/${INSTALLATION_ID}`
        ? {
            status: 200,
            body: {
              id: Number(INSTALLATION_ID),
              account: { login: "claw-org", type: "Organization" },
              repository_selection: "selected",
              suspended_at: new Date().toISOString(),
            },
          }
        : { status: 200, body: [] };
    const health = await checkGithubConnectionHealth(appWorkspaceId);
    expect(health).toMatchObject({
      state: "reconnect_required",
      reason: "installation_suspended",
    });
  });

  it("keeps a GitHub outage transient instead of flipping the installation to broken", async () => {
    githubState.handler = (call) =>
      call.path === `/app/installations/${INSTALLATION_ID}`
        ? { status: 502, body: "bad gateway" }
        : { status: 200, body: [] };
    const health = await checkGithubConnectionHealth(appWorkspaceId);
    expect(health).toMatchObject({
      state: "unavailable",
      method: "github_app",
    });
    const status = await connectionStatus("github", appWorkspaceId);
    expect(status.status).toBe("unavailable");
  });

  it("still verifies OAuth-only workspaces through the user-token path", async () => {
    githubState.handler = (call) =>
      call.path === "/user"
        ? {
            status: 200,
            body: { login: "oauth-only" },
            headers: { "x-oauth-scopes": "repo" },
          }
        : { status: 200, body: [] };
    const health = await checkGithubConnectionHealth(oauthWorkspaceId);
    expect(health).toMatchObject({
      state: "connected",
      login: "oauth-only",
      method: "oauth",
    });
  });
});

describe("setup binding", () => {
  it("verifies the installation with GitHub and refuses one claimed by another workspace", async () => {
    githubState.handler = happyHandler();
    // The suite's installation is already bound to appWorkspaceId; another
    // workspace presenting the same id must be refused.
    const outcome = await completeInstallationSetup({
      workspaceId: oauthWorkspaceId,
      clerkUserId: "someone-else",
      installationId: INSTALLATION_ID,
    });
    expect(outcome).toEqual({ ok: false, reason: "install_claimed" });
    const [row] = await db
      .select()
      .from(githubInstallationsTable)
      .where(eq(githubInstallationsTable.workspaceId, oauthWorkspaceId))
      .limit(1);
    expect(row).toBeUndefined();
  });

  it("never persists a suspended installation", async () => {
    const SUSPENDED_ID = "555555";
    githubState.handler = (call) =>
      call.path === `/app/installations/${SUSPENDED_ID}`
        ? {
            status: 200,
            body: {
              id: Number(SUSPENDED_ID),
              account: { login: "frozen-org", type: "Organization" },
              repository_selection: "all",
              suspended_at: new Date().toISOString(),
            },
          }
        : { status: 200, body: [] };
    const outcome = await completeInstallationSetup({
      workspaceId: oauthWorkspaceId,
      clerkUserId: "someone",
      installationId: SUSPENDED_ID,
    });
    expect(outcome).toEqual({ ok: false, reason: "install_suspended" });
    const [row] = await db
      .select()
      .from(githubInstallationsTable)
      .where(eq(githubInstallationsTable.workspaceId, oauthWorkspaceId))
      .limit(1);
    expect(row).toBeUndefined();
  });

  it("refuses an installation GitHub does not recognize for this app", async () => {
    githubState.handler = (call) =>
      call.path === "/app/installations/999999"
        ? { status: 404, body: { message: "Not Found" } }
        : { status: 200, body: [] };
    const outcome = await completeInstallationSetup({
      workspaceId: oauthWorkspaceId,
      clerkUserId: "someone",
      installationId: "999999",
    });
    expect(outcome).toEqual({ ok: false, reason: "install_removed" });
  });

  it("updates the existing binding in place (repository-selection change)", async () => {
    githubState.handler = (call) =>
      call.path === `/app/installations/${INSTALLATION_ID}`
        ? {
            status: 200,
            body: {
              id: Number(INSTALLATION_ID),
              account: { login: "claw-org", type: "Organization" },
              repository_selection: "all",
              suspended_at: null,
            },
          }
        : { status: 200, body: [] };
    const [before] = await db
      .select({ clerkUserId: githubInstallationsTable.clerkUserId })
      .from(githubInstallationsTable)
      .where(eq(githubInstallationsTable.workspaceId, appWorkspaceId))
      .limit(1);
    const outcome = await completeInstallationSetup({
      workspaceId: appWorkspaceId,
      clerkUserId: before.clerkUserId,
      installationId: INSTALLATION_ID,
    });
    expect(outcome).toMatchObject({ ok: true, result: "updated" });
    const [row] = await db
      .select()
      .from(githubInstallationsTable)
      .where(eq(githubInstallationsTable.workspaceId, appWorkspaceId))
      .limit(1);
    expect(row.repositorySelection).toBe("all");
  });
});

describe("app identity plumbing", () => {
  it("parses escaped-newline and base64 private keys", async () => {
    const pem = process.env.GITHUB_APP_PRIVATE_KEY!;
    process.env.GITHUB_APP_PRIVATE_KEY = pem.replace(/\n/g, "\\n");
    expect(githubAppConfig()).not.toBeNull();
    process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(pem).toString("base64");
    expect(githubAppConfig()).not.toBeNull();
    process.env.GITHUB_APP_PRIVATE_KEY = pem;
  });

  it("prefers an explicit PEM replacement over a malformed legacy key", () => {
    const pem = process.env.GITHUB_APP_PRIVATE_KEY!;
    process.env.GITHUB_APP_PRIVATE_KEY = "not-a-private-key";
    process.env.GITHUB_APP_PRIVATE_KEY_PEM = pem;
    expect(githubAppConfig()).not.toBeNull();
    delete process.env.GITHUB_APP_PRIVATE_KEY_PEM;
    process.env.GITHUB_APP_PRIVATE_KEY = pem;
  });

  it("treats a partially configured app as a loud config error", async () => {
    const slug = process.env.GITHUB_APP_SLUG!;
    delete process.env.GITHUB_APP_SLUG;
    expect(() => githubAppConfig()).toThrow(/partially configured/);
    process.env.GITHUB_APP_SLUG = slug;
  });

  it("classifies installation lookups conservatively", async () => {
    const config = githubAppConfig()!;
    githubState.handler = (call) =>
      call.path === `/app/installations/${INSTALLATION_ID}`
        ? { status: 401, body: { message: "Bad JWT" } }
        : { status: 200, body: [] };
    const result = await fetchInstallation(config, INSTALLATION_ID);
    expect(result).toMatchObject({ ok: false, reason: "app_credentials" });
    githubState.handler = null; // network failure
    const network = await fetchInstallation(config, INSTALLATION_ID);
    expect(network).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("invalidation forces a fresh mint on the next use", async () => {
    githubState.handler = happyHandler();
    await githubInstallationToken(appWorkspaceId);
    invalidateGithubInstallationToken(appWorkspaceId);
    await githubInstallationToken(appWorkspaceId);
    expect(mintCalls()).toBe(2);
  });

  it("never hands a caller the previous installation's token when rebinding mid-mint", async () => {
    const NEW_INSTALLATION_ID = "777777";
    let releaseOldMint!: () => void;
    const oldMintGate = new Promise<void>((resolve) => {
      releaseOldMint = resolve;
    });
    githubState.handler = async (call) => {
      if (
        call.path === `/app/installations/${INSTALLATION_ID}/access_tokens`
      ) {
        await oldMintGate; // the OLD installation's mint hangs until released
        return {
          status: 201,
          body: {
            token: "token-OLD-installation",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        };
      }
      if (
        call.path ===
        `/app/installations/${NEW_INSTALLATION_ID}/access_tokens`
      ) {
        return {
          status: 201,
          body: {
            token: "token-NEW-installation",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        };
      }
      return { status: 200, body: [] };
    };

    // Caller 1 reads the OLD row and starts a mint that stalls.
    const oldCaller = githubInstallationToken(appWorkspaceId);
    await new Promise((resolve) => setTimeout(resolve, 25));

    // The workspace is rebound to a DIFFERENT installation mid-mint.
    await db
      .update(githubInstallationsTable)
      .set({
        installationId: NEW_INSTALLATION_ID,
        accountLogin: "new-org",
        updatedAt: new Date(),
      })
      .where(eq(githubInstallationsTable.workspaceId, appWorkspaceId));
    invalidateGithubInstallationToken(appWorkspaceId);

    // Caller 2 sees the NEW row: it must NOT coalesce onto the stale
    // flight and must get the NEW installation's token.
    const second = await githubInstallationToken(appWorkspaceId);
    expect(second?.token).toBe("token-NEW-installation");

    releaseOldMint();
    await oldCaller;

    // Even after the stale mint lands, lookups for the current row keep
    // returning the NEW token — the stale one can never be served.
    const third = await githubInstallationToken(appWorkspaceId);
    expect(third?.token).toBe("token-NEW-installation");
  });
});
