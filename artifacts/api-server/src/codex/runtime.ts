import {
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  codexAuthMaxAgeDays,
  codexBootstrapAuthJson,
  codexFeatureEnabled,
  codexHomeBase,
  codexWorkspaceRoot,
} from "./config";
import { readAuthFacts, type CodexAuthMode } from "./auth-file";
import {
  CodexCredentialError,
  codexCredentialSummary,
  deleteCodexCredential,
  loadCodexCredential,
  officeOwnerClerkId,
  saveCodexCredential,
  saveCodexRefreshIfUnchanged,
  verifyCodexCredential,
} from "./credential-store";

/**
 * The Codex runtime, per signed-in account.
 *
 * Codex authenticates as a ChatGPT account through an `auth.json` that the
 * Codex CLI itself writes and refreshes. HomardClaw never parses the tokens
 * inside it beyond classifying how the session is billed — this module only
 * answers three questions, for one account at a time:
 *
 *   1. Has this account connected a Codex sign-in?
 *   2. Does that sign-in say it is ChatGPT-managed (not an API key)?
 *   3. Is the session fresh enough that Codex's own refresh path still works?
 *
 * The credential is kept in the database, not on disk. It is written into a
 * private per-account directory just before a run, and whatever Codex
 * rewrote is read back into the database afterwards — so a deployment with
 * a throwaway filesystem keeps working, and two accounts never share a
 * session. Every answer is a boolean plus an owner-facing sentence; if any
 * cannot be established, the provider fails closed and no run is attempted.
 */

const AUTH_FILE = "auth.json";
const HOME_MODE = 0o700;
const AUTH_MODE = 0o600;

export type { CodexAuthMode };

export type CodexRuntimeState = {
  /** Server-side feature flag. */
  enabled: boolean;
  /** The account this state describes, or null when nobody is resolved. */
  clerkUserId: string | null;
  /** A private working directory for this account exists and is writable. */
  storageReady: boolean;
  /** Absolute per-account CODEX_HOME, or null when unresolved. */
  home: string | null;
  /**
   * Which stored revision the run materialized. Set only once a run has a
   * working copy on disk, and checked before saving a refresh back so a
   * reconnect or disconnect mid-run is never undone.
   */
  credentialRevision?: string;
  /** This account has a stored Codex sign-in. */
  authPresent: boolean;
  /** How that credential authenticates. */
  authMode: CodexAuthMode;
  /** True only when authMode is "chatgpt" and the session is fresh. */
  usesChatGptAllowance: boolean;
  /** Session too old for Codex's refresh path to have been working. */
  authExpired: boolean;
  /** ISO timestamp of the last SDK-performed refresh, when recorded. */
  lastRefreshAt: string | null;
  /** Stable, non-secret identifier of this account's session, for leases. */
  authFingerprint: string | null;
  /** Whether a run may be attempted right now. */
  ready: boolean;
  /** Owner-facing explanation of the current state. */
  detail: string;
};

export class CodexRuntimeError extends Error {
  constructor(
    readonly kind: "disabled" | "storage" | "auth" | "api_key_auth",
    message: string,
  ) {
    super(message);
    this.name = "CodexRuntimeError";
  }
}

/**
 * Which account a Codex operation runs as. Every caller must say so
 * explicitly: requests pass the signed-in user, task execution passes the
 * owner of the task's workspace, and the health check iterates the accounts
 * that actually stored a sign-in. There is deliberately no fallback — an
 * unknown identity must fail closed rather than quietly run (and bill)
 * whoever happened to set the office up first.
 */
function resolveCodexUser(explicit?: string | null): string | null {
  return explicit ?? null;
}

/**
 * Per-account home directory. The account id is hashed rather than used
 * directly: it keeps the path a fixed, filesystem-safe length and stops an
 * identifier from showing up in process listings and crash dumps.
 */
export function codexHomeFor(clerkUserId: string): string {
  const slug = createHash("sha256").update(clerkUserId).digest("hex").slice(0, 24);
  return path.join(codexHomeBase(), "accounts", slug);
}

export function codexAuthFilePathFor(clerkUserId: string): string {
  return path.join(codexHomeFor(clerkUserId), AUTH_FILE);
}

/**
 * Lease key for one account's Codex session. A hash of the account id —
 * never of the credential — so it is stable across token refreshes and
 * carries nothing sensitive even if it is logged. Two accounts get
 * different keys and therefore run concurrently; one account never runs
 * twice at once against the same ChatGPT session.
 */
