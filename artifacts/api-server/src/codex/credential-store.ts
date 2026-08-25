/**
 * Where a Codex sign-in actually lives.
 *
 * A published app has no durable disk — every deployment type wipes the
 * filesystem on restart and redeploy — while the Codex CLI keeps its
 * ChatGPT session in a file it rewrites on every token refresh. Storing it
 * on disk therefore means the login silently dies at the next publish.
 *
 * So the database is the source of truth and the filesystem is a working
 * copy: the credential is written out only for the duration of a run and
 * whatever Codex refreshed is read back here afterwards. Each row belongs
 * to one Clerk account, so runs draw on that person's own ChatGPT
 * allowance rather than a shared one.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { codexCredentialsTable, db, systemStateTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  classifyAuthJson,
  type CodexAuthFacts,
  type CodexAuthMode,
  type RawAuth,
} from "./auth-file";

export class CodexCredentialError extends Error {
  constructor(
    readonly kind: "unusable_key" | "invalid_json" | "undecryptable",
    message: string,
  ) {
    super(message);
    this.name = "CodexCredentialError";
  }
}

const FORMAT = "v1";

/**
 * The encryption key is derived from SESSION_SECRET rather than a new
 * secret of its own: it already exists in every environment, is already
 * treated as sensitive, and is already rotated deliberately. Rotating it
 * makes stored Codex sign-ins undecryptable, which surfaces as "reconnect
 * Codex" rather than as silent, wrong behaviour.
 */
function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new CodexCredentialError(
      "unusable_key",
      "SESSION_SECRET is not set on this server, so a Codex sign-in cannot be stored securely.",
    );
  }
  return createHash("sha256").update(`codex-credential:${secret}`).digest();
}

