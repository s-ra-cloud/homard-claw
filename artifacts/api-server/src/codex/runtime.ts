import {
  chmod,
  mkdir,
  readFile,
  realpath,
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
  codexHomeAttestedPersistent,
  codexHomePath,
  codexWorkspaceRoot,
  isEphemeralPath,
} from "./config";

/**
 * The private, file-backed Codex runtime.
 *
 * Codex authenticates as the owner's ChatGPT account through an `auth.json`
 * that the Codex CLI itself writes and refreshes. HomardClaw never parses,
 * copies, logs, or transmits the tokens inside it — this module only
 * answers three questions:
 *
 *   1. Is there a private, durable, writable CODEX_HOME?
 *   2. Does `auth.json` say the session is ChatGPT-managed (not an API key)?
 *   3. Is that session fresh enough that Codex's own refresh path still works?
 *
 * Every answer is a boolean plus an owner-facing sentence. If any of them
 * cannot be established, the provider fails closed: no run is attempted.
 */

const AUTH_FILE = "auth.json";
const HOME_MODE = 0o700;
const AUTH_MODE = 0o600;

export type CodexAuthMode = "chatgpt" | "api_key" | "unknown";

export type CodexRuntimeState = {
  /** Server-side feature flag. */
  enabled: boolean;
  /** CODEX_HOME is set, private, and writable. */
  storageReady: boolean;
  /** Absolute CODEX_HOME, or null when unconfigured. */
  home: string | null;
  /** `auth.json` exists inside CODEX_HOME. */
  authPresent: boolean;
  /** How that credential authenticates. */
  authMode: CodexAuthMode;
  /** True only when authMode is "chatgpt" and the session is fresh. */
  usesChatGptAllowance: boolean;
  /** Session too old for Codex's refresh path to have been working. */
  authExpired: boolean;
  /** ISO timestamp of the last SDK-performed refresh, when recorded. */
  lastRefreshAt: string | null;
  /** Stable, non-secret identifier of the auth file, for lease keys. */
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

export function codexAuthFilePath(): string | null {
  const home = codexHomePath();
  return home ? path.join(home, AUTH_FILE) : null;
}

/**
 * Lease key for the auth file. A hash of the *path* — never of the file's
 * contents — so the key is stable across token refreshes and carries no
 * credential material even if it is logged.
 */
export function codexAuthFingerprint(): string | null {
  const file = codexAuthFilePath();
  if (!file) return null;
  return createHash("sha256").update(file).digest("hex").slice(0, 32);
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
 * Create CODEX_HOME if needed, lock it down to owner-only, and prove it is
 * writable by round-tripping a probe file. Anything short of a private
 * writable directory is a hard failure — Codex would otherwise store
 * refreshed credentials on ephemeral or world-readable storage.
 */
async function ensurePrivateHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: HOME_MODE });
  await chmod(home, HOME_MODE);
  const probe = path.join(home, ".homardclaw-write-probe");
  await writeFile(probe, "ok", { mode: AUTH_MODE });
  await unlink(probe);
}

type RawAuth = {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  openai_api_key?: unknown;
  tokens?: { account_id?: unknown } | null;
  last_refresh?: unknown;
};

/**
 * Classify the stored credential. The explicit `auth_mode` written by
 * recent Codex builds wins; older files are classified structurally (an
 * API key present means API billing, a token bundle without one means the
 * ChatGPT session). An unreadable or unrecognized file is "unknown" and is
 * never reported as ChatGPT-backed.
 */
function classify(raw: RawAuth): {
  mode: CodexAuthMode;
  lastRefreshAt: string | null;
} {
  const lastRefresh =
    typeof raw.last_refresh === "string" ? raw.last_refresh : null;
  const declared =
    typeof raw.auth_mode === "string" ? raw.auth_mode.toLowerCase() : null;
  if (declared === "chatgpt") return { mode: "chatgpt", lastRefreshAt: lastRefresh };
  if (declared === "apikey" || declared === "api_key") {
    return { mode: "api_key", lastRefreshAt: lastRefresh };
  }
  const apiKey = raw.OPENAI_API_KEY ?? raw.openai_api_key;
  if (typeof apiKey === "string" && apiKey.trim() !== "") {
    return { mode: "api_key", lastRefreshAt: lastRefresh };
  }
  if (raw.tokens && typeof raw.tokens === "object") {
    return { mode: "chatgpt", lastRefreshAt: lastRefresh };
  }
  return { mode: "unknown", lastRefreshAt: lastRefresh };
}