export async function codexAuthFingerprint(
  explicitUserId?: string | null,
): Promise<string | null> {
  const clerkUserId = resolveCodexUser(explicitUserId);
  if (!clerkUserId) return null;
  return createHash("sha256")
    .update(`codex-session:${clerkUserId}`)
    .digest("hex")
    .slice(0, 32);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the account's home if needed, lock it down to owner-only, and
 * prove it is writable by round-tripping a probe file. Anything short of a
 * private writable directory is a hard failure — Codex would otherwise
 * store a refreshed credential somewhere world-readable.
 */
async function ensurePrivateHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: HOME_MODE });
  await chmod(home, HOME_MODE);
  const probe = path.join(home, ".homardclaw-write-probe");
  await writeFile(probe, "ok", { mode: AUTH_MODE });
  await unlink(probe);
}

export type CodexConnectOutcome = {
  /**
   * connected  — a sign-in was stored for this account.
   * preserved  — a sign-in was already stored and was left untouched.
   * skipped    — nothing was available to store.
   * unavailable — Codex is switched off, or no account could be resolved.
   */
  action: "connected" | "preserved" | "skipped" | "unavailable";
  detail: string;
};

/**
 * Store a Codex sign-in for one account.
 *
 * This is how a person connects their own ChatGPT allowance: they run
 * `codex login` on a desktop and paste the resulting auth.json, which is
 * encrypted and kept in the database. Their agents then run on their
 * account, not on a credential the operator supplied.
 */
export async function connectCodexCredential(
  clerkUserId: string,
  authJson: string,
): Promise<CodexConnectOutcome> {
  if (!codexFeatureEnabled()) {
    return {
      action: "unavailable",
      detail: "Codex is switched off (CODEX_ENABLED is not set), so nothing was stored.",
    };
  }
  const mode = await saveCodexCredential(clerkUserId, authJson);
  if (mode === "api_key") {
    return {
      action: "connected",
      detail:
        "Stored, but this credential is an API key: runs would be billed to an OpenAI API account rather than a ChatGPT allowance. Sign in with `codex login` (ChatGPT) instead.",
    };
  }
  if (mode === "unknown") {
    return {
      action: "connected",
      detail:
        "Stored, but this file does not identify itself as a ChatGPT session, so it will not be used. Sign in again with `codex login`.",
    };
  }
  return {
    action: "connected",
    detail:
      "Connected. Codex runs now use this ChatGPT account's allowance, and refreshed sessions are saved automatically.",
  };
}

export async function disconnectCodexCredential(
  clerkUserId: string,
): Promise<boolean> {
  const home = codexHomeFor(clerkUserId);
  const authFile = path.join(home, AUTH_FILE);
  // Remove the working copy first: leaving it behind would let a run
  // continue on a session the account just disconnected.
  if (await pathExists(authFile)) await unlink(authFile);
  return deleteCodexCredential(clerkUserId);
}

/**
 * Seed a sign-in from the CODEX_AUTH_JSON environment variable, for
 * operators who prefer to configure one rather than paste it in the app.
 * Only ever fills an *absent* credential: overwriting would roll the
 * session back to a refresh token Codex has already spent.
 *
 * The seed is the *operator's* credential, so it may only ever land on the
 * office owner's account. Any other signed-in account is told to paste its
 * own auth.json instead — CODEX_AUTH_JSON must never quietly hand the
 * operator's ChatGPT allowance to whoever pressed the bootstrap button.
 */
export async function bootstrapCodexHome(
  explicitUserId?: string | null,
): Promise<CodexConnectOutcome> {
  if (!codexFeatureEnabled()) {
    return {
      action: "unavailable",
      detail: "Codex is switched off (CODEX_ENABLED is not set), so nothing was stored.",
    };
  }
  const clerkUserId = resolveCodexUser(explicitUserId);
  if (!clerkUserId) {
    return {
      action: "unavailable",
      detail: "No signed-in account could be resolved to attach a Codex sign-in to.",
    };
  }
  if (await codexCredentialSummary(clerkUserId)) {
    return {
      action: "preserved",
      detail:
        "A Codex sign-in is already connected for this account; it was left untouched so the refreshed session survives.",
    };
  }
  const seed = codexBootstrapAuthJson();
  if (!seed) {
    return {
      action: "skipped",
      detail:
        "No Codex sign-in is connected yet. Run `codex login` on a desktop and paste the auth.json it produces, or set CODEX_AUTH_JSON.",
    };
  }
  const owner = await officeOwnerClerkId();
  if (!owner || owner !== clerkUserId) {
    return {
      action: "skipped",
      detail:
        "CODEX_AUTH_JSON belongs to the office owner's setup, so it was not applied to this account. Run `codex login` on a desktop and paste your own auth.json to connect Codex.",
    };
  }
  const outcome = await connectCodexCredential(clerkUserId, seed);
  if (outcome.action === "connected") {
    // The owner check above races a concurrent legacy hand-over: ownership
    // could move between the read and the store, landing the operator's
    // seed on an account that is no longer the owner. Re-verify and undo
    // rather than leave the seed on the wrong account.
    const ownerAfter = await officeOwnerClerkId();
    if (ownerAfter !== clerkUserId) {
      await deleteCodexCredential(clerkUserId);
      return {
        action: "skipped",
        detail:
          "Office ownership changed while the seed was being stored, so it was removed again. Sign in as the current owner and retry, or paste your own auth.json.",
      };
    }
  }
  return outcome;
}

