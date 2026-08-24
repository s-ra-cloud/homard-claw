/**
 * Server-side Codex configuration.
 *
 * Everything the Codex provider is allowed to offer — whether it exists at
 * all, which models and reasoning levels may be selected, where its private
 * home lives — is decided here, on the server, from environment
 * configuration. Nothing in this module reads or returns credential
 * material: `CODEX_AUTH_JSON` is consumed once by the runtime bootstrap and
 * never surfaced.
 */

import { tmpdir } from "node:os";
import path from "node:path";

export type CodexModel = {
  id: string;
  name: string;
  contextLength: number | null;
};

/**
 * Supported Codex models. The owner's ChatGPT plan decides which of these
 * actually run; HomardClaw only decides which may be *selected*. Override
 * with CODEX_MODELS as `id:Display Name:contextLength` entries separated by
 * commas when OpenAI's line-up changes, so a rename does not need a deploy.
 */
const BUILT_IN_MODELS: CodexModel[] = [
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextLength: 400000 },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextLength: 400000 },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextLength: 400000 },
];

const DEFAULT_MODEL_ID = "gpt-5.6-terra";

/**
 * Reasoning levels the Codex CLI accepts. The selectable subset is server
 * configuration (CODEX_REASONING_LEVELS); the full list is what the SDK's
 * `modelReasoningEffort` will not reject.
 */
export const CODEX_REASONING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type CodexReasoningLevel = (typeof CODEX_REASONING_LEVELS)[number];

const DEFAULT_REASONING: CodexReasoningLevel = "medium";

