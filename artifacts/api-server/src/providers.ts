import { db, workspaceSettingsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  codexDefaultModel,
  codexDefaultReasoning,
  codexFeatureEnabled,
  codexModels,
  codexReasoningLevels,
  isCodexModel,
  isCodexReasoningLevel,
  type CodexReasoningLevel,
} from "./codex/config";
import { codexRuntimeState } from "./codex/runtime";
import { codexSdkAvailable } from "./codex/sdk";
import {
  getProviderCredential,
  hasProviderCredential,
  ProviderCredentialError,
} from "./provider-credentials";

/**
 * Server-side provider registry: credentials, health, model discovery,
 * routing defaults, and token/cost estimation.
 *
 * Claude Code and OpenRouter credentials are stored per workspace,
 * encrypted, and entered by each workspace's own user (see
 * provider-credentials.ts); Codex uses a private file-backed CODEX_HOME
 * the Codex CLI owns. There is no server-environment fallback: a
 * workspace without its own credential is simply not configured, so it
 * can never draw on the operator's or another workspace's allowance.
 * Credentials never leave these modules — status payloads carry booleans
 * and human-readable messages only.
 *
 * `claude_max` is the persisted identifier for the provider the office
 * calls "Claude Code". The stored value is deliberately unchanged so
 * existing agents, tasks, schedules, and permission allow-lists keep
 * working; only the display name comes from PROVIDER_LABELS.
 */

export type ProviderId = "claude_max" | "codex_chatgpt" | "openrouter";

export const PROVIDER_IDS: ProviderId[] = [
  "claude_max",
  "codex_chatgpt",
  "openrouter",
];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude_max: "Claude Code",
  codex_chatgpt: "Codex via ChatGPT Plus",
  openrouter: "OpenRouter",
};

/**
 * How a provider is paid for. Subscription providers draw on a plan
 * allowance and have no per-token price to estimate or record; metered
 * providers bill per token and are governed by the budget rules.
 */
export type ProviderBilling = "subscription" | "metered";

export const PROVIDER_BILLING: Record<ProviderId, ProviderBilling> = {
  claude_max: "subscription",
  codex_chatgpt: "subscription",
  openrouter: "metered",
};

export function isMeteredProvider(provider: string): boolean {
  return PROVIDER_BILLING[provider as ProviderId] !== "subscription";
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as string[]).includes(value);
}

/**
 * Providers this workspace may actually select. Codex is invisible unless
 * the server-side feature flag turns it on; a task or agent that still
 * references it is reported honestly rather than silently rerouted.
 */
export function availableProviderIds(): ProviderId[] {
  return PROVIDER_IDS.filter(
    (provider) => provider !== "codex_chatgpt" || codexFeatureEnabled(),
  );
}

/** Built-in routing fallback when no workspace default model is set. */
export const FALLBACK_MODEL: Record<ProviderId, string> = {
  claude_max: "claude-sonnet-4-5",
  get codex_chatgpt() {
    return codexDefaultModel();
  },
  openrouter: "anthropic/claude-sonnet-4.5",
};

export type ProviderModel = {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD cents per million prompt tokens; null when pricing is unknown. */
  promptCentsPerMTok: number | null;
  completionCentsPerMTok: number | null;
};

export type ModelCatalog = {
  provider: ProviderId;
  available: boolean;
  message: string | null;
  models: ProviderModel[];
};

export type ProviderHealth = {
  provider: ProviderId;
  label: string;
  billing: ProviderBilling;
  /** False when a server-side flag hides the provider entirely. */
  enabled: boolean;
  configured: boolean;
  healthy: boolean;
  message: string;
  /**
   * Codex only: how the stored credential authenticates. "chatgpt" is the
   * only value that draws on the ChatGPT Codex allowance.
   */
  authMode: "chatgpt" | "api_key" | "unknown" | null;
  /**
   * True only when file-backed credentials confirm a ChatGPT-managed
   * session. Never inferred from the provider id.
   */
  usesSubscriptionAllowance: boolean;
  /**
   * Whether the remaining plan allowance is knowable. Both subscription
   * providers report false: neither exposes a balance, and inventing one
   * would be a lie.
   */
  allowanceBalanceKnown: boolean;
  /**
   * Reasoning effort levels this provider accepts, straight from server
   * configuration. Empty for providers that have no such control, so the
   * UI never has to hard-code a list that the server might reject.
   */
  reasoningLevels: string[];
};