/**
 * Write `CODEX_AUTH_JSON` into a fresh CODEX_HOME exactly once.
 *
 * The bootstrap only ever fills an *absent* `auth.json`. Codex rewrites
 * that file whenever it refreshes the session, and clobbering it with the
 * original secret would roll the session back to a revoked refresh token.
 */
export type CodexBootstrapOutcome = {
  /**
   * created    — an absent auth.json was seeded from CODEX_AUTH_JSON.
   * preserved  — a credential was already there and was left untouched.
   * skipped    — storage is ready but no credential is available to write.
   * unavailable — Codex is switched off or has no durable private storage.
   */
  action: "created" | "preserved" | "skipped" | "unavailable";
  detail: string;
};

/**
 * Why this CODEX_HOME must not be used, or null when it is acceptable.
 *
 * Shared by the read-only state check and the bootstrap writer on purpose:
 * a credential must never be written anywhere execution would later refuse
 * to run, or the owner is left with a stored ChatGPT session in a location
 * this server has already declared unusable.
 */
async function canonicalHome(home: string): Promise<string> {
  // The directory usually does not exist yet at bootstrap time, so realpath
  // the deepest ancestor that does and re-attach the rest. This resolves a
  // symlinked component anywhere along the path, which a plain path.resolve
  // cannot see.
  let current = path.resolve(home);
  const pending: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return path.join(real, ...pending.reverse());
    } catch {
      const parent = path.dirname(current);
      // Reached the root without finding anything that exists.
      if (parent === current) return path.resolve(home);
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

async function durabilityRefusal(home: string): Promise<string | null> {
  // Checked against the canonical target, not the configured string: both
  // ".." segments and symlinked components otherwise walk straight past
  // this gate into the scratch storage it exists to refuse.
  const canonical = await canonicalHome(home);
  if (isEphemeralPath(home) || isEphemeralPath(canonical)) {
    return `CODEX_HOME (${home}) resolves to ${canonical}, which is scratch storage that a redeploy erases. Codex rewrites auth.json on every token refresh, so the ChatGPT session would silently die there; point it at a Reserved VM persistent volume instead.`;
  }
  if (!codexHomeAttestedPersistent()) {
    return "CODEX_HOME has not been confirmed as persistent storage. Nothing inside the container can tell a Reserved VM volume from an autoscale scratch disk, so Codex stays off until CODEX_HOME_IS_PERSISTENT is set on a deployment whose filesystem actually survives a redeploy.";
  }
  return null;
}

export async function bootstrapCodexHome(): Promise<CodexBootstrapOutcome> {
  if (!codexFeatureEnabled()) {
    return {
      action: "unavailable",
      detail:
        "Codex is switched off (CODEX_ENABLED is not set), so nothing was written.",
    };
  }
  const home = codexHomePath();
  if (!home) {
    return {
      action: "unavailable",
      detail:
        "CODEX_HOME is not set to an absolute path on durable storage, so Codex credentials cannot be stored.",
    };
  }
  // Checked before any mkdir or write: refusing after creating the
  // directory would still have put a credential on undurable storage.
  const refusal = await durabilityRefusal(home);
  if (refusal) return { action: "unavailable", detail: refusal };

  await ensurePrivateHome(home);
  const workspaces = codexWorkspaceRoot();
  if (workspaces) await mkdir(workspaces, { recursive: true, mode: HOME_MODE });

  const authFile = path.join(home, AUTH_FILE);
  if (await pathExists(authFile)) {
    await chmod(authFile, AUTH_MODE);
    return {
      action: "preserved",
      detail:
        "A Codex credential already exists in CODEX_HOME; it was left untouched so the SDK's refreshed session survives.",
    };
  }
  const seed = codexBootstrapAuthJson();
  if (!seed) {
    return {
      action: "skipped",
      detail:
        "CODEX_HOME is ready and private, but no credential is stored yet. Run `codex login` against this CODEX_HOME, or set CODEX_AUTH_JSON and bootstrap again.",
    };
  }
  try {
    JSON.parse(seed);
  } catch {
    // Never echo the value, not even a prefix.
    throw new CodexRuntimeError(
      "auth",
      "CODEX_AUTH_JSON is not valid JSON, so it was not written. Re-copy the whole auth.json produced by `codex login`.",
    );
  }
  await writeFile(authFile, seed, { mode: AUTH_MODE });
  await chmod(authFile, AUTH_MODE);
  return {
    action: "created",
    detail:
      "Stored the ChatGPT credential in CODEX_HOME with owner-only permissions. Codex now owns and refreshes this file.",
  };
}

/**
 * Inspect the runtime without mutating it. Safe to call on every request
 * and on the background health check.
 */
export async function codexRuntimeState(): Promise<CodexRuntimeState> {
  const enabled = codexFeatureEnabled();
  const home = codexHomePath();
  const base: CodexRuntimeState = {
    enabled,
    storageReady: false,
    home,
    authPresent: false,
    authMode: "unknown",
    usesChatGptAllowance: false,
    authExpired: false,
    lastRefreshAt: null,
    authFingerprint: codexAuthFingerprint(),
    ready: false,
    detail: "",
  };
  if (!enabled) {
    return {
      ...base,
      detail: "Codex is turned off for this workspace (CODEX_ENABLED is not set).",
    };
  }
  if (!home) {
    return {
      ...base,
      detail:
        "Codex needs CODEX_HOME pointed at an absolute path on durable, private storage. Without it the refreshed ChatGPT session would be lost on every redeploy, so Codex stays disabled.",
    };
  }
  const durability = await durabilityRefusal(home);
  if (durability) return { ...base, detail: durability };
  try {
    await ensurePrivateHome(home);
  } catch (error) {
    return {
      ...base,
      detail: `CODEX_HOME (${home}) is not writable, so Codex cannot store or refresh its credential: ${
        error instanceof Error ? error.name : "unknown error"
      }.`,
    };
  }

  const authFile = path.join(home, AUTH_FILE);
  if (!(await pathExists(authFile))) {
    return {
      ...base,
      storageReady: true,
      detail:
        "CODEX_HOME is ready but holds no credential yet. Sign in with `codex login` against this CODEX_HOME (or bootstrap CODEX_AUTH_JSON) to use the ChatGPT allowance.",
    };
  }

  let raw: RawAuth;
  try {
    raw = JSON.parse(await readFile(authFile, "utf8")) as RawAuth;
  } catch {
    return {
      ...base,
      storageReady: true,
      authPresent: true,
      detail:
        "The stored Codex credential could not be read as JSON. Sign in again with `codex login` to rewrite it.",
    };
  }

  const { mode, lastRefreshAt } = classify(raw);
  if (mode === "api_key") {
    return {
      ...base,
      storageReady: true,
      authPresent: true,
      authMode: "api_key",
      lastRefreshAt,
      detail:
        "This Codex credential is an API key, so runs are billed to the OpenAI API account — not the ChatGPT allowance. Sign in with `codex login` (ChatGPT) if you want subscription-backed runs.",
    };
  }
  if (mode === "unknown") {
    return {
      ...base,
      storageReady: true,
      authPresent: true,
      detail:
        "The stored Codex credential does not identify itself as a ChatGPT session, so it is not treated as one. Sign in again with `codex login`.",
    };
  }

  const maxAgeMs = codexAuthMaxAgeDays() * 24 * 60 * 60 * 1000;
  const refreshedAt = lastRefreshAt ? Date.parse(lastRefreshAt) : Number.NaN;
  const authExpired =
    Number.isFinite(refreshedAt) && Date.now() - refreshedAt > maxAgeMs;
  if (authExpired) {
    return {
      ...base,
      storageReady: true,
      authPresent: true,
      authMode: "chatgpt",
      lastRefreshAt,
      authExpired: true,
      detail: `The ChatGPT session has not refreshed in over ${codexAuthMaxAgeDays()} days, so it is treated as expired. Run \`codex login\` against this CODEX_HOME to reauthenticate.`,
    };
  }
  return {
    ...base,
    storageReady: true,
    authPresent: true,
    authMode: "chatgpt",
    usesChatGptAllowance: true,
    lastRefreshAt,
    ready: true,
    detail:
      "Signed in with a ChatGPT-managed Codex session. Runs use the ChatGPT Codex allowance; the remaining balance is not exposed by the SDK.",
  };
}

/** Throw the precise reason a run must not start. */
export async function requireCodexRuntime(): Promise<CodexRuntimeState> {
  const state = await codexRuntimeState();
  if (state.ready) return state;
  if (!state.enabled) throw new CodexRuntimeError("disabled", state.detail);
  if (!state.storageReady) throw new CodexRuntimeError("storage", state.detail);
  if (state.authMode === "api_key") {
    throw new CodexRuntimeError("api_key_auth", state.detail);
  }
  throw new CodexRuntimeError("auth", state.detail);
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