function envValue(key: string): string | null {
  const raw = process.env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function envFlag(key: string): boolean {
  const value = envValue(key)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * The Codex provider is invisible unless the server operator turns it on.
 * Read live (not cached at import) so tests and the owner-facing status can
 * both observe a change without a restart.
 */
export function codexFeatureEnabled(): boolean {
  return envFlag("CODEX_ENABLED");
}

function parseModels(raw: string): CodexModel[] {
  const models: CodexModel[] = [];
  for (const entry of raw.split(",")) {
    const [id, name, context] = entry.split(":").map((part) => part.trim());
    if (!id) continue;
    const contextLength = Number(context);
    models.push({
      id,
      name: name && name !== "" ? name : id,
      contextLength: Number.isFinite(contextLength) && contextLength > 0
        ? contextLength
        : null,
    });
  }
  return models;
}

export function codexModels(): CodexModel[] {
  const override = envValue("CODEX_MODELS");
  if (override) {
    const parsed = parseModels(override);
    if (parsed.length > 0) return parsed;
  }
  return BUILT_IN_MODELS;
}

export function codexDefaultModel(): string {
  const models = codexModels();
  const configured = envValue("CODEX_DEFAULT_MODEL");
  if (configured && models.some((model) => model.id === configured)) {
    return configured;
  }
  if (models.some((model) => model.id === DEFAULT_MODEL_ID)) {
    return DEFAULT_MODEL_ID;
  }
  return models[0]?.id ?? DEFAULT_MODEL_ID;
}

export function isCodexModel(model: string): boolean {
  return codexModels().some((entry) => entry.id === model);
}

export function codexReasoningLevels(): CodexReasoningLevel[] {
  const override = envValue("CODEX_REASONING_LEVELS");
  if (override) {
    const parsed = override
      .split(",")
      .map((level) => level.trim().toLowerCase())
      .filter((level): level is CodexReasoningLevel =>
        (CODEX_REASONING_LEVELS as readonly string[]).includes(level),
      );
    if (parsed.length > 0) return parsed;
  }
  return ["low", "medium", "high"];
}

export function codexDefaultReasoning(): CodexReasoningLevel {
  const levels = codexReasoningLevels();
  const configured = envValue("CODEX_DEFAULT_REASONING")?.toLowerCase();
  if (
    configured &&
    levels.includes(configured as CodexReasoningLevel)
  ) {
    return configured as CodexReasoningLevel;
  }
  if (levels.includes(DEFAULT_REASONING)) return DEFAULT_REASONING;
  return levels[0] ?? DEFAULT_REASONING;
}

export function isCodexReasoningLevel(value: string): value is CodexReasoningLevel {
  return codexReasoningLevels().includes(value as CodexReasoningLevel);
}

/**
 * Absolute path of the private CODEX_HOME. Null means the operator has not
 * pointed Codex at durable storage yet — the provider then fails closed
 * rather than writing credentials somewhere that vanishes on redeploy.
 */
export function codexHomePath(): string | null {
  const configured = envValue("CODEX_HOME");
  if (!configured) return null;
  if (!configured.startsWith("/")) return null;
  // Normalised immediately: every durability check downstream compares
  // against this string, and "/looks-durable/../tmp/x" is /tmp/x to every
  // syscall that follows.
  return path.resolve(configured);
}

/**
 * Filesystem roots that are provably not durable: process-local scratch that
 * a redeploy, a restart, or the OS itself is entitled to erase. A refreshed
 * ChatGPT session written here is gone by the next deploy, and because Codex
 * rewrites auth.json on every refresh, that is not a slow degradation — it
 * silently invalidates the login.
 */
const EPHEMERAL_ROOTS = ["/tmp", "/var/tmp", "/dev/shm", "/run"];

/**
 * Whether a path sits under a root we know cannot survive a redeploy.
 *
 * Callers must pass a fully canonical path — resolved for `..` *and* for
 * symlinked components. A raw string comparison is trivially defeated by
 * either, and the syscalls that follow use the resolved target regardless.
 */
export function isEphemeralPath(candidate: string): boolean {
  const roots = new Set([...EPHEMERAL_ROOTS, path.resolve(tmpdir())]);
  const resolved = path.resolve(candidate);
  for (const root of roots) {
    const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
    if (resolved === normalized || resolved.startsWith(`${normalized}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the operator has attested that CODEX_HOME is on a persistent
 * volume.
 *
 * Nothing readable from inside the container distinguishes a Reserved VM's
 * persistent disk from an autoscale instance's scratch disk — both are just
 * writable directories. Rather than infer durability and be wrong, the
 * decision is handed to the person who provisioned the volume, and Codex
 * stays off until they make it. Combined with the ephemeral-root check
 * above, an obviously wrong answer is still refused.
 */
export function codexHomeAttestedPersistent(): boolean {
  const raw = envValue("CODEX_HOME_IS_PERSISTENT")?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Root of the per-agent isolated Codex working directories. */
export function codexWorkspaceRoot(): string | null {
  const explicit = envValue("CODEX_WORKSPACE_ROOT");
  if (explicit?.startsWith("/")) return path.resolve(explicit);
  const home = codexHomePath();
  return home ? `${home}/workspaces` : null;
}

/** Bootstrap material, consumed once when `auth.json` does not exist yet. */
export function codexBootstrapAuthJson(): string | null {
  return envValue("CODEX_AUTH_JSON");
}

/**
 * How stale a ChatGPT credential may get before HomardClaw calls it expired.
 * Codex refreshes its own tokens on every run, so a `last_refresh` older
 * than this means the refresh path itself has stopped working.
 */
export function codexAuthMaxAgeDays(): number {
  const raw = Number(envValue("CODEX_AUTH_MAX_AGE_DAYS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 28;
}

/** Interval for the background credential health check, in minutes. */
export function codexHealthCheckMinutes(): number {
  const raw = Number(envValue("CODEX_HEALTH_CHECK_MINUTES"));
  return Number.isFinite(raw) && raw >= 5 ? raw : 30;
}

/** Ceiling on how long one Codex turn may hold the auth-file lease. */
export function codexLeaseTtlMs(): number {
  const raw = Number(envValue("CODEX_LEASE_TTL_SECONDS"));
  const seconds = Number.isFinite(raw) && raw >= 60 ? raw : 600;
  return seconds * 1000;
}

/**
 * How often a live run pushes its lease expiry out. A third of the TTL
 * leaves room for two missed beats — a transient database blip must not
 * look like a lost lease — while still expiring promptly once the holder
 * is genuinely gone.
 */
export function codexLeaseHeartbeatMs(): number {
  if (heartbeatOverrideMs !== null) return heartbeatOverrideMs;
  return Math.max(1_000, Math.floor(codexLeaseTtlMs() / 3));
}

let heartbeatOverrideMs: number | null = null;

/**
 * Test hook. The TTL floor is a minute, so the lease-loss path is otherwise
 * only reachable by waiting one out; this shortens the beat instead. Pass
 * null to restore the derived interval.
 */
export function setCodexLeaseHeartbeatMs(ms: number | null): void {
  heartbeatOverrideMs = ms;
}