/**
 * Cheap configured check used on the dispatch path: does THIS workspace
 * hold a credential for the provider? For Codex this only answers "is it
 * switched on" — whether the account has actually connected a ChatGPT
 * session is a separate check that runs asynchronously immediately before
 * execution.
 */
export async function isConfigured(
  workspaceId: string,
  provider: ProviderId,
): Promise<boolean> {
  if (provider === "codex_chatgpt") {
    return codexFeatureEnabled();
  }
  return hasProviderCredential(workspaceId, provider);
}

/** Owner-facing name; never derive one from the persisted id in the UI. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as ProviderId] ?? provider;
}

// Anthropic does not expose pricing over the API; the catalog is maintained
// here in cents per million tokens. Claude Max execution is covered by the
// subscription, so estimates for claude_max report zero incremental cost —
// pricing is kept for reference and for metered usage recording.
const CLAUDE_CATALOG: ProviderModel[] = [
  { id: "claude-opus-4-1", name: "Claude Opus 4.1", contextLength: 200000, promptCentsPerMTok: 1500, completionCentsPerMTok: 7500 },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextLength: 200000, promptCentsPerMTok: 300, completionCentsPerMTok: 1500 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextLength: 200000, promptCentsPerMTok: 100, completionCentsPerMTok: 500 },
  { id: "claude-sonnet-4-0", name: "Claude Sonnet 4", contextLength: 200000, promptCentsPerMTok: 300, completionCentsPerMTok: 1500 },
  { id: "claude-3-5-haiku-latest", name: "Claude Haiku 3.5", contextLength: 200000, promptCentsPerMTok: 80, completionCentsPerMTok: 400 },
];

const HEALTH_TTL_MS = 60_000;
const MODELS_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 6_000;

type Cached<T> = { at: number; value: T };
/** Keyed by `${provider}:${workspaceId}` — health is per workspace now. */
const healthCache = new Map<string, Cached<ProviderHealth>>();
let openrouterModelsCache: Cached<ModelCatalog> | null = null;

/** Test hook: drop caches so suites can exercise fresh lookups. */
export function clearProviderCaches(): void {
  healthCache.clear();
  openrouterModelsCache = null;
}

async function timedFetch(url: string, init: RequestInit): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fixed classification only — never the raw error message. Health probes
 * send a decrypted workspace credential in request headers, and some
 * transport/SDK errors echo request headers back, so quoting the message
 * here could hand the credential to the browser in a status payload.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Request timed out";
  }
  return "Network error";
}

/** Shared shape so every health payload answers the same questions. */
function baseHealth(provider: ProviderId): ProviderHealth {
  return {
    provider,
    label: PROVIDER_LABELS[provider],
    billing: PROVIDER_BILLING[provider],
    enabled: true,
    configured: false,
    healthy: false,
    message: "",
    authMode: null,
    usesSubscriptionAllowance: false,
    allowanceBalanceKnown: false,
    reasoningLevels:
      provider === "codex_chatgpt" ? [...codexReasoningLevels()] : [],
  };
}

async function checkClaude(workspaceId: string): Promise<ProviderHealth> {
  const base = baseHealth("claude_max");
  let token: string | null;
  try {
    token = await getProviderCredential(workspaceId, "claude_max");
  } catch (error) {
    if (error instanceof ProviderCredentialError) {
      return { ...base, configured: true, healthy: false, message: error.message };
    }
    throw error;
  }
  if (!token) {
    return {
      ...base,
      configured: false,
      healthy: false,
      message:
        "Add your Claude Code OAuth token on the Providers page to enable Claude Code execution.",
    };
  }
  try {
    const res = await timedFetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (res.ok) {
      return {
        ...base,
        configured: true,
        healthy: true,
        usesSubscriptionAllowance: true,
        message: "Claude endpoint reachable and credential accepted.",
      };
    }
    return {
      ...base,
      configured: true,
      healthy: false,
      message:
        res.status === 401 || res.status === 403
          ? `Claude rejected the credential (HTTP ${res.status}). Enter a fresh Claude Code OAuth token.`
          : `Claude endpoint returned HTTP ${res.status}.`,
    };
  } catch (error) {
    return {
      ...base,
      configured: true,
      healthy: false,
      message: `Claude endpoint unreachable: ${describeFailure(error)}.`,
    };
  }
}