/**
 * Inspect one account's runtime without mutating anything it depends on.
 * Reads metadata only — the credential is never decrypted here — so this is
 * safe to call on every request and on the background health check.
 */
export async function codexRuntimeState(
  explicitUserId?: string | null,
): Promise<CodexRuntimeState> {
  const enabled = codexFeatureEnabled();
  const base: CodexRuntimeState = {
    enabled,
    clerkUserId: null,
    storageReady: false,
    home: null,
    authPresent: false,
    authMode: "unknown",
    usesChatGptAllowance: false,
    authExpired: false,
    lastRefreshAt: null,
    authFingerprint: null,
    ready: false,
    detail: "",
  };
  if (!enabled) {
    return {
      ...base,
      detail: "Codex is turned off for this workspace (CODEX_ENABLED is not set).",
    };
  }
  const clerkUserId = resolveCodexUser(explicitUserId);
  if (!clerkUserId) {
    return {
      ...base,
      detail:
        "No account was resolved for this Codex operation, so there is no session to use and nothing was run.",
    };
  }
  const home = codexHomeFor(clerkUserId);
  const identified: CodexRuntimeState = {
    ...base,
    clerkUserId,
    home,
    authFingerprint: await codexAuthFingerprint(clerkUserId),
  };
  try {
    await ensurePrivateHome(home);
  } catch (error) {
    return {
      ...identified,
      detail: `Codex could not prepare a private working directory (${home}): ${
        error instanceof Error ? error.name : "unknown error"
      }.`,
    };
  }

  let summary;
  try {
    summary = await codexCredentialSummary(clerkUserId);
  } catch (error) {
    return {
      ...identified,
      storageReady: true,
      detail:
        error instanceof CodexCredentialError
          ? error.message
          : "The stored Codex sign-in could not be read.",
    };
  }
  if (!summary) {
    return {
      ...identified,
      storageReady: true,
      detail:
        "No ChatGPT account is connected yet. Run `codex login` on a desktop and paste the auth.json it produces to use your own Codex allowance.",
    };
  }

  const withAuth: CodexRuntimeState = {
    ...identified,
    storageReady: true,
    authPresent: true,
    authMode: summary.authMode,
    lastRefreshAt: summary.lastRefreshAt,
  };
  if (summary.authMode === "api_key") {
    return {
      ...withAuth,
      detail:
        "This Codex credential is an API key, so runs are billed to the OpenAI API account — not the ChatGPT allowance. Sign in with `codex login` (ChatGPT) if you want subscription-backed runs.",
    };
  }
  if (summary.authMode === "unknown") {
    return {
      ...withAuth,
      detail:
        "The stored Codex sign-in does not identify itself as a ChatGPT session, so it is not treated as one. Sign in again with `codex login`.",
    };
  }

  const readable = await verifyCodexCredential(clerkUserId);
  if (!readable.ok) return { ...withAuth, detail: readable.detail };

  const maxAgeMs = codexAuthMaxAgeDays() * 24 * 60 * 60 * 1000;
  const refreshedAt = summary.lastRefreshAt
    ? Date.parse(summary.lastRefreshAt)
    : Number.NaN;
  if (Number.isFinite(refreshedAt) && Date.now() - refreshedAt > maxAgeMs) {
    return {
      ...withAuth,
      authExpired: true,
      detail: `This ChatGPT session has not refreshed in over ${codexAuthMaxAgeDays()} days, so it is treated as expired. Run \`codex login\` again and reconnect.`,
    };
  }
  return {
    ...withAuth,
    usesChatGptAllowance: true,
    ready: true,
    detail:
      "Signed in with a ChatGPT-managed Codex session. Runs use that account's Codex allowance; the remaining balance is not exposed by the SDK.",
  };
}

