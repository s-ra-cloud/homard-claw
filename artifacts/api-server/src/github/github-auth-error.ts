/**
 * Shared error type for every GitHub credential path (legacy OAuth token
 * and GitHub App installation). Lives in its own module so the OAuth
 * credential store and the app-installation store can both throw it
 * without importing each other.
 */
export class GithubAuthError extends Error {
  constructor(
    /**
     * "not_connected" — no GitHub credential of any kind exists for the
     * workspace.
     * "reconnect_required" — a credential exists but can no longer be used
     * (revoked token, undecryptable row, missing scope, or an uninstalled
     * GitHub App); the owner must reconnect or reinstall.
     * "unavailable" — a transient or server-configuration failure (network,
     * missing config, bad app key); nothing is wrong with what the owner
     * set up.
     */
    readonly kind: "not_connected" | "reconnect_required" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "GithubAuthError";
  }
}
