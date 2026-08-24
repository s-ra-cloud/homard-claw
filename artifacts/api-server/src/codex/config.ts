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
 * Root under which each account gets its own private Codex directory.
 *
 * This is scratch space on purpose. The credential's home is the database;
 * what lands here is a working copy written just before a run and folded
 * back afterwards, which is what lets Codex work on a deployment whose
 * filesystem is wiped on every restart. CODEX_HOME still overrides the
 * location for operators who want it somewhere specific.
 */
export function codexHomeBase(): string {
  const configured = envValue("CODEX_HOME");
  if (configured?.startsWith("/")) return path.resolve(configured);
  return path.join(path.resolve(tmpdir()), "homardclaw-codex");
}

/** Root of the per-agent isolated Codex working directories. */
export function codexWorkspaceRoot(): string | null {
  const explicit = envValue("CODEX_WORKSPACE_ROOT");
  if (explicit?.startsWith("/")) return path.resolve(explicit);
  return path.join(codexHomeBase(), "workspaces");
}

/** Optional seed, used only when an account has no sign-in stored yet. */
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
