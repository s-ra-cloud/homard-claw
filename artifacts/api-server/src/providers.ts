import { db, systemStateTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

/**
 * Server-side provider registry: credentials, health, model discovery,
 * routing defaults, and token/cost estimation.
 *
 * Credentials live exclusively in environment secrets and never leave this
 * module — status payloads carry booleans and human-readable messages only.
 */

export type ProviderId = "claude_max" | "openrouter";

export const PROVIDER_IDS: ProviderId[] = ["claude_max", "openrouter"];

const CREDENTIAL_ENV: Record<ProviderId, string> = {
  claude_max: "CLAUDE_CODE_OAUTH_TOKEN",
  openrouter: "OPENROUTER_API_KEY",
};

/** Built-in routing fallback when no workspace default model is set. */
export const FALLBACK_MODEL: Record<ProviderId, string> = {
  claude_max: "claude-sonnet-4-5",
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
  configured: boolean;
  healthy: boolean;
  message: string;
};

function credential(provider: ProviderId): string | undefined {
  const value = process.env[CREDENTIAL_ENV[provider]];
  return value && value.trim() !== "" ? value : undefined;
}

export function isConfigured(provider: ProviderId): boolean {
  return Boolean(credential(provider));
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
const healthCache = new Map<ProviderId, Cached<ProviderHealth>>();
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

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Request timed out";
  }
  return error instanceof Error ? error.message : "Unknown network error";
}

async function checkClaude(): Promise<ProviderHealth> {
  const token = credential("claude_max");
  if (!token) {
    return {
      provider: "claude_max",
      configured: false,
      healthy: false,
      message: "Add CLAUDE_CODE_OAUTH_TOKEN to enable Claude Code execution.",
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
        provider: "claude_max",
        configured: true,
        healthy: true,
        message: "Claude endpoint reachable and credential accepted.",
      };
    }
    return {
      provider: "claude_max",
      configured: true,
      healthy: false,
      message:
        res.status === 401 || res.status === 403
          ? `Claude rejected the credential (HTTP ${res.status}). Re-issue CLAUDE_CODE_OAUTH_TOKEN.`
          : `Claude endpoint returned HTTP ${res.status}.`,
    };
  } catch (error) {
    return {
      provider: "claude_max",
      configured: true,
      healthy: false,
      message: `Claude endpoint unreachable: ${describeFailure(error)}.`,
    };
  }
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