/**
 * Codex health. Everything here is local: the private CODEX_HOME, the
 * `auth_mode` the Codex CLI itself recorded, and whether the SDK can be
 * loaded. No request is made to OpenAI, so checking status never spends
 * the owner's allowance.
 */
async function checkCodex(): Promise<ProviderHealth> {
  const base = baseHealth("codex_chatgpt");
  const state = await codexRuntimeState();
  if (!state.enabled) {
    return {
      ...base,
      enabled: false,
      message: state.detail,
      authMode: null,
    };
  }
  const sdk = await codexSdkAvailable();
  const authMode = state.authPresent ? state.authMode : null;
  if (!sdk.available) {
    return {
      ...base,
      configured: state.storageReady,
      message: sdk.detail,
      authMode,
      usesSubscriptionAllowance: false,
    };
  }
  if (!state.ready) {
    return {
      ...base,
      configured: state.storageReady,
      message: state.detail,
      authMode,
    };
  }
  return {
    ...base,
    configured: true,
    healthy: true,
    message: state.detail,
    authMode: "chatgpt",
    usesSubscriptionAllowance: true,
  };
}

type OpenRouterModelRow = {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
};

function centsPerMTok(usdPerToken: string | undefined): number | null {
  if (usdPerToken === undefined) return null;
  const perToken = Number(usdPerToken);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  return perToken * 1_000_000 * 100;
}

/**
 * The OpenRouter model catalog (names, context lengths, pricing) is public
 * data served without authentication, so it is fetched once for the whole
 * server and never with any workspace's key. Workspace credentials only
 * come into play for health checks and actual completions.
 */
