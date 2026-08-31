/**
 * GitHub App installation authentication.
 *
 * The deployment-level GitHub App identity (app id, slug, private key)
 * lives in server configuration — never in the database. Per-workspace
 * installation rows store only the installation's identity and safe
 * display metadata; the short-lived installation access tokens GitHub
 * mints on demand are cached in memory until shortly before expiry and
 * are never persisted, logged, or returned to a browser.
 *
 * Why this exists: OAuth-app tokens are single long-lived secrets — once
 * GitHub revokes one, only the owner clicking through consent again can
 * restore access. An installation lets the server mint fresh tokens
 * automatically for as long as the app stays installed, so a revoked or
 * expired token is a refresh, not an outage.
 */

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { db, githubInstallationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { GithubAuthError } from "./github-auth-error";

/** Bounded like the OAuth health check — nothing here may hang a request. */
const APP_API_TIMEOUT_MS = 10_000;

/* ----------------------------- App identity ---------------------------- */

export type GithubAppConfig = {
  appId: string;
  appSlug: string;
  privateKey: KeyObject;
};

/**
 * Parse the configured private key. Accepts a raw PEM, a PEM with literal
 * "\n" escapes (common when pasted into single-line secret fields), or a
 * base64-encoded PEM.
 */
function parsePrivateKey(raw: string): KeyObject | null {
  const candidates = [raw, raw.replace(/\\n/g, "\n")];
  if (!raw.includes("-----BEGIN")) {
    try {
      candidates.push(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
      /* not base64 */
    }
  }
  for (const candidate of candidates) {
    if (!candidate.includes("-----BEGIN")) continue;
    try {
      return createPrivateKey(candidate);
    } catch {
      /* try the next form */
    }
  }
  return null;
}

/**
 * The deployment's GitHub App identity, or null when the feature is not
 * configured (legacy OAuth remains the only connect path then). A present
 * but unparsable key is reported loudly instead of silently disabling the
 * feature — that is a configuration mistake, not an absence.
 */
export function githubAppConfig(): GithubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const appSlug = process.env.GITHUB_APP_SLUG?.trim();
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId && !appSlug && !rawKey) return null;
  if (!appId || !appSlug || !rawKey) {
    throw new GithubAuthError(
      "unavailable",
      "The GitHub App is only partially configured on this server (GITHUB_APP_ID, GITHUB_APP_SLUG, and GITHUB_APP_PRIVATE_KEY must all be set).",
    );
  }
  const privateKey = parsePrivateKey(rawKey);
  if (!privateKey) {
    throw new GithubAuthError(
      "unavailable",
      "GITHUB_APP_PRIVATE_KEY is set but is not a readable RSA private key (PEM). Paste the .pem file GitHub generated for the app.",
    );
  }
  return { appId, appSlug, privateKey };
}

/** True when the GitHub App install flow can be offered at all. */
export function githubAppConfigured(): boolean {
  try {
    return githubAppConfig() !== null;
  } catch {
    // Partially/badly configured: the flow cannot work, but callers asking
    // "should I show the install button?" must not blow up a status page.
    return false;
  }
}

function base64url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input) : input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Short-lived RS256 app JWT (GitHub caps validity at 10 minutes; 60s of
 * clock-skew allowance on iat). Minted fresh per use — deliberately never
 * cached, so a key rotation takes effect immediately.
 */
export function githubAppJwt(config: GithubAppConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: config.appId }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(config.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/* ------------------------- App-level API calls ------------------------- */

type AppApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number | null; requestId: string | null };

/** One JSON round-trip authenticated as the app itself (JWT). */
async function appApi(
  config: GithubAppConfig,
  path: string,
  init?: { method?: string },
): Promise<AppApiResult> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${githubAppJwt(config)}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(APP_API_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: null, requestId: null };
  }
  const requestId = response.headers.get("x-github-request-id");
  if (!response.ok) {
    return { ok: false, status: response.status, requestId };
  }
  if (response.status === 204) return { ok: true, status: 204, data: null };
  try {
    return { ok: true, status: response.status, data: await response.json() };
  } catch {
    return { ok: true, status: response.status, data: null };
  }
}

export type GithubInstallationDetails = {
  installationId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  suspended: boolean;
};

