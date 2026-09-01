/**
 * Per-workspace GitHub credentials, created by the in-app OAuth flow.
 * GitHub OAuth-app tokens have no scheduled expiry and no refresh token,
 * so only the encrypted access token is durable; it is decrypted per
 * operation — never cached, logged, or returned. Every helper resolves the
 * credential from a workspace id, never from a browser session, so
 * background work always acts as the task's durable owner.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  db,
  githubAccountsTable,
  githubInstallationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  GITHUB_SCOPES,
  classifyGithubRefusal,
  missingGithubScopes,
} from "./failures";
import { GithubAuthError } from "./github-auth-error";
import {
  findPersonalInstallationForGithubUser,
  fetchInstallation,
  githubAppConfig,
  githubInstallationSummary,
  githubInstallationToken,
  invalidateGithubInstallationToken,
} from "./app-auth";

// Scope constants and failure classification live in ./failures (pure,
// import-cycle-free); re-exported here so existing importers keep working.
export { GITHUB_SCOPES, missingGithubScopes } from "./failures";

// The shared error type lives in its own module (both the OAuth store and
// the app-installation store throw it); re-exported for existing importers.
export { GithubAuthError } from "./github-auth-error";

const FORMAT = "v1";

/**
 * Key derived from SESSION_SECRET with a GitHub-specific label — never
 * shared with the Google or Codex stores. Rotating SESSION_SECRET makes the
 * stored token undecryptable, surfacing as "reconnect GitHub", never as
 * silence.
 */
function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new GithubAuthError(
      "unavailable",
      "SESSION_SECRET is not set on this server, so a GitHub sign-in cannot be stored securely.",
    );
  }
  return createHash("sha256").update(`github-credential:${secret}`).digest();
}

export function encryptGithubToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const sealed = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    FORMAT,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    sealed.toString("base64"),
  ].join(".");
}

function decryptGithubToken(payload: string): string {
  const [format, iv, tag, sealed] = payload.split(".");
  if (format !== FORMAT || !iv || !tag || !sealed) {
    throw new GithubAuthError(
      "reconnect_required",
      "The stored GitHub sign-in is not in a format this server understands. Reconnect GitHub.",
    );
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof GithubAuthError) throw error;
    throw new GithubAuthError(
      "reconnect_required",
      "The stored GitHub sign-in could not be decrypted, usually because SESSION_SECRET changed. Reconnect GitHub.",
    );
  }
}

export type GithubAccountSummary = {
  login: string;
  scopes: string;
  connectedAt: Date;
  updatedAt: Date;
  missingScopes: string[];
};

/** Metadata only — never decrypts, safe on every request. */
export async function githubAccountSummary(
  workspaceId: string,
): Promise<GithubAccountSummary | null> {
  const [row] = await db
    .select({
      login: githubAccountsTable.login,
      scopes: githubAccountsTable.scopes,
      connectedAt: githubAccountsTable.connectedAt,
      updatedAt: githubAccountsTable.updatedAt,
    })
    .from(githubAccountsTable)
    .where(eq(githubAccountsTable.workspaceId, workspaceId))
    .limit(1);
  if (!row) return null;
  return { ...row, missingScopes: missingGithubScopes(row.scopes) };
}

/** Store (or replace) the workspace's GitHub account after consent. */
export async function saveGithubAccount(input: {
  workspaceId: string;
  clerkUserId: string;
  githubUserId: string;
  login: string;
  accessToken: string;
  scopes: string;
}): Promise<void> {
  const accessTokenEnc = encryptGithubToken(input.accessToken);
  const now = new Date();
  await db
    .insert(githubAccountsTable)
    .values({
      workspaceId: input.workspaceId,
      clerkUserId: input.clerkUserId,
      githubUserId: input.githubUserId,
      login: input.login,
      accessTokenEnc,
      scopes: input.scopes,
      connectedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: githubAccountsTable.workspaceId,
      set: {
        clerkUserId: input.clerkUserId,
        githubUserId: input.githubUserId,
        login: input.login,
        accessTokenEnc,
        scopes: input.scopes,
        connectedAt: now,
        updatedAt: now,
      },
    });
  // A fresh credential must be re-verified immediately: the page the owner
  // lands on after reconnecting has to show live truth, not a cached "bad".
  healthCache.delete(input.workspaceId);
}