async function fetchOpenRouterCatalog(): Promise<ModelCatalog> {
  if (openrouterModelsCache && Date.now() - openrouterModelsCache.at < MODELS_TTL_MS) {
    return openrouterModelsCache.value;
  }
  let catalog: ModelCatalog;
  try {
    const res = await timedFetch("https://openrouter.ai/api/v1/models", {});
    if (!res.ok) {
      catalog = {
        provider: "openrouter",
        available: false,
        message: `OpenRouter model listing failed with HTTP ${res.status}.`,
        models: [],
      };
    } else {
      const body = (await res.json()) as { data?: OpenRouterModelRow[] };
      const models = (body.data ?? [])
        .map((row) => ({
          id: row.id,
          name: row.name ?? row.id,
          contextLength: row.context_length ?? null,
          promptCentsPerMTok: centsPerMTok(row.pricing?.prompt),
          completionCentsPerMTok: centsPerMTok(row.pricing?.completion),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      catalog = { provider: "openrouter", available: true, message: null, models };
    }
  } catch (error) {
    catalog = {
      provider: "openrouter",
      available: false,
      message: `OpenRouter unreachable: ${describeFailure(error)}.`,
      models: [],
    };
  }
  // Cache successes for the full TTL; cache failures briefly so a flap does
  // not hammer the endpoint but recovery is quick.
  openrouterModelsCache = {
    at: catalog.available ? Date.now() : Date.now() - MODELS_TTL_MS + 15_000,
    value: catalog,
  };
  return catalog;
}

export async function getModelCatalog(
  workspaceId: string,
  provider: ProviderId,
): Promise<ModelCatalog> {
  if (provider === "claude_max") {
    const configured = await isConfigured(workspaceId, "claude_max");
    return {
      provider: "claude_max",
      available: configured,
      message: configured
        ? null
        : "Add your Claude Code OAuth token on the Providers page to enable Claude Code execution.",
      models: CLAUDE_CATALOG,
    };
  }
  if (provider === "codex_chatgpt") {
    const health = await getProviderHealth(workspaceId, "codex_chatgpt");
    return {
      provider: "codex_chatgpt",
      available: health.enabled && health.configured,
      message: health.healthy ? null : health.message,
      // Codex is subscription-backed, so there is no per-token price to
      // publish. Leaving pricing null keeps estimates honest.
      models: codexModels().map((model) => ({
        id: model.id,
        name: model.name,
        contextLength: model.contextLength,
        promptCentsPerMTok: null,
        completionCentsPerMTok: null,
      })),
    };
  }
  return fetchOpenRouterCatalog();
}

/**
 * OpenRouter health for one workspace: is a key stored, and does
 * OpenRouter accept it? The probe hits the key-status endpoint, which
 * costs nothing and never runs a completion.
 */
async function checkOpenRouter(workspaceId: string): Promise<ProviderHealth> {
  const base = baseHealth("openrouter");
  let key: string | null;
  try {
    key = await getProviderCredential(workspaceId, "openrouter");
  } catch (error) {
    if (error instanceof ProviderCredentialError) {
      return { ...base, configured: true, healthy: false, message: error.message };
    }
    throw error;
  }
  if (!key) {
    return {
      ...base,
      configured: false,
      healthy: false,
      message:
        "Add your OpenRouter API key on the Providers page to enable OpenRouter execution.",
    };
  }
  try {
    const res = await timedFetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      return {
        ...base,
        configured: true,
        healthy: true,
        message: "OpenRouter reachable and credential accepted.",
      };
    }
    return {
      ...base,
      configured: true,
      healthy: false,
      message:
        res.status === 401 || res.status === 403
          ? `OpenRouter rejected the credential (HTTP ${res.status}). Enter a fresh API key.`
          : `OpenRouter returned HTTP ${res.status}.`,
    };
  } catch (error) {
    return {
      ...base,
      configured: true,
      healthy: false,
      message: `OpenRouter unreachable: ${describeFailure(error)}.`,
    };
  }
}

export async function getProviderHealth(
  workspaceId: string,
  provider: ProviderId,
): Promise<ProviderHealth> {
  const cacheKey = `${provider}:${workspaceId}`;
  const cached = healthCache.get(cacheKey);
  if (cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.value;
  let health: ProviderHealth;
  if (provider === "claude_max") {
    health = await checkClaude(workspaceId);
  } else if (provider === "codex_chatgpt") {
    health = await checkCodex();
  } else {
    health = await checkOpenRouter(workspaceId);
  }
  healthCache.set(cacheKey, { at: Date.now(), value: health });
  return health;
}

/**
 * Authoritative pre-execution readiness for one workspace. Unlike
 * `isConfigured` this re-verifies the Codex credential's `auth_mode` and
 * freshness, so a session that expired since the task was queued fails
 * closed instead of being attempted.
 */
export async function providerReadiness(
  workspaceId: string,
  provider: ProviderId,
): Promise<{ ready: boolean; message: string }> {
  if (provider === "codex_chatgpt") {
    const health = await checkCodex();
    return { ready: health.healthy, message: health.message };
  }
  if (await isConfigured(workspaceId, provider)) {
    return { ready: true, message: "" };
  }
  return {
    ready: false,
    message: `${PROVIDER_LABELS[provider]} is not configured for this workspace; add your own credential on the Providers page and retry.`,
  };
}

// ---------------------------------------------------------------------------
// Workspace routing defaults (stored in system_state; no secrets involved)
// ---------------------------------------------------------------------------

const SETTINGS_KEYS = {
  defaultProvider: "provider.default",
  claudeModel: "provider.claude_max.default_model",
  openrouterModel: "provider.openrouter.default_model",
  codexModel: "provider.codex_chatgpt.default_model",
  codexReasoning: "provider.codex_chatgpt.default_reasoning",
  fallbackOrder: "provider.fallback.order",
  paidFallbackConsent: "provider.fallback.paid_consent",
  paidFallbackLimitCents: "provider.fallback.paid_limit_cents",
} as const;

export type ProviderSettings = {
  defaultProvider: ProviderId;
  claudeModel: string | null;
  openrouterModel: string | null;
  codexModel: string | null;
  codexReasoning: CodexReasoningLevel | null;
  /**
   * Providers to try, in order, when the primary one stops. Empty means
   * "do not fall back": the task stops and waits for the owner.
   */
  fallbackOrder: ProviderId[];
  /**
   * Standing authorization to fall back onto a metered (paid) provider
   * without asking per task. Off by default — a subscription-backed
   * workspace must never start spending money silently.
   */
  paidFallbackConsent: boolean;
  /** Ceiling, in cents, on one automatically-approved paid fallback. */
  paidFallbackLimitCents: number | null;
};

function parseFallbackOrder(raw: string | undefined): ProviderId[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ProviderId => isProviderId(entry));
}

export async function getProviderSettings(
  workspaceId: string,
): Promise<ProviderSettings> {
  const rows = await db
    .select()
    .from(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, workspaceId),
        inArray(workspaceSettingsTable.key, Object.values(SETTINGS_KEYS)),
      ),
    );
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const rawDefault = byKey.get(SETTINGS_KEYS.defaultProvider);
  // A stored default pointing at a provider that is currently switched off
  // must not silently reroute work: fall back to Claude Code, which the
  // office has always shipped with.
  const defaultProvider: ProviderId =
    rawDefault && isProviderId(rawDefault) && availableProviderIds().includes(rawDefault)
      ? rawDefault
      : "claude_max";
  const storedReasoning = byKey.get(SETTINGS_KEYS.codexReasoning);
  const storedLimit = Number(byKey.get(SETTINGS_KEYS.paidFallbackLimitCents));
  return {
    defaultProvider,
    claudeModel: byKey.get(SETTINGS_KEYS.claudeModel) ?? null,
    openrouterModel: byKey.get(SETTINGS_KEYS.openrouterModel) ?? null,
    codexModel: byKey.get(SETTINGS_KEYS.codexModel) ?? null,
    codexReasoning:
      storedReasoning && isCodexReasoningLevel(storedReasoning)
        ? storedReasoning
        : null,
    fallbackOrder: parseFallbackOrder(byKey.get(SETTINGS_KEYS.fallbackOrder)),
    paidFallbackConsent: byKey.get(SETTINGS_KEYS.paidFallbackConsent) === "true",
    paidFallbackLimitCents:
      Number.isFinite(storedLimit) && storedLimit > 0 ? storedLimit : null,
  };
}

