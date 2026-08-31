/**
 * Classification of GitHub API refusals into distinct, owner-actionable
 * failure classes. GitHub collapses very different problems into 401/403,
 * so a generic "expired — reconnect" message routinely sends the owner to
 * fix the wrong thing (or to recreate the OAuth app for no reason). This
 * module is pure and secret-free: it looks only at the HTTP status and a
 * few well-known response headers, never at tokens or response bodies.
 *
 * The classes and what the owner should actually do:
 * - "invalid_token"  → the token was revoked or reset at GitHub (401).
 *                      Reconnecting once fixes it; the OAuth app is fine.
 * - "missing_scope"  → the grant lacks a required OAuth scope. Reconnect
 *                      and approve all requested access.
 * - "rate_limited"   → GitHub accepted the credential but throttled the
 *                      call. Nothing to repair — retry later.
 * - "forbidden"      → the account itself lacks repository/organization
 *                      authorization. Reconnecting will NOT help; access
 *                      must be restored on GitHub.
 * - "server_error"   → a temporary GitHub outage. Retry later.
 * - "not_found"      → missing resource OR hidden-by-permissions (GitHub
 *                      404s private resources the account cannot see).
 * - "other"          → anything else; callers fall back to their generic
 *                      failure mapping.
 */

/**
 * The single OAuth scope the catalog needs: "repo" covers reading private
 * repositories and files plus creating issues and comments. GitHub OAuth
 * apps offer no finer-grained repo scope.
 */
export const GITHUB_SCOPES = ["repo"] as const;

/** GitHub reports granted scopes comma-separated ("repo,read:user"). */
export function missingGithubScopes(granted: string): string[] {
  const have = new Set(
    granted
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return GITHUB_SCOPES.filter((scope) => !have.has(scope));
}

export type GithubFailureClass =
  | "invalid_token"
  | "missing_scope"
  | "rate_limited"
  | "forbidden"
  | "server_error"
  | "not_found"
  | "other";

export type GithubRefusal = {
  failureClass: GithubFailureClass;
  /**
   * GitHub's own request identifier (X-GitHub-Request-Id), sanitized to a
   * short safe charset. It is a support/correlation handle only — never a
   * credential — and lets a log line be matched to GitHub's side.
   */
  requestId: string | null;
  /** Required scopes absent from the live X-OAuth-Scopes header, if sent. */
  missingScopes: string[];
};

function headerValue(
  headers: Headers | null | undefined,
  name: string,
): string | null {
  try {
    return headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

/** Sanitize the GitHub request id so a log line can never carry surprises. */
function sanitizeRequestId(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9:._-]{1,64}$/.test(trimmed) ? trimmed : null;
}

export function classifyGithubRefusal(
  status: number,
  headers?: Headers | null,
): GithubRefusal {
  const requestId = sanitizeRequestId(
    headerValue(headers, "x-github-request-id"),
  );
  const grantedScopes = headerValue(headers, "x-oauth-scopes");
  const missingScopes =
    grantedScopes !== null ? missingGithubScopes(grantedScopes) : [];

  let failureClass: GithubFailureClass = "other";
  if (status === 401) {
    // GitHub answers 401 for a revoked/reset token before anything else —
    // this is never a scope or repository-permission problem.
    failureClass = "invalid_token";
  } else if (status === 403 || status === 429) {
    const remaining = headerValue(headers, "x-ratelimit-remaining");
    const retryAfter = headerValue(headers, "retry-after");
    if (status === 429 || remaining === "0" || retryAfter !== null) {
      // A per-credential rate limit implies the credential AUTHENTICATED —
      // a revoked token would have been a 401. The connection is healthy.
      failureClass = "rate_limited";
    } else if (missingScopes.length > 0) {
      failureClass = "missing_scope";
    } else {
      failureClass = "forbidden";
    }
  } else if (status === 404) {
    failureClass = "not_found";
  } else if (status >= 500) {
    failureClass = "server_error";
  }
  return { failureClass, requestId, missingScopes };
}

/**
 * Owner/agent-facing text for a classified refusal. Returns null for
 * "other" so callers keep their generic mapping. Messages carry the safe
 * GitHub request id for correlation and NEVER a token, header dump, or
 * response body. `method` picks recovery guidance that matches how the
 * workspace authenticates: an installation-token 401 after an automatic
 * refresh is a server/app problem, never something "reconnecting" fixes,
 * and an installation 403/404 usually means the repository is outside the
 * installation's selected repositories or granted permissions.
 */
export function describeGithubRefusal(
  refusal: GithubRefusal,
  status: number,
  method: "oauth" | "installation" = "oauth",
): { kind: "auth" | "failed"; message: string } | null {
  const ref = refusal.requestId
    ? ` (GitHub request ${refusal.requestId})`
    : "";
  const viaApp = method === "installation";
  switch (refusal.failureClass) {
    case "invalid_token":
      return {
        kind: "auth",
        message: viaApp
          ? `GitHub rejected the app installation's access token (HTTP 401) even after it was refreshed automatically. This usually means the installation was just removed or suspended on GitHub, or the server's GitHub App credentials are wrong. Check the GitHub connection on the Connected Apps page.${ref}`
          : `GitHub rejected the stored sign-in (HTTP 401): the token was revoked or reset at GitHub. Reconnect GitHub on the Connected Apps page to restore access — the OAuth app itself does not need to be recreated.${ref}`,
      };
    case "missing_scope":
      return {
        kind: "auth",
        message: `The connected GitHub account is missing required permission${refusal.missingScopes.length === 1 ? "" : "s"} (${refusal.missingScopes.join(", ")}) — HTTP ${status}. Reconnect GitHub and approve all requested access.${ref}`,
      };
    case "rate_limited":
      return {
        kind: "failed",
        message: `GitHub is rate-limiting requests for this account right now (HTTP ${status}). The connection itself is still valid — nothing needs to be reconnected. Retry after the limit resets.${ref}`,
      };
    case "forbidden":
      return {
        kind: "failed",
        message: viaApp
          ? `GitHub refused access to this resource (HTTP 403). The repository is likely not covered by the GitHub App installation — either it is outside the repositories selected for the app, or the app lacks the needed permission there. Update the installation's repository access in the account's GitHub App settings, then retry. Reinstalling alone will not add repositories that were not selected.${ref}`
          : `GitHub refused access to this resource (HTTP 403). The connected account may lack permission on the repository, or its organization restricts OAuth apps. Reconnecting alone will not fix this — restore the account's repository or organization authorization on GitHub, then retry.${ref}`,
      };
    case "server_error":
      return {
        kind: "failed",
        message: `GitHub reported a server error (HTTP ${status}). This is usually a temporary GitHub outage — nothing is wrong with the stored connection. Retry shortly.${ref}`,
      };
    case "not_found":
      return {
        kind: "failed",
        message: viaApp
          ? `GitHub returned 404 Not Found. The resource may not exist — or it may be outside the repositories granted to the GitHub App installation (GitHub hides inaccessible resources). Check the installation's repository selection in the account's GitHub App settings.${ref}`
          : `GitHub returned 404 Not Found. The resource may not exist — or the connected account may not have access to it (GitHub hides private resources from accounts without permission).${ref}`,
      };
    default:
      return null;
  }
}
