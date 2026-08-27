/**
 * Error messages from providers, proxies, and SDKs can echo request
 * material — including Authorization headers and API keys. Anything that
 * flows into durable storage (tasks.errorMessage, task logs, notifications)
 * or HTTP responses must pass through here first.
 */

const MAX_MESSAGE_LENGTH = 500;

/** Env vars whose values must never appear in a persisted message. */
const SECRET_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "WEB_SEARCH_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "CLERK_SECRET_KEY",
  "SESSION_SECRET",
  "DATABASE_URL",
  // Codex: the bootstrap blob is a whole auth.json (refresh token, id
  // token, account id), and the API keys must never be echoed either —
  // even though Codex is only ever run in ChatGPT-auth mode here.
  "CODEX_AUTH_JSON",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
] as const;

/** Whole-match redaction: no capture groups allowed here. */
const PLAIN_PATTERNS: RegExp[] = [
  // Authorization header material.
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi,
  // Common API-key shapes: sk-..., sk-or-..., pk_..., rk_..., xoxb-...
  /\b(?:sk|pk|rk|xox[a-z])[-_][a-z0-9._-]{10,}/gi,
  // Postgres/redis/amqp URLs with embedded credentials.
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi,
  // Telegram bot tokens: numeric bot id, colon, then the secret segment.
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,
];

// key=value / "key": "value" assignments for credential-ish names; the key
// name and separator are kept so the message stays diagnosable. Quoted
// values may contain spaces (e.g. "Authorization": "Bearer abc…"), so they
// are consumed whole; unquoted values stop at delimiters.
const NAMED_PATTERN =
  /\b(api[_-]?key|apikey|token|secret|password|authorization|credential)\b(["']?\s*[:=]\s*)(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|(?:bearer|basic)\s+[^\s"'&,;]{4,}|[^\s"'&,;]{6,})/gi;

/**
 * Redact credential-shaped substrings and any literal secret value from a
 * message, then clip it to a bounded length. Never throws.
 */
export function sanitizeErrorMessage(message: string): string {
  let out = message;
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 6) {
      out = out.split(value).join("[redacted]");
    }
  }
  // Named assignments first: they consume entire quoted values (which may
  // contain spaces), so partial redaction by a narrower pattern can't leave
  // the tail of a credential behind.
  out = out.replace(
    NAMED_PATTERN,
    (_match, name: string, sep: string) => `${name}${sep}[redacted]`,
  );
  for (const pattern of PLAIN_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  if (out.length > MAX_MESSAGE_LENGTH) {
    out = `${out.slice(0, MAX_MESSAGE_LENGTH)}…`;
  }
  return out;
}