async function fetchOpenRouterCatalog(): Promise<ModelCatalog> {
  const key = credential("openrouter");
  if (!key) {
    return {
      provider: "openrouter",
      available: false,
      message: "Add OPENROUTER_API_KEY to load the OpenRouter model catalog.",
      models: [],
    };
  }
  if (openrouterModelsCache && Date.now() - openrouterModelsCache.at < MODELS_TTL_MS) {
    return openrouterModelsCache.value;
  }
  let catalog: ModelCatalog;
  try {
    const res = await timedFetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      catalog = {
        provider: "openrouter",
        available: false,
        message:
          res.status === 401 || res.status === 403
            ? `OpenRouter rejected the credential (HTTP ${res.status}). Check OPENROUTER_API_KEY.`
            : `OpenRouter model listing failed with HTTP ${res.status}.`,
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

export async function getModelCatalog(provider: ProviderId): Promise<ModelCatalog> {
  if (provider === "claude_max") {
    const health = await getProviderHealth("claude_max");
    return {
      provider: "claude_max",
      available: health.configured,
      message: health.healthy ? null : health.message,
      models: CLAUDE_CATALOG,
    };
  }
  return fetchOpenRouterCatalog();
}

export async function getProviderHealth(provider: ProviderId): Promise<ProviderHealth> {
  const cached = healthCache.get(provider);
  if (cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.value;
  let health: ProviderHealth;
  if (provider === "claude_max") {
    health = await checkClaude();
  } else {
    const catalog = await fetchOpenRouterCatalog();
    health = {
      provider: "openrouter",
      configured: isConfigured("openrouter"),
      healthy: catalog.available,
      message: catalog.available
        ? `OpenRouter reachable; ${catalog.models.length} models available.`
        : (catalog.message ?? "OpenRouter unavailable."),
    };
  }
  healthCache.set(provider, { at: Date.now(), value: health });
  return health;
}

// ---------------------------------------------------------------------------
// Workspace routing defaults (stored in system_state; no secrets involved)
// ---------------------------------------------------------------------------

const SETTINGS_KEYS = {
  defaultProvider: "provider.default",
  claudeModel: "provider.claude_max.default_model",
  openrouterModel: "provider.openrouter.default_model",
} as const;

export type ProviderSettings = {
  defaultProvider: ProviderId;
  claudeModel: string | null;
  openrouterModel: string | null;
};

export async function getProviderSettings(): Promise<ProviderSettings> {
  const rows = await db
    .select()
    .from(systemStateTable)
    .where(inArray(systemStateTable.key, Object.values(SETTINGS_KEYS)));
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const rawDefault = byKey.get(SETTINGS_KEYS.defaultProvider);
  return {
    defaultProvider: rawDefault === "openrouter" ? "openrouter" : "claude_max",
    claudeModel: byKey.get(SETTINGS_KEYS.claudeModel) ?? null,
    openrouterModel: byKey.get(SETTINGS_KEYS.openrouterModel) ?? null,
  };
}

async function upsertSetting(key: string, value: string): Promise<void> {
  await db
    .insert(systemStateTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: systemStateTable.key, set: { value } });
}

export async function updateProviderSettings(input: {
  defaultProvider?: ProviderId;
  claudeModel?: string | null;
  openrouterModel?: string | null;
}): Promise<ProviderSettings> {
  if (input.defaultProvider !== undefined) {
    await upsertSetting(SETTINGS_KEYS.defaultProvider, input.defaultProvider);
  }
  const modelUpdates: Array<[string, string | null | undefined]> = [
    [SETTINGS_KEYS.claudeModel, input.claudeModel],
    [SETTINGS_KEYS.openrouterModel, input.openrouterModel],
  ];
  for (const [key, value] of modelUpdates) {
    if (value === undefined) continue;
    if (value === null || value.trim() === "") {
      await db.delete(systemStateTable).where(eq(systemStateTable.key, key));
    } else {
      await upsertSetting(key, value.trim());
    }
  }
  return getProviderSettings();
}

// ---------------------------------------------------------------------------
// Routing + token/cost estimation
// ---------------------------------------------------------------------------

export type AgentRouting = {
  /** Null means the agent follows the workspace default provider. */
  provider: string | null;
  model: string | null;
};

/**
 * Resolve the provider and model a task would run with.
 * Precedence: task override → agent preference → workspace default.
 */
export async function resolveRouting(
  agent: AgentRouting,
  providerOverride?: ProviderId,
  modelOverride?: string,
): Promise<{ provider: ProviderId; model: string }> {
  const settings = await getProviderSettings();
  const agentProvider: ProviderId | null =
    agent.provider === "openrouter" || agent.provider === "claude_max"
      ? agent.provider
      : null;
  const provider: ProviderId =
    providerOverride ?? agentProvider ?? settings.defaultProvider;
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
  return { provider, model };
}

export type ModelPricing = {
  promptCentsPerMTok: number | null;
  completionCentsPerMTok: number | null;
};

export async function getModelPricing(
  provider: ProviderId,
  model: string,
): Promise<ModelPricing> {
  const catalog = await getModelCatalog(provider);
  const row = catalog.models.find((m) => m.id === model);
  return {
    promptCentsPerMTok: row?.promptCentsPerMTok ?? null,
    completionCentsPerMTok: row?.completionCentsPerMTok ?? null,
  };
}

const CHARS_PER_TOKEN = 4;
/** Fixed prompt overhead for system framing, tool schemas, etc. */
const PROMPT_OVERHEAD_TOKENS = 600;
const DEFAULT_OUTPUT_TOKENS = 800;

export type TaskEstimate = {
  provider: ProviderId;
  model: string;
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
  const estimatedInputTokens =
    Math.ceil(promptChars / CHARS_PER_TOKEN) + PROMPT_OVERHEAD_TOKENS;
  const estimatedOutputTokens = DEFAULT_OUTPUT_TOKENS;
  const estimatedTokens = estimatedInputTokens + estimatedOutputTokens;

  if (routing.provider === "claude_max") {
    return {
      ...routing,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTokens,
      estimatedCostCents: 0,
      costKnown: true,
      note: "Covered by the Claude Max subscription — no per-token charge.",
    };
  }

  const pricing = await getModelPricing(routing.provider, routing.model);
  if (
    pricing.promptCentsPerMTok === null ||
    pricing.completionCentsPerMTok === null
  ) {
    return {
      ...routing,
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
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTokens,
    estimatedCostCents,
    costKnown: true,
    note: null,
  };
}

/** Compute the metered cost of recorded usage; claude_max is subscription-covered. */
export async function computeUsageCostCents(
  provider: ProviderId,
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): Promise<number | null> {
  if (provider === "claude_max") return 0;
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