export function githubClientConfig(): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new GithubAuthError(
      "unavailable",
      "GitHub OAuth is not configured on this server (GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET).",
    );
  }
  return { clientId, clientSecret };
}

/** Remove the credential. Returns the row that was deleted, if any. */
export async function deleteGithubAccount(
  workspaceId: string,
): Promise<{ login: string } | null> {
  const [row] = await db
    .delete(githubAccountsTable)
    .where(eq(githubAccountsTable.workspaceId, workspaceId))
    .returning({
      login: githubAccountsTable.login,
      accessTokenEnc: githubAccountsTable.accessTokenEnc,
    });
  healthCache.delete(workspaceId);
  if (!row) return null;
  // Best-effort revocation at GitHub so the grant disappears from the
  // user's authorized-apps page too. Failure is fine — the row is already
  // gone, which is what blocks all new work.
  try {
    const { clientId, clientSecret } = githubClientConfig();
    const token = decryptGithubToken(row.accessTokenEnc);
    await fetch(
      `https://api.github.com/applications/${encodeURIComponent(clientId)}/grant`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ access_token: token }),
      },
    );
  } catch {
    /* revocation is best-effort */
  }
  return { login: row.login };
}

/**
 * Resolve the workspace's GitHub access token. Throws GithubAuthError —
 * never returns a stale or foreign credential. Decrypted fresh on every
 * call: a disconnect blocks the very next operation.
 */
export async function githubAccessToken(workspaceId: string): Promise<{
  token: string;
  login: string;
}> {
  const [row] = await db
    .select()
    .from(githubAccountsTable)
    .where(eq(githubAccountsTable.workspaceId, workspaceId))
    .limit(1);
  if (!row) {
    throw new GithubAuthError(
      "not_connected",
      "No GitHub account is connected to this workspace. Connect GitHub first.",
    );
  }
  const missing = missingGithubScopes(row.scopes);
  if (missing.length > 0) {
    logger.warn(
      {
        component: "github_credentials",
        workspaceId,
        failureClass: "missing_scope",
        missingScopes: missing,
      },
      "GitHub credential resolution refused: stored grant lacks required scopes",
    );
    throw new GithubAuthError(
      "reconnect_required",
      `The connected GitHub account is missing required permissions (${missing.join(", ")}). Reconnect GitHub and grant all requested access.`,
    );
  }
  try {
    return { token: decryptGithubToken(row.accessTokenEnc), login: row.login };
  } catch (error) {
    if (error instanceof GithubAuthError) {
      // Secret-free evidence trail: WHICH workspace's credential failed and
      // WHY (undecryptable row vs. missing server config) — never the
      // ciphertext, plaintext, or key material.
      logger.error(
        {
          component: "github_credentials",
          workspaceId,
          failureClass:
            error.kind === "unavailable"
              ? "server_config"
              : "credential_unreadable",
        },
        "GitHub credential resolution failed before any GitHub call was made",
      );
    }
    throw error;
  }
}

/* ---------------------- Combined auth resolution ----------------------- */

/**
 * Resolve GitHub authentication for the workspace: GitHub App installation
 * first, legacy OAuth token second. The installation is authoritative when
 * its row exists — a mint failure surfaces as itself rather than silently
 * degrading to a possibly different GitHub identity. Workspaces that never
 * installed the app keep working through their stored OAuth token.
 */
export async function githubAuth(workspaceId: string): Promise<{
  token: string;
  login: string;
  source: "installation" | "oauth";
}> {
  const installation = await githubInstallationToken(workspaceId);
  if (installation) {
    return {
      token: installation.token,
      login: installation.accountLogin,
      source: "installation",
    };
  }
  const oauth = await githubAccessToken(workspaceId);
  return { token: oauth.token, login: oauth.login, source: "oauth" };
}

/**
 * Repair the narrow case where the owner installed the GitHub App on their
 * personal account but GitHub's setup redirect never persisted the binding.
 *
 * The match is deliberately strict: the app installation's immutable
 * account id must equal the immutable id captured by the workspace's prior
 * OAuth identity, its type must be User (never Organization), and the safe
 * login label must also agree. A unique-index conflict is never overridden.
 */
