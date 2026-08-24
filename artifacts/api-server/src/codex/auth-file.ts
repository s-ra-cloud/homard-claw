/**
 * Reading a Codex `auth.json` without ever trusting it.
 *
 * The file belongs to the Codex CLI: it writes it at login and rewrites it
 * on every token refresh. HomardClaw only needs two facts out of it — which
 * account type is paying for runs, and when the session last refreshed —
 * and must never log, copy, or transmit anything else it contains.
 */

export type CodexAuthMode = "chatgpt" | "api_key" | "unknown";

export type RawAuth = {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  openai_api_key?: unknown;
  tokens?: {
    account_id?: unknown;
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
  } | null;
  last_refresh?: unknown;
};

export type CodexAuthFacts = {
  mode: CodexAuthMode;
  lastRefreshAt: string | null;
};

/**
 * A ChatGPT sign-in is only a sign-in if it still carries token material.
 * Codex rewrites this file in place on every refresh, so a truncated or
 * half-written copy can be valid JSON that declares `auth_mode: chatgpt`
 * and yet authenticates nobody — accepting it would let a partial write
 * replace a working session.
 */
function hasTokenMaterial(tokens: RawAuth["tokens"]): boolean {
  if (!tokens || typeof tokens !== "object") return false;
  return [tokens.access_token, tokens.refresh_token, tokens.id_token].some(
    (value) => typeof value === "string" && value.trim() !== "",
  );
}

/**
 * Classify the stored credential. The explicit `auth_mode` written by
 * recent Codex builds wins, but only when the file backs it up: an API key
 * present means API billing, and a ChatGPT claim needs tokens to go with
 * it. Anything else is "unknown" and is never reported as ChatGPT-backed
 * or written back over a stored session.
 */
export function classifyAuthJson(raw: RawAuth): CodexAuthFacts {
  const lastRefreshAt =
    typeof raw.last_refresh === "string" ? raw.last_refresh : null;
  const declared =
    typeof raw.auth_mode === "string" ? raw.auth_mode.toLowerCase() : null;
  const apiKey = raw.OPENAI_API_KEY ?? raw.openai_api_key;
  const hasApiKey = typeof apiKey === "string" && apiKey.trim() !== "";
  if (declared === "apikey" || declared === "api_key") {
    return { mode: hasApiKey ? "api_key" : "unknown", lastRefreshAt };
  }
  if (hasTokenMaterial(raw.tokens)) {
    return { mode: "chatgpt", lastRefreshAt };
  }
  if (hasApiKey) return { mode: "api_key", lastRefreshAt };
  return { mode: "unknown", lastRefreshAt };
}

/** Parse and classify in one step. Returns null when it is not JSON. */
export function readAuthFacts(contents: string): CodexAuthFacts | null {
  try {
    return classifyAuthJson(JSON.parse(contents) as RawAuth);
  } catch {
    return null;
  }
}