export type FetchInstallationResult =
  | { ok: true; installation: GithubInstallationDetails }
  | {
      ok: false;
      /**
       * "removed" — GitHub no longer knows this installation for OUR app
       * (uninstalled, or the id belongs to a different app; the app-scoped
       * JWT 404s foreign installations).
       * "app_credentials" — GitHub rejected the app JWT itself: the
       * configured app id / private key pair is wrong.
       * "unavailable" — network failure or GitHub outage; proves nothing
       * about the installation.
       */
      reason: "removed" | "app_credentials" | "unavailable";
      status: number | null;
    };

/**
 * Ask GitHub for an installation, authenticated as the app. This is the
 * server-side identity verification for the setup callback and the ground
 * truth for installation health — nothing browser-supplied is trusted.
 */
export async function fetchInstallation(
  config: GithubAppConfig,
  installationId: string,
): Promise<FetchInstallationResult> {
  const result = await appApi(
    config,
    `/app/installations/${encodeURIComponent(installationId)}`,
  );
  if (!result.ok) {
    const reason =
      result.status === 404
        ? "removed"
        : result.status === 401
          ? "app_credentials"
          : "unavailable";
    if (reason !== "unavailable") {
      logger.warn(
        {
          component: "github_app",
          failureClass:
            reason === "removed" ? "installation_removed" : "app_credentials",
          providerStatus: result.status,
          githubRequestId: result.requestId,
        },
        "GitHub App installation lookup was refused",
      );
    }
    return { ok: false, reason, status: result.status };
  }
  const data = result.data as {
    id?: number;
    account?: { login?: string; type?: string };
    repository_selection?: string;
    suspended_at?: string | null;
  } | null;
  if (typeof data?.id !== "number" || !data.account?.login) {
    return { ok: false, reason: "unavailable", status: result.status };
  }
  return {
    ok: true,
    installation: {
      installationId: String(data.id),
      accountLogin: data.account.login,
      accountType: data.account.type ?? "User",
      repositorySelection: data.repository_selection ?? "selected",
      suspended: Boolean(data.suspended_at),
    },
  };
}

/**
 * Best-effort uninstall at GitHub (DELETE the installation) so a
 * disconnect in the app also revokes the access on GitHub's side. Failure
 * is fine — deleting the workspace row is what blocks new work.
 */
export async function deleteInstallationAtGithub(
  config: GithubAppConfig,
  installationId: string,
): Promise<void> {
  await appApi(
    config,
    `/app/installations/${encodeURIComponent(installationId)}`,
    { method: "DELETE" },
  );
}

/* ----------------------- Installation token cache ---------------------- */

/**
 * Refresh this long before GitHub's stated expiry. Installation tokens
 * live ~60 minutes; a 5-minute margin means a token handed to an executor
 * is never within a clock-skew of dying mid-request.
 */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

type CachedToken = {
  /** Which installation row state minted this (installationId + updatedAt). */
  rowKey: string;
  token: string;
  expiresAt: number;
};

const tokenCache = new Map<string, CachedToken>();
/**
 * Single-flight: at most one mint per workspace at a time — but a flight
 * is only reusable by callers who saw the SAME installation row state
 * (rowKey). If the workspace is rebound to a different installation while
 * a mint is in flight, the new caller must not await (and receive) the
 * old installation's token.
 */
const inflightMints = new Map<
  string,
  { rowKey: string; promise: Promise<CachedToken> }
>();

/** Test/lifecycle hook: forget every cached installation token. */
export function clearGithubInstallationTokenCache(): void {
  tokenCache.clear();
  inflightMints.clear();
}

/** Drop one workspace's cached token (disconnect, reinstall, 401 retry). */
export function invalidateGithubInstallationToken(workspaceId: string): void {
  tokenCache.delete(workspaceId);
}