export async function recoverPersonalGithubAppBinding(
  workspaceId: string,
): Promise<boolean> {
  const [oauth] = await db
    .select({
      clerkUserId: githubAccountsTable.clerkUserId,
      githubUserId: githubAccountsTable.githubUserId,
      login: githubAccountsTable.login,
    })
    .from(githubAccountsTable)
    .where(eq(githubAccountsTable.workspaceId, workspaceId))
    .limit(1);
  if (!oauth) return false;

  try {
    const config = githubAppConfig();
    if (!config) return false;
    const installation = await findPersonalInstallationForGithubUser(
      config,
      oauth.githubUserId,
    );
    if (
      !installation ||
      installation.suspended ||
      installation.accountLogin.toLowerCase() !== oauth.login.toLowerCase()
    ) {
      return false;
    }
    const now = new Date();
    const [inserted] = await db
      .insert(githubInstallationsTable)
      .values({
        workspaceId,
        clerkUserId: oauth.clerkUserId,
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: installation.repositorySelection,
        connectedAt: now,
        updatedAt: now,
      })
      // Either this workspace was repaired concurrently or another workspace
      // already owns the installation. Never steal or overwrite either row.
      .onConflictDoNothing()
      .returning({ workspaceId: githubInstallationsTable.workspaceId });
    if (!inserted) {
      return (await githubInstallationSummary(workspaceId)) !== null;
    }
    invalidateGithubInstallationToken(workspaceId);
    invalidateGithubHealth(workspaceId);
    logger.info(
      {
        component: "github_app",
        workspaceId,
        recovery: "matched_personal_account",
      },
      "Recovered a missing GitHub App workspace binding",
    );
    return true;
  } catch (error) {
    logger.info(
      {
        component: "github_app",
        workspaceId,
        recovery: "not_available",
        failureClass:
          error instanceof GithubAuthError ? error.kind : "unexpected",
      },
      "Could not recover a missing GitHub App workspace binding",
    );
    return false;
  }
}

/**
 * Which auth method the workspace would use right now, without minting a
 * token or making any network call. "github_app" wins whenever an
 * installation row exists (mirrors githubAuth's precedence).
 */
export async function githubAuthMethod(
  workspaceId: string,
): Promise<"github_app" | "oauth" | null> {
  if ((await githubInstallationSummary(workspaceId)) !== null) {
    return "github_app";
  }
  const account = await githubAccountSummary(workspaceId);
  return account ? "oauth" : null;
}

/* ------------------------- Connection health --------------------------- */

/** Upper bound for the live identity check — the status page must not hang. */
export const GITHUB_HEALTH_TIMEOUT_MS = 3_500;

/**
 * Live connection health of the workspace's GitHub access, verified
 * against GitHub itself instead of trusting that a stored row means a
 * working credential. Installation-backed workspaces are verified as the
 * app (does the installation still exist, is it suspended); OAuth-backed
 * ones by the token identity check (GET /user).
 */
export type GithubConnectionHealth =
  | { state: "not_connected" }
  | {
      state: "connected";
      login: string;
      detail: string | null;
      method: "github_app" | "oauth";
    }
  | {
      state: "reconnect_required";
      login: string;
      reason:
        | "invalid_token"
        | "missing_scope"
        | "undecryptable"
        | "installation_removed"
        | "installation_suspended";
      detail: string;
      method: "github_app" | "oauth";
    }
  | {
      state: "unavailable";
      login: string | null;
      reason: "network" | "provider_error" | "config";
      detail: string;
      method: "github_app" | "oauth";
    };

/**
 * Short-lived verification cache so the Connected Apps page (and anything
 * else polling status) does not burn GitHub rate limit on every render.
 * Entries are keyed to the credential row's updatedAt, so a reconnect
 * invalidates instantly, and save/delete clear the entry outright.
 * Transient "unavailable" results expire faster than settled ones.
 */
const healthCache = new Map<
  string,
  { rowKey: string; expiresAt: number; health: GithubConnectionHealth }
>();
const HEALTH_TTL_MS = 60_000;
const HEALTH_TRANSIENT_TTL_MS = 15_000;

export function clearGithubHealthCache(): void {
  healthCache.clear();
}

/** Invalidate one workspace's cached verdict (install/reinstall/disconnect). */
export function invalidateGithubHealth(workspaceId: string): void {
  healthCache.delete(workspaceId);
}

/**
 * Check whether the stored GitHub credential actually works, with a
 * bounded timeout. Classification is deliberately conservative:
 * - only provider evidence (401, missing live scopes, undecryptable row)
 *   marks the credential as needing reconnection;
 * - a network failure, timeout, or GitHub 5xx reports "unavailable" and
 *   NEVER flips a stored credential to "broken";
 * - a rate-limit refusal proves the credential authenticated (a revoked
 *   token would have been a 401), so it reports "connected".
 * Nothing here logs or returns the token.
 */