async function upsertSetting(
  workspaceId: string,
  key: string,
  value: string,
): Promise<void> {
  await db
    .insert(workspaceSettingsTable)
    .values({ workspaceId, key, value })
    .onConflictDoUpdate({
      target: [workspaceSettingsTable.workspaceId, workspaceSettingsTable.key],
      set: { value },
    });
}

async function deleteSetting(workspaceId: string, key: string): Promise<void> {
  await db
    .delete(workspaceSettingsTable)
    .where(
      and(
        eq(workspaceSettingsTable.workspaceId, workspaceId),
        eq(workspaceSettingsTable.key, key),
      ),
    );
}

export class ProviderSettingsError extends Error {}

export async function updateProviderSettings(workspaceId: string, input: {
  defaultProvider?: ProviderId;
  claudeModel?: string | null;
  openrouterModel?: string | null;
  codexModel?: string | null;
  codexReasoning?: string | null;
  fallbackOrder?: ProviderId[];
  paidFallbackConsent?: boolean;
  paidFallbackLimitCents?: number | null;
}): Promise<ProviderSettings> {
  // Server-side validation: the client may not select a provider that is
  // switched off, nor a Codex model or reasoning level outside the
  // server-configured catalog.
  const available = availableProviderIds();
  if (input.defaultProvider !== undefined) {
    if (!available.includes(input.defaultProvider)) {
      throw new ProviderSettingsError(
        `${providerLabel(input.defaultProvider)} is not available in this workspace.`,
      );
    }
    await upsertSetting(
      workspaceId,
      SETTINGS_KEYS.defaultProvider,
      input.defaultProvider,
    );
  }
  if (input.codexModel !== undefined && input.codexModel !== null) {
    const trimmed = input.codexModel.trim();
    if (trimmed !== "" && !isCodexModel(trimmed)) {
      throw new ProviderSettingsError(
        `"${trimmed}" is not a supported Codex model.`,
      );
    }
  }
  if (input.codexReasoning !== undefined && input.codexReasoning !== null) {
    const trimmed = input.codexReasoning.trim();
    if (trimmed !== "" && !isCodexReasoningLevel(trimmed)) {
      throw new ProviderSettingsError(
        `"${trimmed}" is not a supported Codex reasoning level.`,
      );
    }
  }
  if (input.fallbackOrder !== undefined) {
    for (const provider of input.fallbackOrder) {
      if (!available.includes(provider)) {
        throw new ProviderSettingsError(
          `${providerLabel(provider)} cannot be used as a fallback in this workspace.`,
        );
      }
    }
    await upsertSetting(
      workspaceId,
      SETTINGS_KEYS.fallbackOrder,
      input.fallbackOrder.join(","),
    );
  }
  if (input.paidFallbackConsent !== undefined) {
    await upsertSetting(
      workspaceId,
      SETTINGS_KEYS.paidFallbackConsent,
      input.paidFallbackConsent ? "true" : "false",
    );
  }
  if (input.paidFallbackLimitCents !== undefined) {
    if (input.paidFallbackLimitCents === null) {
      await deleteSetting(workspaceId, SETTINGS_KEYS.paidFallbackLimitCents);
    } else {
      await upsertSetting(
        workspaceId,
        SETTINGS_KEYS.paidFallbackLimitCents,
        String(input.paidFallbackLimitCents),
      );
    }
  }
  const modelUpdates: Array<[string, string | null | undefined]> = [
    [SETTINGS_KEYS.claudeModel, input.claudeModel],
    [SETTINGS_KEYS.openrouterModel, input.openrouterModel],
    [SETTINGS_KEYS.codexModel, input.codexModel],
    [SETTINGS_KEYS.codexReasoning, input.codexReasoning],
  ];
  for (const [key, value] of modelUpdates) {
    if (value === undefined) continue;
    if (value === null || value.trim() === "") {
      await deleteSetting(workspaceId, key);
    } else {
      await upsertSetting(workspaceId, key, value.trim());
    }
  }
  return getProviderSettings(workspaceId);
}

