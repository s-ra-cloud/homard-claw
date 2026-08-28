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
 * Only the `/v1/messages` family accepts these tokens; `/v1/models` does
 * not, which is why health checks must probe with a real (tiny) message
 * request rather than a listing call.
 *
 * Health checking and task execution both build their requests from this
 * one module so a token accepted during configuration is sent with an
 * identical contract during execution.
 */

/**
 * Claude Code subscription OAuth tokens require both beta capabilities.
 * Sending only oauth-2025-04-20 makes Anthropic reject an otherwise valid
 * setup-token credential with HTTP 401.
 */
export const CLAUDE_CODE_OAUTH_BETAS =
  "oauth-2025-04-20,claude-code-20250219";

/**
 * Client identity Anthropic expects alongside an OAuth token. The version
 * only needs to be a plausible current CLI release; the "(external, cli)"
 * suffix and `x-app: cli` are part of the recognized shape.
 */
export const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.95 (external, cli)";

/**
 * The exact sentence Anthropic requires as the entire first system block
 * on OAuth-authenticated requests. Do not edit — even appending to it in
 * the same block makes Anthropic reject the request.
 */
export const CLAUDE_CODE_SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** Base URL split out so tests can assert against the endpoints. */
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

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
  return "That does not look like a Claude Code setup token. Run `claude setup-token` in Claude Code on a machine where you are signed in, and paste the full token it prints.";
}

/**
 * Owner-facing explanation for an authentication failure from Anthropic,
 * composed entirely server-side. Response bodies are deliberately not
 * consulted: they can echo request material (including the Authorization
 * header through proxies), so classification uses the status code only.
 */
export function describeClaudeAuthRejection(status: 401 | 403): string {
  if (status === 401) {
    return "Anthropic rejected the stored setup token (HTTP 401): it has expired or been revoked. Run `claude setup-token` again and save the fresh token on the Providers page.";
  }
  return "Anthropic refused this credential (HTTP 403): it is not authorized for Claude Code. Make sure you saved the OAuth token printed by `claude setup-token` — not a Console API key — and that the subscription is still active.";
}
