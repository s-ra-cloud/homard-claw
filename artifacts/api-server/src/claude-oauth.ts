/**
 * The Anthropic authentication contract for Claude Code setup tokens.
 *
 * Long-lived subscription tokens minted by `claude setup-token` are only
 * accepted by Anthropic when the request looks like the Claude Code CLI:
 *
 *  - `authorization: Bearer <token>` (never `x-api-key`);
 *  - both OAuth beta capabilities in `anthropic-beta` — dropping either
 *    turns an otherwise valid token into HTTP 401;
 *  - the Claude Code client identity headers (`user-agent`, `x-app`);
 *  - a `system` array whose ENTIRE first block is exactly the Claude Code
 *    identity sentence. For every non-Haiku model, Anthropic validates
 *    this server-side and rejects the request when it is missing or when
 *    the sentence is merely concatenated into a longer block.
 *
 * Only the messages family accepts these tokens, and for OAuth requests
 * the CLI uses the BETA messages surface — `/v1/messages?beta=true`. The
 * plain path can reject a token that is scoped to Claude Code, and
 * `/v1/models` never accepts OAuth tokens at all, which is why health
 * checks probe with a real (tiny) message request rather than a listing
 * call.
 *
 * Contract last verified 2026-08-28 against Claude Code 2.1.232 (wire
 * captures and the working third-party client implementations that track
 * the CLI). When Anthropic drifts again, update THIS module and the exact
 * literal assertions in office.claude-auth.test.ts together.
 *
 * Health checking and task execution both build their requests from this
 * one module so a token accepted during configuration is sent with an
 * identical contract during execution.
 */

/**
 * Claude Code subscription OAuth tokens require both beta capabilities.
 * Sending only oauth-2025-04-20 makes Anthropic reject an otherwise valid
 * setup-token credential with HTTP 401. Order matches the CLI's own
 * header (claude-code first).
 */
export const CLAUDE_CODE_OAUTH_BETAS =
  "claude-code-20250219,oauth-2025-04-20";

/**
 * Client identity Anthropic expects alongside an OAuth token. The version
 * tracks a current CLI release verified to authenticate (2.1.232, the
 * build current as of 2026-08); the "(external, cli)" suffix and
 * `x-app: cli` are part of the recognized shape.
 */
export const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.232 (external, cli)";

/**
 * The exact sentence Anthropic requires as the entire first system block
 * on OAuth-authenticated requests. Do not edit — even appending to it in
 * the same block makes Anthropic reject the request.
 */
export const CLAUDE_CODE_SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * The OAuth-authenticated messages endpoint. `beta=true` selects the beta
 * messages surface the Claude Code CLI itself uses; the plain
 * `/v1/messages` path can refuse a credential that is only authorized for
 * Claude Code. Split out so tests can assert the exact endpoint.
 */
export const ANTHROPIC_MESSAGES_URL =
  "https://api.anthropic.com/v1/messages?beta=true";

/**
 * The one authentication-header builder shared by provider health checks
 * and task execution. `content-type` is included because every request
 * OAuth tokens are valid for is a JSON POST.
 */
export function claudeOAuthHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": CLAUDE_CODE_OAUTH_BETAS,
    "user-agent": CLAUDE_CODE_USER_AGENT,
    "x-app": "cli",
    "content-type": "application/json",
  };
}

/**
 * Build the `system` array for an OAuth-authenticated messages request:
 * the mandatory identity sentence as its own first block, followed by the
 * caller's actual system prompt (when any) as a separate block.
 */
export function claudeSystemBlocks(
  system: string,
): Array<{ type: "text"; text: string }> {
  const blocks: Array<{ type: "text"; text: string }> = [
    { type: "text", text: CLAUDE_CODE_SYSTEM_IDENTITY },
  ];
  if (system.trim() !== "" && system.trim() !== CLAUDE_CODE_SYSTEM_IDENTITY) {
    blocks.push({ type: "text", text: system });
  }
  return blocks;
}

/**
 * Validate the shape of a candidate Claude Code credential BEFORE it is
 * stored, so the wrong kind of secret gets precise remediation instead of
 * a confusing 401 later. Returns a user-facing problem description, or
 * null when the candidate looks like a setup token.
 *
 * The returned text never includes any part of the candidate itself.
 */
export function claudeSetupTokenProblem(candidate: string): string | null {
  const token = candidate.trim();
  if (/^sk-ant-oat\d/.test(token)) return null;
  if (/^sk-ant-ort\d/.test(token)) {
    return "That looks like an OAuth refresh token, which cannot authenticate requests on its own. Run `claude setup-token` in Claude Code and paste the long-lived access token it prints.";
  }
  if (/^sk-ant-api/.test(token)) {
    return "That looks like an Anthropic Console API key, which bills the API directly and is not accepted here. Run `claude setup-token` in Claude Code (it requires a Claude subscription) and paste the long-lived OAuth token it prints.";
  }
  return "That does not look like a Claude Code setup token. Run `claude setup-token` in Claude Code on a machine where you are signed in, and paste the full token it prints — it is long and may wrap across terminal lines, so make sure the whole value was copied.";
}