async function mintInstallationToken(
  workspaceId: string,
  rowKey: string,
  installationId: string,
): Promise<CachedToken> {
  const config = githubAppConfig();
  if (!config) {
    throw new GithubAuthError(
      "unavailable",
      "The GitHub App is not configured on this server, so the stored installation cannot be used right now.",
    );
  }
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${githubAppJwt(config)}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(APP_API_TIMEOUT_MS),
      },
    );
  } catch {
    throw new GithubAuthError(
      "unavailable",
      "GitHub could not be reached to refresh the app installation's access token. This is usually temporary — retry shortly.",
    );
  }
  if (!response.ok) {
    const requestId = response.headers.get("x-github-request-id");
    const failureClass =
      response.status === 404
        ? "installation_removed"
        : response.status === 401
          ? "app_credentials"
          : response.status >= 500
            ? "server_error"
            : "token_mint_refused";
    logger.warn(
      {
        component: "github_app",
        workspaceId,
        failureClass,
        providerStatus: response.status,
        githubRequestId: requestId,
      },
      "GitHub refused to mint an installation access token",
    );
    if (response.status === 404) {
      throw new GithubAuthError(
        "reconnect_required",
        "GitHub reports the app installation no longer exists — it was uninstalled on GitHub. Reinstall the GitHub App from the Connected Apps page to restore access.",
      );
    }
    if (response.status === 401) {
      throw new GithubAuthError(
        "unavailable",
        "GitHub rejected this server's app credentials (app id / private key). The installation itself is fine — the server's GitHub App configuration must be corrected.",
      );
    }
    throw new GithubAuthError(
      "unavailable",
      `GitHub could not issue an installation access token just now (HTTP ${response.status}). This is usually temporary — retry shortly.`,
    );
  }
  const body = (await response.json()) as {
    token?: string;
    expires_at?: string;
  };
  if (!body.token) {
    throw new GithubAuthError(
      "unavailable",
      "GitHub's installation-token response was missing the token. Retry shortly.",
    );
  }
  const expiresAtMs = body.expires_at
    ? Date.parse(body.expires_at)
    : Date.now() + 60 * 60 * 1000;
  return {
    rowKey,
    token: body.token,
    expiresAt: (Number.isFinite(expiresAtMs)
      ? expiresAtMs
      : Date.now() + 60 * 60 * 1000) - TOKEN_EXPIRY_MARGIN_MS,
  };
}

/**
 * Resolve a usable installation access token for the workspace, minting a
 * fresh one when none is cached or the cached one nears expiry. Concurrent
 * callers share one mint (single-flight) so a burst of agent actions never
 * produces a token storm. Returns null when the workspace has no
 * installation row at all — that is the caller's cue to fall back to
 * legacy OAuth.
 */
export async function githubInstallationToken(workspaceId: string): Promise<{
  token: string;
  accountLogin: string;
} | null> {
  const [row] = await db
    .select()
    .from(githubInstallationsTable)
    .where(eq(githubInstallationsTable.workspaceId, workspaceId))
    .limit(1);
  if (!row) return null;

  const rowKey = `${row.installationId}:${row.updatedAt.getTime()}`;
  const cached = tokenCache.get(workspaceId);
  if (cached && cached.rowKey === rowKey && cached.expiresAt > Date.now()) {
    return { token: cached.token, accountLogin: row.accountLogin };
  }

  const existingFlight = inflightMints.get(workspaceId);
  let flight: Promise<CachedToken>;
  if (existingFlight && existingFlight.rowKey === rowKey) {
    flight = existingFlight.promise;
  } else {
    // Either no mint is in flight, or the one in flight belongs to a
    // DIFFERENT installation row state (reinstall/rebind mid-mint). Start
    // a fresh mint for the row this caller actually saw; the newer flight
    // replaces the stale entry so later callers coalesce on it.
    flight = mintInstallationToken(workspaceId, rowKey, row.installationId);
    inflightMints.set(workspaceId, { rowKey, promise: flight });
    flight
      .catch(() => {
        /* failures are propagated to every awaiting caller below */
      })
      .finally(() => {
        if (inflightMints.get(workspaceId)?.promise === flight) {
          inflightMints.delete(workspaceId);
        }
      });
  }
  const minted = await flight;
  // Cache from the caller side, only under the row state that requested
  // it. A stale flight's token can still land in the cache after an
  // invalidation, but it is inert: every lookup re-reads the DB row and
  // ignores a cache entry whose rowKey no longer matches.
  if (minted.rowKey === rowKey) {
    tokenCache.set(workspaceId, minted);
  }
  return { token: minted.token, accountLogin: row.accountLogin };
}

/** Metadata-only summary of the workspace's installation, if any. */
export async function githubInstallationSummary(workspaceId: string): Promise<{
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  connectedAt: Date;
  updatedAt: Date;
} | null> {
  const [row] = await db
    .select({
      accountLogin: githubInstallationsTable.accountLogin,
      accountType: githubInstallationsTable.accountType,
      repositorySelection: githubInstallationsTable.repositorySelection,
      connectedAt: githubInstallationsTable.connectedAt,
      updatedAt: githubInstallationsTable.updatedAt,
    })
    .from(githubInstallationsTable)
    .where(eq(githubInstallationsTable.workspaceId, workspaceId))
    .limit(1);
  return row ?? null;
}
