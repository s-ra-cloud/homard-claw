/**
 * Per-workspace Google (Gmail) credentials, created by the in-app OAuth
 * flow. Only the encrypted refresh token is durable; access tokens live in
 * a short in-memory cache and are never persisted or logged. Every helper
 * here resolves the credential from a workspace id — never from a browser
 * session — so background work always uses the mailbox of the task's
 * durable owner.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { db, googleAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export class GoogleAuthError extends Error {
  constructor(
    /**
     * "not_connected" — no Gmail account is connected to the workspace.
     * "reconnect_required" — a credential exists but Google no longer
     * accepts it (revoked, expired consent, rotated SESSION_SECRET) or it
     * lacks a required scope; the user must reconnect.
     * "unavailable" — a transient failure (network, missing server
     * config); nothing is wrong with the stored credential.
     */
    readonly kind: "not_connected" | "reconnect_required" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

const FORMAT = "v1";

/**
 * Key derived from SESSION_SECRET with its own label (never shared with the
 * Codex store). Rotating SESSION_SECRET makes stored refresh tokens
 * undecryptable, which surfaces as "reconnect Gmail" — never as silence.
 */
function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new GoogleAuthError(
      "unavailable",
      "SESSION_SECRET is not set on this server, so a Google sign-in cannot be stored securely.",
    );
  }
  return createHash("sha256").update(`google-credential:${secret}`).digest();
}

export function encryptRefreshToken(plaintext: string): string {
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

function decryptRefreshToken(payload: string): string {
  const [format, iv, tag, sealed] = payload.split(".");
  if (format !== FORMAT || !iv || !tag || !sealed) {
    throw new GoogleAuthError(
      "reconnect_required",
      "The stored Google sign-in is not in a format this server understands. Reconnect Gmail.",
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
    if (error instanceof GoogleAuthError) throw error;
    throw new GoogleAuthError(
      "reconnect_required",
      "The stored Google sign-in could not be decrypted, usually because SESSION_SECRET changed. Reconnect Gmail.",
    );
  }
}

/** The Gmail scopes HomardClaw requests — least privilege for its catalog. */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

/**
 * The Drive scopes for the catalog: read any file, create/manage only the
 * files HomardClaw itself creates. Never full write over the whole Drive.
 */
export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
] as const;

/** Scopes requested at consent: identity + the Gmail set. */
export const REQUESTED_SCOPES = [
  "openid",
  "email",
  ...GMAIL_SCOPES,
] as const;

/** Scopes requested by the incremental Drive consent: identity + Drive. */
export const DRIVE_REQUESTED_SCOPES = [
  "openid",
  "email",
  ...DRIVE_SCOPES,
] as const;

function missingScopes(
  granted: string,
  required: readonly string[],
): string[] {
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return required.filter((scope) => !have.has(scope));
}

export function missingGmailScopes(granted: string): string[] {
  return missingScopes(granted, GMAIL_SCOPES);
}

export function missingDriveScopes(granted: string): string[] {
  return missingScopes(granted, DRIVE_SCOPES);
}

export type GoogleAccountSummary = {
  email: string;
  scopes: string;
  connectedAt: Date;
  updatedAt: Date;
  missingScopes: string[];
  missingDriveScopes: string[];
};

/** Metadata only — never decrypts, safe on every request. */
export async function googleAccountSummary(
  workspaceId: string,
): Promise<GoogleAccountSummary | null> {
  const [row] = await db
    .select({
      email: googleAccountsTable.email,
      scopes: googleAccountsTable.scopes,
      connectedAt: googleAccountsTable.connectedAt,
      updatedAt: googleAccountsTable.updatedAt,
    })
    .from(googleAccountsTable)
    .where(eq(googleAccountsTable.workspaceId, workspaceId))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    missingScopes: missingGmailScopes(row.scopes),
    missingDriveScopes: missingDriveScopes(row.scopes),
  };
}

/**
 * Store (or replace) the workspace's Google account after a completed
 * consent. Replacing always overwrites the credential and bumps the
 * revision, so any refresh started against the old account can never fold
 * its token back in.
 */
export async function saveGoogleAccount(input: {
  workspaceId: string;
  clerkUserId: string;
  googleSub: string;
  email: string;
  refreshToken: string;
  scopes: string;
}): Promise<void> {
  const refreshTokenEnc = encryptRefreshToken(input.refreshToken);
  const now = new Date();
  // Incremental consent: when the SAME Google account reconnects (e.g. to
  // add Drive), previously granted scopes are kept — Google's
  // include_granted_scopes usually reports them all, but a union here means
  // a Drive connect can never silently drop Gmail. A different account
  // replaces everything.
  let scopes = input.scopes;
  const [existing] = await db
    .select({
      googleSub: googleAccountsTable.googleSub,
      scopes: googleAccountsTable.scopes,
    })
    .from(googleAccountsTable)
    .where(eq(googleAccountsTable.workspaceId, input.workspaceId))
    .limit(1);
  if (existing && existing.googleSub === input.googleSub) {
    scopes = [
      ...new Set(
        `${existing.scopes} ${input.scopes}`.split(/\s+/).filter(Boolean),
      ),
    ].join(" ");
  }
  await db
    .insert(googleAccountsTable)
    .values({
      workspaceId: input.workspaceId,
      clerkUserId: input.clerkUserId,
      googleSub: input.googleSub,
      email: input.email,
      refreshTokenEnc,
      scopes,
      connectedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: googleAccountsTable.workspaceId,
      set: {
        clerkUserId: input.clerkUserId,
        googleSub: input.googleSub,
        email: input.email,
        refreshTokenEnc,
        scopes,
        revision: randomBytes(16).toString("hex"),
        connectedAt: now,
        updatedAt: now,
      },
    });
  accessTokens.delete(input.workspaceId);
}