/**
 * What an Anthropic authentication failure actually means for the owner.
 * Distinguishing these is the difference between "rotate your token" and
 * "the app is broken, rotating will not help".
 */
export type ClaudeAuthFailureKind =
  /** Anthropic examined the token value itself and refused it. */
  | "token_invalid"
  /** Anthropic explicitly reported the token as expired or revoked. */
  | "token_expired"
  /**
   * Anthropic refused the CLIENT — the way this app presents itself as
   * Claude Code — rather than the token. Seen as "OAuth authentication is
   * currently not supported", "only authorized for Claude Code", or header
   * validation errors. A fresh token that works in Claude Code itself will
   * keep failing here until the app's request contract is updated.
   */
  | "protocol_incompatible"
  /** HTTP 403: the credential authenticates but is not authorized. */
  | "not_authorized"
  /** A 401 whose cause Anthropic did not identify in a recognized way. */
  | "unknown_auth";

export type ClaudeAuthFailure = {
  kind: ClaudeAuthFailureKind;
  /** Fixed, server-composed text. Never derived from response bodies. */
  message: string;
};

/**
 * The only fields of an Anthropic error body the classifier may consult.
 * Extracted defensively; the strings themselves are matched against known
 * signatures and then DISCARDED — they must never reach messages, logs,
 * task records, or status payloads, because proxied error bodies can echo
 * request material (including the Authorization header).
 */
export type ClaudeErrorInfo = {
  errorType: string | null;
  errorMessage: string | null;
};

/**
 * Read the error `type` and `message` out of an Anthropic error response
 * for classification only. Returns nulls when the body is missing or
 * malformed — classification then falls back to status-code-only text.
 */
export async function readClaudeErrorInfo(
  res: globalThis.Response,
): Promise<ClaudeErrorInfo> {
  try {
    const body = (await res.json()) as {
      type?: unknown;
      error?: { type?: unknown; message?: unknown };
    };
    return {
      errorType:
        typeof body?.error?.type === "string" ? body.error.type : null,
      errorMessage:
        typeof body?.error?.message === "string" ? body.error.message : null,
    };
  } catch {
    return { errorType: null, errorMessage: null };
  }
}

/**
 * Classify an Anthropic 401/403 into a fixed, owner-facing explanation.
 *
 * Signatures verified live on 2026-08-28 with fixture tokens, plus the
 * failure modes documented for current Claude Code releases:
 *  - "OAuth access token is invalid."  → the token VALUE is wrong: most
 *    often an incomplete paste (`claude setup-token` output wraps across
 *    terminal lines), otherwise revoked or never valid.
 *  - "…expired…"                       → genuinely stale; rotate.
 *  - "OAuth authentication is currently not supported" /
 *    "only authorized for Claude Code" / header-validation complaints
 *                                       → Anthropic refused the app's
 *    Claude Code emulation, NOT the token; rotating cannot fix it.
 *
 * The matched body text is never echoed — output is fixed text only.
 */
export function classifyClaudeAuthFailure(
  status: 401 | 403,
  info: ClaudeErrorInfo,
): ClaudeAuthFailure {
  const detail = (info.errorMessage ?? "").toLowerCase();
  if (status === 403) {
    return {
      kind: "not_authorized",
      message:
        "Anthropic refused this credential (HTTP 403): it authenticates but is not authorized for Claude Code. Make sure you saved the OAuth token printed by `claude setup-token` — not a Console API key — and that the Claude subscription is still active.",
    };
  }
  if (/expired|revoked/.test(detail)) {
    return {
      kind: "token_expired",
      message:
        "Anthropic reports the stored setup token has expired or been revoked (HTTP 401). Run `claude setup-token` again and save the fresh token on the Providers page.",
    };
  }
  if (
    /oauth (access )?token is invalid|invalid bearer token/.test(detail)
  ) {
    return {
      kind: "token_invalid",
      message:
        "Anthropic reports the token value itself is invalid (HTTP 401). This is usually an incomplete paste — `claude setup-token` prints a token over a hundred characters long that can wrap across terminal lines — so re-copy the ENTIRE token as one line and save it again. If the full value still fails, mint a new one with `claude setup-token`.",
    };
  }
  if (
    /oauth authentication is currently not supported|only authorized for claude code|not supported for this request|header .*invalid/.test(
      detail,
    )
  ) {
    return {
      kind: "protocol_incompatible",
      message:
        "Anthropic refused the way this app presents itself as Claude Code, not your token (HTTP 401). If this token works in Claude Code itself, the app's Claude Code request format is out of date and needs an app update — generating another token will not help.",
    };
  }
  return {
    kind: "unknown_auth",
    message:
      "Anthropic rejected the request as unauthenticated (HTTP 401) without identifying the cause. First check that the token works in Claude Code itself: if it does, the app's Claude Code request format is likely out of date and rotating the token will not help; if it does not, run `claude setup-token` again and save the fresh token in full.",
  };
}