export async function checkGithubConnectionHealth(
  workspaceId: string,
): Promise<GithubConnectionHealth> {
  // Installation-first, mirroring githubAuth's resolution order: when an
  // installation row exists, IT is what agent actions will use, so its
  // health is the truth the owner needs — not the leftover OAuth row's.
  const installation = await githubInstallationSummary(workspaceId);
  if (installation) {
    const rowKey = `app:${installation.updatedAt.getTime()}`;
    const cached = healthCache.get(workspaceId);
    if (cached && cached.rowKey === rowKey && cached.expiresAt > Date.now()) {
      return cached.health;
    }
    const health = await computeInstallationHealth(workspaceId, installation);
    healthCache.set(workspaceId, {
      rowKey,
      expiresAt:
        Date.now() +
        (health.state === "unavailable"
          ? HEALTH_TRANSIENT_TTL_MS
          : HEALTH_TTL_MS),
      health,
    });
    return health;
  }

  const [row] = await db
    .select({
      login: githubAccountsTable.login,
      scopes: githubAccountsTable.scopes,
      accessTokenEnc: githubAccountsTable.accessTokenEnc,
      updatedAt: githubAccountsTable.updatedAt,
    })
    .from(githubAccountsTable)
    .where(eq(githubAccountsTable.workspaceId, workspaceId))
    .limit(1);
  if (!row) return { state: "not_connected" };

  const rowKey = String(row.updatedAt.getTime());
  const cached = healthCache.get(workspaceId);
  if (cached && cached.rowKey === rowKey && cached.expiresAt > Date.now()) {
    return cached.health;
  }

  const health: GithubConnectionHealth = {
    ...(await computeHealth(workspaceId, row)),
    method: "oauth",
  };
  healthCache.set(workspaceId, {
    rowKey,
    expiresAt:
      Date.now() +
      (health.state === "unavailable"
        ? HEALTH_TRANSIENT_TTL_MS
        : HEALTH_TTL_MS),
    health,
  });
  return health;
}

/**
 * Health of an installation-backed connection, verified as the app: GitHub
 * is asked whether the installation still exists and whether it is
 * suspended. Classification stays conservative — only GitHub saying
 * "removed" (404 under our own app JWT) or "suspended" flips the state to
 * reconnect_required; app-credential problems and outages report
 * "unavailable" because the owner's installation itself is fine. No
 * repository names or tokens are fetched, logged, or returned.
 */
async function computeInstallationHealth(
  workspaceId: string,
  installation: NonNullable<
    Awaited<ReturnType<typeof githubInstallationSummary>>
  >,
): Promise<GithubConnectionHealth> {
  let config;
  try {
    config = githubAppConfig();
  } catch (error) {
    return {
      state: "unavailable",
      login: installation.accountLogin,
      reason: "config",
      detail:
        error instanceof GithubAuthError
          ? error.message
          : "The GitHub App configuration on this server could not be read.",
      method: "github_app",
    };
  }
  if (!config) {
    return {
      state: "unavailable",
      login: installation.accountLogin,
      reason: "config",
      detail:
        "This workspace uses a GitHub App installation, but the server's GitHub App configuration (GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY) is missing. Restore it to resume access — the installation itself is untouched.",
      method: "github_app",
    };
  }
  // The installation row stores the id privately; re-read it here rather
  // than widening the summary type that status pages consume.
  const [row] = await db
    .select({ installationId: githubInstallationsTable.installationId })
    .from(githubInstallationsTable)
    .where(eq(githubInstallationsTable.workspaceId, workspaceId))
    .limit(1);
  if (!row) return { state: "not_connected" };
  const result = await fetchInstallation(config, row.installationId);
  if (!result.ok) {
    switch (result.reason) {
      case "removed":
        logger.warn(
          {
            component: "github_health",
            workspaceId,
            failureClass: "installation_removed",
          },
          "GitHub connection health check did not verify as healthy",
        );
        return {
          state: "reconnect_required",
          login: installation.accountLogin,
          reason: "installation_removed",
          detail:
            "GitHub reports the app installation no longer exists — it was uninstalled on GitHub (or removed by the account's admins). Reinstall the GitHub App to restore access; nothing on this server needs to be recreated.",
          method: "github_app",
        };
      case "app_credentials":
        return {
          state: "unavailable",
          login: installation.accountLogin,
          reason: "config",
          detail:
            "GitHub rejected this server's app credentials (app id / private key), so the installation could not be verified. The installation itself is fine — the server's GitHub App configuration must be corrected.",
          method: "github_app",
        };
      default:
        return {
          state: "unavailable",
          login: installation.accountLogin,
          reason:
            result.status !== null && result.status >= 500
              ? "provider_error"
              : "network",
          detail:
            "GitHub could not be reached to verify the app installation (network problem, timeout, or GitHub outage). This is usually temporary and does not mean access is broken — check again shortly.",
          method: "github_app",
        };
    }
  }
  if (result.installation.suspended) {
    logger.warn(
      {
        component: "github_health",
        workspaceId,
        failureClass: "installation_suspended",
      },
      "GitHub connection health check did not verify as healthy",
    );
    return {
      state: "reconnect_required",
      login: installation.accountLogin,
      reason: "installation_suspended",
      detail:
        "The GitHub App installation is suspended on GitHub, so agents cannot use it. Unsuspend it in the account's GitHub App settings (or reinstall the app) to restore access.",
      method: "github_app",
    };
  }
  return {
    state: "connected",
    login: result.installation.accountLogin,
    detail:
      result.installation.repositorySelection === "all"
        ? null
        : "The installation covers the repositories selected on GitHub. Manage the selection from the account's GitHub App settings if agents need more.",
    method: "github_app",
  };
}