/** Remove the credential. Returns the row that was deleted, if any. */
export async function deleteGoogleAccount(
  workspaceId: string,
): Promise<{ email: string } | null> {
  const [row] = await db
    .delete(googleAccountsTable)
    .where(eq(googleAccountsTable.workspaceId, workspaceId))
    .returning({
      email: googleAccountsTable.email,
      refreshTokenEnc: googleAccountsTable.refreshTokenEnc,
    });
  accessTokens.delete(workspaceId);
  if (!row) return null;
  // Best-effort revocation at Google so the grant disappears from the
  // user's account page too. Failure is fine — the row is already gone,
  // which is what blocks all new work.
  try {
    const token = decryptRefreshToken(row.refreshTokenEnc);
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    /* revocation is best-effort */
  }
  return { email: row.email };
}

export function googleClientConfig(): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new GoogleAuthError(
      "unavailable",
      "Google OAuth is not configured on this server (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).",
    );
  }
  return { clientId, clientSecret };
}

/**
 * Short-lived access tokens, cached in memory only and bound to the
 * credential revision that produced them: replacing or disconnecting the
 * account invalidates the cache entry even before it expires.
 */
const accessTokens = new Map<
  string,
  { token: string; expiresAt: number; revision: string }
>();
const EXPIRY_SLACK_MS = 60_000;

/**
 * Resolve a usable access token for the workspace's Gmail account,
 * refreshing (and rotating, revision-fenced) as needed. Throws
 * GoogleAuthError — never returns a stale or foreign credential.
 */
export async function gmailAccessToken(workspaceId: string): Promise<{
  token: string;
  email: string;
  googleSub: string;
}> {
  return googleAccessToken(workspaceId, GMAIL_SCOPES, "Gmail");
}

/**
 * Resolve a usable access token for the workspace's Google account with
 * Drive access. Fails closed when Drive scopes were never granted.
 */
export async function driveAccessToken(workspaceId: string): Promise<{
  token: string;
  email: string;
  googleSub: string;
}> {
  return googleAccessToken(workspaceId, DRIVE_SCOPES, "Google Drive");
}

async function googleAccessToken(
  workspaceId: string,
  requiredScopes: readonly string[],
  serviceLabel: string,
): Promise<{
  token: string;
  email: string;
  googleSub: string;
}> {
  const [row] = await db
    .select()
    .from(googleAccountsTable)
    .where(eq(googleAccountsTable.workspaceId, workspaceId))
    .limit(1);
  if (!row) {
    throw new GoogleAuthError(
      "not_connected",
      `No Google account is connected to this workspace. Connect ${serviceLabel} first.`,
    );
  }
  const missing = missingScopes(row.scopes, requiredScopes);
  if (missing.length > 0) {
    // All scopes absent = this service was never connected; a partial set
    // means a grant was narrowed and must be re-consented.
    throw new GoogleAuthError(
      missing.length === requiredScopes.length
        ? "not_connected"
        : "reconnect_required",
      `The connected Google account has not granted the required ${serviceLabel} permissions (${missing.join(", ")}). Connect ${serviceLabel} and grant all requested access.`,
    );
  }
  const cached = accessTokens.get(workspaceId);
  if (
    cached &&
    cached.revision === row.revision &&
    cached.expiresAt - EXPIRY_SLACK_MS > Date.now()
  ) {
    return { token: cached.token, email: row.email, googleSub: row.googleSub };
  }

  const refreshToken = decryptRefreshToken(row.refreshTokenEnc);
  const { clientId, clientSecret } = googleClientConfig();
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
  } catch (error) {
    throw new GoogleAuthError(
      "unavailable",
      `Could not reach Google to refresh the Gmail credential: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    // invalid_grant = revoked or expired consent; anything else 4xx means
    // the credential or client config is no longer accepted. Fail closed
    // with a reconnect, never retry into an ambiguous state.
    const body = await response.text().catch(() => "");
    const invalidGrant = /invalid_grant/i.test(body);
    if (invalidGrant || response.status === 400 || response.status === 401) {
      throw new GoogleAuthError(
        "reconnect_required",
        "Google no longer accepts this Gmail connection (access was revoked or consent expired). Reconnect Gmail.",
      );
    }
    throw new GoogleAuthError(
      "unavailable",
      `Google's token endpoint failed (HTTP ${response.status}).`,
    );
  }
  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!data.access_token) {
    throw new GoogleAuthError(
      "unavailable",
      "Google's token endpoint returned no access token.",
    );
  }
  // Rotation: if Google issued a new refresh token, fold it in only when
  // the row still carries the revision this refresh started from, so a
  // concurrent reconnect or disconnect is never undone by a stale write.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await db
      .update(googleAccountsTable)
      .set({
        refreshTokenEnc: encryptRefreshToken(data.refresh_token),
        revision: randomBytes(16).toString("hex"),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(googleAccountsTable.workspaceId, workspaceId),
          eq(googleAccountsTable.revision, row.revision),
        ),
      );
  }
  const expiresAt = Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000;
  // Cache under the revision we read; a concurrent replace invalidates it.
  accessTokens.set(workspaceId, {
    token: data.access_token,
    expiresAt,
    revision: row.revision,
  });
  return {
    token: data.access_token,
    email: row.email,
    googleSub: row.googleSub,
  };
}

/** Test hook: clear the in-memory access-token cache. */
export function clearGoogleTokenCache(): void {
  accessTokens.clear();
}