// ---------------------------------------------------------------------------
// Routing + token/cost estimation
// ---------------------------------------------------------------------------

export type AgentRouting = {
  /** Null means the agent follows the workspace default provider. */
  provider: string | null;
  model: string | null;
  /** Codex-specific preferences, kept apart from `model`. */
  codexModel?: string | null;
  codexReasoning?: string | null;
};

export type ResolvedRouting = {
  provider: ProviderId;
  model: string;
  /** Only meaningful for Codex; null for every other provider. */
  reasoningEffort: CodexReasoningLevel | null;
};

export class RoutingError extends Error {}

/**
 * Resolve the provider, model, and (for Codex) reasoning level a task
 * would run with.
 *
 * Precedence: task override → agent preference → workspace default →
 * built-in fallback. Every resolved combination is validated server-side,
 * so an override naming an unavailable provider or an unsupported Codex
 * model is rejected rather than quietly corrected.
 */
export async function resolveRouting(
  workspaceId: string,
  agent: AgentRouting,
  providerOverride?: ProviderId,
  modelOverride?: string,
  reasoningOverride?: string,
): Promise<ResolvedRouting> {
  const settings = await getProviderSettings(workspaceId);
  const available = availableProviderIds();
  if (providerOverride && !available.includes(providerOverride)) {
    throw new RoutingError(
      `${providerLabel(providerOverride)} is not available in this workspace.`,
    );
  }
  const agentProvider: ProviderId | null =
    agent.provider && isProviderId(agent.provider) ? agent.provider : null;
  let provider: ProviderId =
    providerOverride ?? agentProvider ?? settings.defaultProvider;
  if (!available.includes(provider)) {
    // The agent pins a provider the workspace has switched off. Say so
    // instead of running the work somewhere it was never assigned.
    throw new RoutingError(
      `${providerLabel(provider)} is switched off in this workspace, so this task cannot be routed. Choose another provider.`,
    );
  }

  if (provider === "codex_chatgpt") {
    const model =
      modelOverride?.trim() ||
      agent.codexModel?.trim() ||
      settings.codexModel ||
      codexDefaultModel();
    if (!isCodexModel(model)) {
      throw new RoutingError(`"${model}" is not a supported Codex model.`);
    }
    const reasoning =
      reasoningOverride?.trim() ||
      agent.codexReasoning?.trim() ||
      settings.codexReasoning ||
      codexDefaultReasoning();
    if (!isCodexReasoningLevel(reasoning)) {
      throw new RoutingError(
        `"${reasoning}" is not a supported Codex reasoning level. Supported: ${codexReasoningLevels().join(", ")}.`,
      );
    }
    return { provider, model, reasoningEffort: reasoning };
  }

  // An agent-level model applies when it was chosen for the resolved provider:
  // either the agent pins that provider, or the agent follows the workspace
  // default (its model was picked against the effective provider). A task
  // override onto a different provider falls back to workspace defaults.
  const agentModel =
    agentProvider === provider || agentProvider === null ? agent.model : null;
  const workspaceModel =
    provider === "claude_max" ? settings.claudeModel : settings.openrouterModel;
  const model =
    modelOverride?.trim() ||
    agentModel?.trim() ||
    workspaceModel ||
    FALLBACK_MODEL[provider];
  return { provider, model, reasoningEffort: null };
}