function encrypt(plaintext: string): string {
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

function decrypt(payload: string): string {
  const [format, iv, tag, sealed] = payload.split(".");
  if (format !== FORMAT || !iv || !tag || !sealed) {
    throw new CodexCredentialError(
      "undecryptable",
      "The stored Codex sign-in is not in a format this server understands. Reconnect Codex.",
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
    if (error instanceof CodexCredentialError) throw error;
    // Wrong key or tampered ciphertext are indistinguishable here, and
    // both mean the same thing to the person using the app.
    throw new CodexCredentialError(
      "undecryptable",
      "The stored Codex sign-in could not be decrypted, usually because SESSION_SECRET changed. Reconnect Codex.",
    );
  }
}

export type CodexCredentialSummary = {
  authMode: CodexAuthMode;
  lastRefreshAt: string | null;
  connectedAt: Date;
  updatedAt: Date;
};

/**
 * Every account that has a Codex sign-in stored. Metadata only — used by
 * the background health check to watch each connected session instead of
 * assuming a single global one.
 */
export async function listCodexAccountIds(): Promise<string[]> {
  const rows = await db
    .select({ clerkUserId: codexCredentialsTable.clerkUserId })
    .from(codexCredentialsTable);
  return rows.map((row) => row.clerkUserId);
}

/** Metadata only — this never decrypts, so it is safe on every request. */
export async function codexCredentialSummary(
  clerkUserId: string,
): Promise<CodexCredentialSummary | null> {
  const [row] = await db
    .select()
    .from(codexCredentialsTable)
    .where(eq(codexCredentialsTable.clerkUserId, clerkUserId))
    .limit(1);
  if (!row) return null;
  return {
    authMode: row.authMode as CodexAuthMode,
    lastRefreshAt: row.lastRefreshAt?.toISOString() ?? null,
    connectedAt: row.connectedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Confirm the stored sign-in can still be decrypted, without handing the
 * plaintext to the caller.
 *
 * Status checks otherwise read only metadata columns, which stay readable
 * after SESSION_SECRET is rotated — the provider would report itself ready
 * and then fail at run time. This is the cheap round-trip that keeps
 * "ready" honest.
 */
export async function verifyCodexCredential(
  clerkUserId: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const stored = await loadCodexCredential(clerkUserId);
    return stored === null
      ? { ok: false, detail: "No Codex sign-in is stored for this account." }
      : { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof CodexCredentialError
          ? error.message
          : "The stored Codex sign-in could not be read.",
    };
  }
}

/**
 * The decrypted auth.json plus the revision it was read at. Callers must
 * not log or return `authJson`; `revision` is an opaque id and is safe to
 * carry through a run.
 */
export async function loadCodexCredential(
  clerkUserId: string,
): Promise<{ authJson: string; revision: string } | null> {
  const [row] = await db
    .select()
    .from(codexCredentialsTable)
    .where(eq(codexCredentialsTable.clerkUserId, clerkUserId))
    .limit(1);
  return row ? { authJson: decrypt(row.authJson), revision: row.revision } : null;
}

/**
 * Store a sign-in for one account, replacing whatever was there.
 *
 * Used both for the initial connect and for saving back what Codex
 * refreshed mid-run, so it deliberately accepts an existing row: refusing
 * to overwrite would strand the account on a spent refresh token.
 */
function readAuthFactsOrThrow(authJson: string): CodexAuthFacts {
  let parsed: RawAuth;
  try {
    parsed = JSON.parse(authJson) as RawAuth;
  } catch {
    // Never echo any part of the value, not even a prefix.
    throw new CodexCredentialError(
      "invalid_json",
      "That is not valid JSON. Copy the whole contents of the auth.json produced by `codex login`.",
    );
  }
  return classifyAuthJson(parsed);
}

export async function saveCodexCredential(
  clerkUserId: string,
  authJson: string,
): Promise<CodexAuthMode> {
  const facts = readAuthFactsOrThrow(authJson);
  const lastRefreshAt = facts.lastRefreshAt
    ? new Date(facts.lastRefreshAt)
    : null;
  const value = {
    authJson: encrypt(authJson),
    authMode: facts.mode,
    lastRefreshAt:
      lastRefreshAt && !Number.isNaN(lastRefreshAt.getTime())
        ? lastRefreshAt
        : null,
    // A new revision on every connect, so a run that is still holding the
    // previous one cannot write its session back over this one.
    revision: randomUUID(),
    updatedAt: new Date(),
  };
  await db
    .insert(codexCredentialsTable)
    .values({ clerkUserId, ...value })
    .onConflictDoUpdate({
      target: codexCredentialsTable.clerkUserId,
      set: value,
    });
  return facts.mode;
}

/**
 * Save a session Codex refreshed during a run, but only if the account has
 * not connected or disconnected in the meantime.
 *
 * A run materializes the sign-in it started with. If the person replaces
 * it, or disconnects, while the run is still going, writing back on the
 * way out would restore the old (by then spent) refresh token or undo the
 * disconnect. The revision check makes that write a no-op instead.
 */
export async function saveCodexRefreshIfUnchanged(
  clerkUserId: string,
  authJson: string,
  expectedRevision: string,
): Promise<boolean> {
  const facts = readAuthFactsOrThrow(authJson);
  const lastRefreshAt = facts.lastRefreshAt
    ? new Date(facts.lastRefreshAt)
    : null;
  const updated = await db
    .update(codexCredentialsTable)
    .set({
      authJson: encrypt(authJson),
      authMode: facts.mode,
      lastRefreshAt:
        lastRefreshAt && !Number.isNaN(lastRefreshAt.getTime())
          ? lastRefreshAt
          : null,
      revision: randomUUID(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(codexCredentialsTable.clerkUserId, clerkUserId),
        eq(codexCredentialsTable.revision, expectedRevision),
      ),
    )
    .returning({ revision: codexCredentialsTable.revision });
  return updated.length > 0;
}

export async function deleteCodexCredential(
  clerkUserId: string,
): Promise<boolean> {
  const removed = await db
    .delete(codexCredentialsTable)
    .where(eq(codexCredentialsTable.clerkUserId, clerkUserId))
    .returning({ clerkUserId: codexCredentialsTable.clerkUserId });
  return removed.length > 0;
}

/**
 * Whose credential a background run should use.
 *
 * Agents, tasks, and schedules carry no owner of their own yet — the whole
 * office belongs to one account — so work executed by the worker draws on
 * that account's Codex sign-in. When rows gain an owner, this is the single
 * place that has to start reading it from the task instead.
 */
export async function officeOwnerClerkId(): Promise<string | null> {
  const [row] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "owner_clerk_id"))
    .limit(1);
  return row?.value ?? null;
}
