/**
 * In-app GitHub OAuth (authorization code) for per-user GitHub access.
 *
 * Mirrors the Google flow: every route runs behind the authenticated
 * workspace middleware, and the single-use state row proves HomardClaw
 * started the flow for exactly this workspace and Clerk user. GitHub OAuth
 * apps do not support PKCE, so the state binding plus the server-held
 * client secret carry the whole burden; the state is consumed with a
 * guarded UPDATE so a replayed or swapped callback can never complete.
 */

import { randomBytes } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { db, githubOauthStatesTable } from "@workspace/db";
import { and, eq, isNull, lt } from "drizzle-orm";
import { requireWorkspace } from "../workspace";
import { recordAudit } from "../audit";
import { publish } from "../events";
import {
  GITHUB_SCOPES,
  GithubAuthError,
  deleteGithubAccount,
  githubClientConfig,
  missingGithubScopes,
  saveGithubAccount,
} from "./credentials";

const router: IRouter = Router();
router.use(requireWorkspace);

const STATE_TTL_MS = 10 * 60 * 1000;

/** Same origin-derivation rules as the Google flow, GitHub callback path. */
function redirectUriFor(req: Request): string {
  const configured = process.env.GITHUB_OAUTH_REDIRECT_URI?.trim();
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] ?? "https")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
    .split(",")[0]
    .trim();
  if (!host) {
    throw new GithubAuthError(
      "unavailable",
      "Could not determine this deployment's public host for the OAuth redirect.",
    );
  }
  return `${proto}://${host}/api/github/oauth/callback`;
}

/** Where the browser lands after the flow, with a status the page shows. */
function connectedAppsUrl(result: string): string {
  return `/connected-apps?github=${encodeURIComponent(result)}`;
}

/**
 * Begin the flow: mint a single-use state bound to this workspace and
 * Clerk session, and hand the browser GitHub's consent URL.
 */
router.post("/github/oauth/start", async (req, res, next): Promise<void> => {
  try {
    const { clientId } = githubClientConfig();
    const redirectUri = redirectUriFor(req);
    const state = randomBytes(32).toString("base64url");
    // Housekeeping: drop long-expired states so the table stays small.
    await db
      .delete(githubOauthStatesTable)
      .where(
        lt(githubOauthStatesTable.expiresAt, new Date(Date.now() - STATE_TTL_MS)),
      );
    await db.insert(githubOauthStatesTable).values({
      state,
      workspaceId: req.workspaceId!,
      clerkUserId: req.workspaceUserId!,
      redirectUri,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", GITHUB_SCOPES.join(" "));
    url.searchParams.set("state", state);
    res.json({ authUrl: url.toString() });
  } catch (error) {
    if (error instanceof GithubAuthError) {
      res.status(503).json({ error: error.message });
      return;
    }
    next(error);
  }
});

/**
 * GitHub redirects here. The code is exchanged over a direct server-to-
 * GitHub TLS call carrying the client secret, and the resulting token is
 * verified by asking GitHub who it belongs to before anything is stored.
 */
router.get("/github/oauth/callback", async (req, res): Promise<void> => {
  const fail = (reason: string): void => {
    res.redirect(connectedAppsUrl(`error:${reason}`));
  };
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (typeof req.query.error === "string" && req.query.error) {
    // The user denied consent (or GitHub reported an error). Consume the
    // state anyway so the aborted flow cannot be resumed later.
    if (state) {
      await db
        .update(githubOauthStatesTable)
        .set({ usedAt: new Date() })
        .where(eq(githubOauthStatesTable.state, state));
    }
    fail(req.query.error === "access_denied" ? "denied" : "github");
    return;
  }
  if (!code || !state) {
    fail("missing_params");
    return;
  }
  // Consume the state exactly once, and only for the session that minted it.
  const [row] = await db
    .update(githubOauthStatesTable)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(githubOauthStatesTable.state, state),
        isNull(githubOauthStatesTable.usedAt),
      ),
    )
    .returning();
  if (!row) {
    fail("state");
    return;
  }
  if (
    row.clerkUserId !== req.workspaceUserId ||
    row.workspaceId !== req.workspaceId
  ) {
    fail("session_mismatch");
    return;
  }
  if (row.expiresAt.getTime() < Date.now()) {
    fail("expired");
    return;
  }
  let config: { clientId: string; clientSecret: string };
  try {
    config = githubClientConfig();
  } catch {
    fail("not_configured");
    return;
  }
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: row.redirectUri,
      }),
    });
  } catch {
    fail("github_unreachable");
    return;
  }
  if (!tokenResponse.ok) {
    fail("exchange");
    return;
  }
  const tokens = (await tokenResponse.json()) as {
    access_token?: string;
    scope?: string;
    error?: string;
  };
  if (!tokens.access_token || tokens.error) {
    fail("exchange");
    return;
  }
  const grantedScopes = tokens.scope ?? "";
  if (missingGithubScopes(grantedScopes).length > 0) {
    fail("scopes");
    return;
  }
  // Ask GitHub who the token belongs to — identity comes from the
  // provider, never from anything the browser supplied.
  let user: { id?: number; login?: string };
  try {
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!userResponse.ok) {
      fail("identity");
      return;
    }
    user = (await userResponse.json()) as { id?: number; login?: string };
  } catch {
    fail("github_unreachable");
    return;
  }
  if (typeof user.id !== "number" || !user.login) {
    fail("identity");
    return;
  }
  await saveGithubAccount({
    workspaceId: row.workspaceId,
    clerkUserId: row.clerkUserId,
    githubUserId: String(user.id),
    login: user.login,
    accessToken: tokens.access_token,
    scopes: grantedScopes,
  });
  await recordAudit(
    row.workspaceId,
    "connected_app.github_connected",
    `GitHub was connected for this workspace (@${user.login}).`,
  );
  publish(row.workspaceId, "overview");
  res.redirect(connectedAppsUrl("connected"));
});

/**
 * Disconnect: delete the credential (best-effort revoking the grant at
 * GitHub). Deleting the row is what blocks new work — including
 * already-approved actions, which re-resolve the credential immediately
 * before executing.
 */
router.post(
  "/github/oauth/disconnect",
  async (req, res, next): Promise<void> => {
    try {
      const removed = await deleteGithubAccount(req.workspaceId!);
      if (removed) {
        await recordAudit(
          req.workspaceId!,
          "connected_app.github_disconnected",
          `GitHub (@${removed.login}) was disconnected from this workspace.`,
        );
        publish(req.workspaceId!, "overview");
      }
      res.json({ disconnected: Boolean(removed) });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