export type ModelPricing = {
  promptCentsPerMTok: number | null;
  completionCentsPerMTok: number | null;
};

/**
 * Pricing is public catalog data (the built-in Claude table or the
 * unauthenticated OpenRouter listing), so it needs no workspace identity —
 * budget enforcement and usage costing work even for a workspace whose
 * credential just failed.
 */
export async function getModelPricing(
  provider: ProviderId,
  model: string,
): Promise<ModelPricing> {
  const models =
    provider === "claude_max"
      ? CLAUDE_CATALOG
      : provider === "openrouter"
        ? (await fetchOpenRouterCatalog()).models
        : [];
  const row = models.find((m) => m.id === model);
  return {
    promptCentsPerMTok: row?.promptCentsPerMTok ?? null,
    completionCentsPerMTok: row?.completionCentsPerMTok ?? null,
  };
}

const CHARS_PER_TOKEN = 4;
/** Fixed prompt overhead for system framing, tool schemas, etc. */
const PROMPT_OVERHEAD_TOKENS = 600;
const DEFAULT_OUTPUT_TOKENS = 800;

/** Conservative prompt-token estimate shared by estimates and the budget gate. */
export function estimatePromptTokens(promptChars: number): number {
  return Math.ceil(promptChars / CHARS_PER_TOKEN) + PROMPT_OVERHEAD_TOKENS;
}

export type TaskEstimate = {
  provider: ProviderId;
  model: string;
  /** Subscription providers draw on a plan allowance instead of billing. */
  billing: ProviderBilling;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTokens: number;
  estimatedCostCents: number;
  costKnown: boolean;
  note: string | null;
};

export async function estimateTask(
  agentContext: string,
  objective: string,
  routing: { provider: ProviderId; model: string },
): Promise<TaskEstimate> {
  const promptChars = agentContext.length + objective.length;
  const estimatedInputTokens = estimatePromptTokens(promptChars);
  const estimatedOutputTokens = DEFAULT_OUTPUT_TOKENS;
  const estimatedTokens = estimatedInputTokens + estimatedOutputTokens;
  const billing = PROVIDER_BILLING[routing.provider];

  if (routing.provider === "claude_max") {
    return {
      ...routing,
      billing,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTokens,
      estimatedCostCents: 0,
      costKnown: true,
      note: "Covered by the Claude Max subscription — no per-token charge.",
    };
  }

  if (routing.provider === "codex_chatgpt") {
    // Deliberately NOT reported as a known $0.00: the run consumes the
    // ChatGPT Codex allowance, and neither the SDK nor the API exposes how
    // much of it is left. Claiming a price — even zero — would be false.
    return {
      ...routing,
      billing,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTokens,
      estimatedCostCents: 0,
      costKnown: false,
      note: "Uses ChatGPT Codex allowance — no per-token charge, and the remaining allowance is not published by OpenAI.",
    };
  }

  const pricing = await getModelPricing(routing.provider, routing.model);
  if (
    pricing.promptCentsPerMTok === null ||
    pricing.completionCentsPerMTok === null
  ) {
    return {
      ...routing,
      billing,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTokens,
      estimatedCostCents: 0,
      costKnown: false,
      note: "Pricing for this model is unavailable, so cost cannot be estimated.",
    };
  }
  const estimatedCostCents =
    (estimatedInputTokens * pricing.promptCentsPerMTok +
      estimatedOutputTokens * pricing.completionCentsPerMTok) /
    1_000_000;
  return {
    ...routing,
    billing,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTokens,
    estimatedCostCents,
    costKnown: true,
    note: null,
  };
}

/**
 * Metered cost of recorded usage. `claude_max` is subscription-covered and
 * has always recorded 0. Codex returns null — "not applicable / unknown" —
 * rather than a fabricated 0.00¢ charge against a plan allowance whose
 * consumption OpenAI does not publish.
 */
export async function computeUsageCostCents(
  provider: ProviderId,
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): Promise<number | null> {
  if (provider === "claude_max") return 0;
  if (provider === "codex_chatgpt") return null;
  if (!model) return null;
  const pricing = await getModelPricing(provider, model);
  if (
    pricing.promptCentsPerMTok === null ||
    pricing.completionCentsPerMTok === null
  ) {
    return null;
  }
  return (
    (inputTokens * pricing.promptCentsPerMTok +
      outputTokens * pricing.completionCentsPerMTok) /
    1_000_000
  );
}
