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
import { db, githubAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export class GithubAuthError extends Error {
  constructor(
    /**
     * "not_connected" — no GitHub account is connected to the workspace.
     * "reconnect_required" — a credential exists but can no longer be used
     * (revoked, undecryptable after a SESSION_SECRET rotation, or missing
     * a required scope); the user must reconnect.
     * "unavailable" — a transient failure (network, missing server
     * config); nothing is wrong with the stored credential.
     */
    readonly kind: "not_connected" | "reconnect_required" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "GithubAuthError";
  }
}

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

/**
 * The single OAuth scope the catalog needs: "repo" covers reading private
 * repositories and files plus creating issues and comments. GitHub OAuth
 * apps offer no finer-grained repo scope.
 */
export const GITHUB_SCOPES = ["repo"] as const;

/** GitHub reports granted scopes comma-separated ("repo,read:user"). */
export function missingGithubScopes(granted: string): string[] {
  const have = new Set(
    granted
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return GITHUB_SCOPES.filter((scope) => !have.has(scope));
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
    throw new GithubAuthError(
      "reconnect_required",
      `The connected GitHub account is missing required permissions (${missing.join(", ")}). Reconnect GitHub and grant all requested access.`,
    );
  }
  return { token: decryptGithubToken(row.accessTokenEnc), login: row.login };
}