/** Distributive Omit: applied member-by-member across a union. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * OAuth-path health, minus the `method` discriminator (the caller stamps
 * "oauth" on). Never returns not_connected — the caller checked the row.
 */
async function computeHealth(
  workspaceId: string,
  row: { login: string; scopes: string; accessTokenEnc: string },
): Promise<
  DistributiveOmit<
    Exclude<GithubConnectionHealth, { state: "not_connected" }>,
    "method"
  >
> {
  const logHealth = (
    level: "warn" | "info",
    failureClass: string,
    extra: Record<string, unknown> = {},
  ): void => {
    logger[level](
      {
        component: "github_health",
        workspaceId,
        failureClass,
        ...extra,
      },
      "GitHub connection health check did not verify as healthy",
    );
  };

  // Stored-scope shortfall needs no network call — the grant is known bad.
  const storedMissing = missingGithubScopes(row.scopes);
  if (storedMissing.length > 0) {
    logHealth("warn", "missing_scope", { missingScopes: storedMissing });
    return {
      state: "reconnect_required",
      login: row.login,
      reason: "missing_scope",
      detail: `The connected GitHub account is missing required permissions (${storedMissing.join(", ")}). Reconnect GitHub and approve all requested access.`,
    };
  }

  let token: string;
  try {
    token = decryptGithubToken(row.accessTokenEnc);
  } catch (error) {
    if (error instanceof GithubAuthError && error.kind === "unavailable") {
      logHealth("warn", "server_config");
      return {
        state: "unavailable",
        login: row.login,
        reason: "config",
        detail: error.message,
      };
    }
    logHealth("warn", "credential_unreadable");
    return {
      state: "reconnect_required",
      login: row.login,
      reason: "undecryptable",
      detail:
        "The stored GitHub sign-in can no longer be decrypted — this usually means the server's credential-encryption secret (SESSION_SECRET) changed since it was stored, for example after a deployment configuration change. Reconnect GitHub once to store a fresh credential; the OAuth app itself does not need to be recreated.",
    };
  }

  let response: Response;
  try {
    response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(GITHUB_HEALTH_TIMEOUT_MS),
    });
  } catch {
    logHealth("info", "network");
    return {
      state: "unavailable",
      login: row.login,
      reason: "network",
      detail:
        "GitHub could not be reached to verify this connection (network problem or timeout). This is usually temporary and does not mean the sign-in is broken — check again shortly.",
    };
  }

  if (response.ok) {
    // The live X-OAuth-Scopes header is the ground truth for what this
    // token can do right now — stored scopes can go stale if the grant
    // was edited at GitHub.
    const liveScopes = response.headers.get("x-oauth-scopes");
    const liveMissing =
      liveScopes !== null ? missingGithubScopes(liveScopes) : [];
    if (liveMissing.length > 0) {
      logHealth("warn", "missing_scope", { missingScopes: liveMissing });
      return {
        state: "reconnect_required",
        login: row.login,
        reason: "missing_scope",
        detail: `GitHub reports this sign-in no longer has the required permission${liveMissing.length === 1 ? "" : "s"} (${liveMissing.join(", ")}). Reconnect GitHub and approve all requested access.`,
      };
    }
    return { state: "connected", login: row.login, detail: null };
  }

  const refusal = classifyGithubRefusal(response.status, response.headers);
  const logExtra = {
    providerStatus: response.status,
    githubRequestId: refusal.requestId,
  };
  switch (refusal.failureClass) {
    case "invalid_token":
      logHealth("warn", "invalid_token", logExtra);
      return {
        state: "reconnect_required",
        login: row.login,
        reason: "invalid_token",
        detail: `GitHub reports the stored sign-in is no longer valid — it was revoked or reset at GitHub, so agents cannot use it. Reconnect GitHub once to restore access; the OAuth app itself does not need to be recreated.${refusal.requestId ? ` (GitHub request ${refusal.requestId})` : ""}`,
      };
    case "missing_scope":
      logHealth("warn", "missing_scope", {
        ...logExtra,
        missingScopes: refusal.missingScopes,
      });
      return {
        state: "reconnect_required",
        login: row.login,
        reason: "missing_scope",
        detail: `GitHub reports this sign-in is missing required permissions (${refusal.missingScopes.join(", ")}). Reconnect GitHub and approve all requested access.`,
      };
    case "rate_limited":
      // Authenticated rate limiting means the token WORKS.
      return {
        state: "connected",
        login: row.login,
        detail:
          "GitHub accepted the sign-in but is rate-limiting requests right now; agent work against GitHub may need to retry until the limit resets.",
      };
    default:
      logHealth("info", refusal.failureClass, logExtra);
      return {
        state: "unavailable",
        login: row.login,
        reason: "provider_error",
        detail: `GitHub could not verify the connection just now (HTTP ${response.status}). This did not report the sign-in as invalid and is usually temporary — check again shortly.${refusal.requestId ? ` (GitHub request ${refusal.requestId})` : ""}`,
      };
  }
}