/**
 * Write the stored credential into the account's private directory so the
 * Codex CLI can use it. Called immediately before a run; the file is a
 * working copy of the database row, never the other way round.
 */
export async function materializeCodexHome(
  clerkUserId: string,
): Promise<{ home: string; revision: string }> {
  const home = codexHomeFor(clerkUserId);
  await ensurePrivateHome(home);
  const workspaces = codexWorkspaceRoot();
  if (workspaces) await mkdir(workspaces, { recursive: true, mode: HOME_MODE });

  const stored = await loadCodexCredential(clerkUserId);
  if (!stored) {
    throw new CodexRuntimeError(
      "auth",
      "No Codex sign-in is connected for this account, so the run was refused.",
    );
  }
  const authFile = path.join(home, AUTH_FILE);
  const onDisk = await readFileOrNull(authFile);
  if (onDisk !== stored.authJson) {
    await writeFile(authFile, stored.authJson, { mode: AUTH_MODE });
  }
  await chmod(authFile, AUTH_MODE);
  // The revision travels with the run so the write-back afterwards can tell
  // whether it is still saving the session it started from.
  return { home, revision: stored.revision };
}

/**
 * Save back whatever Codex rewrote during a run.
 *
 * The CLI refreshes its own tokens and rewrites auth.json as it goes. On a
 * throwaway filesystem that update is lost at the next restart, and the
 * account would eventually be left holding a spent refresh token, so the
 * new contents are folded back into the database while the run's lease is
 * still held.
 *
 * `expectedRevision` is what the run started from. If the account has
 * reconnected or disconnected since, the write is skipped rather than
 * resurrecting a session the person deliberately replaced.
 */
export async function persistCodexRefresh(
  clerkUserId: string,
  expectedRevision: string,
): Promise<boolean> {
  const authFile = codexAuthFilePathFor(clerkUserId);
  const onDisk = await readFileOrNull(authFile);
  if (onDisk === null) return false;
  // A truncated or half-written file — even one that parses — must never
  // replace a working session.
  const facts = readAuthFacts(onDisk);
  if (!facts || facts.mode === "unknown") return false;
  const stored = await loadCodexCredential(clerkUserId);
  if (stored === null || stored.authJson === onDisk) return false;
  return await saveCodexRefreshIfUnchanged(clerkUserId, onDisk, expectedRevision);
}

/**
 * Drop the plaintext working copy once a run is done with it.
 *
 * The database holds the session; leaving a decrypted copy lying around
 * between runs only widens the window in which it could be read.
 */
export async function clearCodexWorkingCopy(clerkUserId: string): Promise<void> {
  await rm(codexAuthFilePathFor(clerkUserId), { force: true });
}

async function readFileOrNull(target: string): Promise<string | null> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

/**
 * Throw the precise reason a run must not start, or return a state whose
 * credential is on disk and ready for the CLI.
 */
export async function requireCodexRuntime(
  explicitUserId?: string | null,
): Promise<CodexRuntimeState> {
  const state = await codexRuntimeState(explicitUserId);
  if (!state.ready) {
    if (!state.enabled) throw new CodexRuntimeError("disabled", state.detail);
    if (!state.clerkUserId || !state.storageReady) {
      throw new CodexRuntimeError("storage", state.detail);
    }
    if (state.authMode === "api_key") {
      throw new CodexRuntimeError("api_key_auth", state.detail);
    }
    throw new CodexRuntimeError("auth", state.detail);
  }
  const { home, revision } = await materializeCodexHome(
    state.clerkUserId as string,
  );
  return { ...state, home, credentialRevision: revision };
}

/**
 * Environment handed to the Codex CLI.
 *
 * Built from an explicit allowlist rather than by filtering `process.env`,
 * so a future secret added to the server is never inherited by a child
 * process an agent's prompt can influence. API-key variables are pointedly
 * absent: their presence would silently switch Codex from the ChatGPT
 * allowance to metered API billing.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "SHELL",
  "TERM",
  "USER",
] as const;

/** Variables that must never reach Codex, even if they are set here. */
export const CODEX_FORBIDDEN_ENV = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "AI_INTEGRATIONS_OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "CLERK_SECRET_KEY",
  "SESSION_SECRET",
  "DATABASE_URL",
] as const;

export function codexChildEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  env.CODEX_HOME = home;
  // Defensive: the allowlist cannot contain these, but an edit to the list
  // must never be able to reintroduce API-key billing by accident.
  for (const forbidden of CODEX_FORBIDDEN_ENV) delete env[forbidden];
  return env;
}