/* ----------------------- Startup diagnostics --------------------------- */

/**
 * Boot-time proof that every stored GitHub credential is decryptable with
 * the CURRENT SESSION_SECRET. A redeployment that rotated or lost the
 * secret surfaces here, in deployment logs, as an explicit
 * "encryption_key_mismatch" naming the affected workspace — instead of as
 * a mystery "expired" failure the first time an agent touches GitHub.
 * Decryption happens in memory only; nothing derived from the token is
 * logged or returned.
 */
export async function logGithubCredentialStartupHealth(): Promise<{
  checked: number;
  unreadable: number;
}> {
  let rows: { workspaceId: string; accessTokenEnc: string }[];
  try {
    rows = await db
      .select({
        workspaceId: githubAccountsTable.workspaceId,
        accessTokenEnc: githubAccountsTable.accessTokenEnc,
      })
      .from(githubAccountsTable)
      .limit(200);
  } catch (error) {
    logger.warn(
      { component: "github_credentials", err: error },
      "GitHub credential startup check could not read the credential table",
    );
    return { checked: 0, unreadable: 0 };
  }
  let unreadable = 0;
  for (const row of rows) {
    try {
      decryptGithubToken(row.accessTokenEnc);
    } catch (error) {
      if (error instanceof GithubAuthError && error.kind === "unavailable") {
        logger.error(
          { component: "github_credentials", failureClass: "server_config" },
          "SESSION_SECRET is not configured on this server: no stored GitHub credential can be decrypted until it is restored. Restore the ORIGINAL secret to keep existing connections working.",
        );
        return { checked: rows.length, unreadable: rows.length };
      }
      unreadable += 1;
      logger.error(
        {
          component: "github_credentials",
          workspaceId: row.workspaceId,
          failureClass: "encryption_key_mismatch",
        },
        "Stored GitHub credential cannot be decrypted with the current SESSION_SECRET — the secret changed since the credential was stored (or the row is corrupt). The workspace owner must reconnect GitHub once; recreating the OAuth app is NOT required.",
      );
    }
  }
  if (rows.length > 0 && unreadable === 0) {
    logger.info(
      { component: "github_credentials", checked: rows.length },
      "All stored GitHub credentials decrypt with the current SESSION_SECRET",
    );
  }
  return { checked: rows.length, unreadable };
}
