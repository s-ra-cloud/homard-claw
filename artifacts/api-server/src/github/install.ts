/**
 * GitHub App installation flow for per-workspace GitHub access.
 *
 * Mirrors the OAuth flows: every route runs behind the authenticated
 * workspace middleware, and a single-use state row proves HomardClaw
 * started the installation for exactly this workspace and Clerk user.
 * GitHub carries the state through its installation consent screen and
 * hands it back to the app's configured Setup URL along with the
 * installation id; the id is then verified directly with GitHub (under
 * the app's own JWT — a foreign app's installation 404s) before anything
 * is persisted. Only identity and safe display metadata are stored; no
 * credential of any kind touches the database.
 */

import { randomBytes } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  db,
  githubInstallationsTable,
  githubInstallStatesTable,
} from "@workspace/db";
import { and, eq, isNull, lt, ne } from "drizzle-orm";
import { requireWorkspace } from "../workspace";
import { recordAudit } from "../audit";
import { publish } from "../events";
import { logger } from "../lib/logger";
import {
  deleteInstallationAtGithub,
  fetchInstallation,
  githubAppConfig,
  githubAppConfigStatus,
  invalidateGithubInstallationToken,
  githubInstallationSummary,
} from "./app-auth";
import { resumeTasksParkedForAppAuth } from "../connected-apps/auth-parked-tasks";
import {
  deleteGithubAccount,
  githubAccountSummary,
  invalidateGithubHealth,
} from "./credentials";
import { GithubAuthError } from "./github-auth-error";

const router: IRouter = Router();
router.use(requireWorkspace);

const STATE_TTL_MS = 10 * 60 * 1000;

/** Where the browser lands after the flow, with a status the page shows. */
function connectedAppsUrl(result: string): string {
  return `/connected-apps?github=${encodeURIComponent(result)}`;
}

/**
 * What the Connected Apps page needs to render the right GitHub actions:
 * which connect paths this server supports and which one the workspace is
 * on. Metadata only — never ids, keys, or tokens.
 */
router.get("/github/connection", async (req, res): Promise<void> => {
  const workspaceId = req.workspaceId!;
  const [installation, oauth] = await Promise.all([
    githubInstallationSummary(workspaceId),
    githubAccountSummary(workspaceId),
  ]);
  let oauthConfigured = true;
  if (!process.env.GITHUB_OAUTH_CLIENT_ID?.trim()) oauthConfigured = false;
  const appConfigStatus = githubAppConfigStatus();
  res.json({
    method: installation ? "github_app" : oauth ? "oauth" : null,
    appConfigured: appConfigStatus === "configured",
    // "invalid" is a server configuration MISTAKE (env vars present but
    // unusable): the page must show it as a problem to fix, never quietly
    // fall back to offering the expiring OAuth path as if it were normal.
    appConfigStatus,
    oauthConfigured,
    installation: installation
      ? {
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          repositorySelection: installation.repositorySelection,
          connectedAt: installation.connectedAt.toISOString(),
        }
      : null,
    oauthLogin: oauth?.login ?? null,
  });
});

/**
 * Begin the install: mint a single-use state bound to this workspace and
 * Clerk session, and hand the browser GitHub's installation URL. GitHub
 * passes the state through to the Setup URL callback.
 */
router.post(
  "/github/app/install/start",
  async (req, res, next): Promise<void> => {
    try {
      const config = githubAppConfig();
      if (!config) {
        res.status(503).json({
          error:
            "The GitHub App is not configured on this server (GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY).",
        });
        return;
      }
      const state = randomBytes(32).toString("base64url");
      // Housekeeping: drop long-expired states so the table stays small.
      await db
        .delete(githubInstallStatesTable)
        .where(
          lt(
            githubInstallStatesTable.expiresAt,
            new Date(Date.now() - STATE_TTL_MS),
          ),
        );
      await db.insert(githubInstallStatesTable).values({
        state,
        workspaceId: req.workspaceId!,
        clerkUserId: req.workspaceUserId!,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      });
      const url = new URL(
        `https://github.com/apps/${encodeURIComponent(config.appSlug)}/installations/new`,
      );
      url.searchParams.set("state", state);
      res.json({ installUrl: url.toString() });
    } catch (error) {
      if (error instanceof GithubAuthError) {
        res.status(503).json({ error: error.message });
        return;
      }
      next(error);
    }
  },
);

export type InstallationSetupOutcome =
  | { ok: true; result: "installed" | "updated"; accountLogin: string }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "install_removed"
        | "install_suspended"
        | "install_verify"
        | "install_claimed"
        | "github_unreachable";
    };

/**
 * Verify an installation id with GitHub and bind it to the workspace.
 * Factored out of the callback so the binding rules are testable without
 * a browser session:
 * - identity comes from GitHub (fetched under our app JWT), never from
 *   the query string;
 * - a suspended-or-missing installation is never persisted;
 * - an installation already bound to ANOTHER workspace is refused — the
 *   unique index backstops the race.
 */
export async function completeInstallationSetup(input: {
  workspaceId: string;
  clerkUserId: string;
  installationId: string;
}): Promise<InstallationSetupOutcome> {
  let config;
  try {
    config = githubAppConfig();
  } catch {
    return { ok: false, reason: "not_configured" };
  }
  if (!config) return { ok: false, reason: "not_configured" };
  const verified = await fetchInstallation(config, input.installationId);
  if (!verified.ok) {
    return {
      ok: false,
      reason:
        verified.reason === "removed"
          ? "install_removed"
          : verified.reason === "app_credentials"
            ? "install_verify"
            : "github_unreachable",
    };
  }
  // A suspended installation cannot do any work; never persist one as a
  // (seemingly healthy) binding.
  if (verified.installation.suspended) {
    return { ok: false, reason: "install_suspended" };
  }
  // Refuse an installation another workspace already claimed. (The unique
  // index makes this airtight; the pre-check gives a precise error.)
  const [claimed] = await db
    .select({ workspaceId: githubInstallationsTable.workspaceId })
    .from(githubInstallationsTable)
    .where(
      and(
        eq(
          githubInstallationsTable.installationId,
          verified.installation.installationId,
        ),
        ne(githubInstallationsTable.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (claimed) {
    logger.warn(
      {
        component: "github_app",
        workspaceId: input.workspaceId,
        failureClass: "installation_claimed",
      },
      "A workspace tried to bind a GitHub App installation already bound to another workspace",
    );
    return { ok: false, reason: "install_claimed" };
  }
  const existing = await githubInstallationSummary(input.workspaceId);
  const now = new Date();
  try {
    await db
      .insert(githubInstallationsTable)
      .values({
        workspaceId: input.workspaceId,
        clerkUserId: input.clerkUserId,
        installationId: verified.installation.installationId,
        accountLogin: verified.installation.accountLogin,
        accountType: verified.installation.accountType,
        repositorySelection: verified.installation.repositorySelection,
        connectedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: githubInstallationsTable.workspaceId,
        set: {
          clerkUserId: input.clerkUserId,
          installationId: verified.installation.installationId,
          accountLogin: verified.installation.accountLogin,
          accountType: verified.installation.accountType,
          repositorySelection: verified.installation.repositorySelection,
          updatedAt: now,
          // connectedAt deliberately kept: a repository-selection update is
          // not a new connection.
        },
      });
  } catch {
    // Unique-index race with another workspace's simultaneous claim.
    return { ok: false, reason: "install_claimed" };
  }
  // Fresh binding ⇒ any cached token/health for the OLD state is stale.
  invalidateGithubInstallationToken(input.workspaceId);
  invalidateGithubHealth(input.workspaceId);
  return {
    ok: true,
    result: existing ? "updated" : "installed",
    accountLogin: verified.installation.accountLogin,
  };
}

/**
 * GitHub redirects here after the install/consent screen (the app's Setup
 * URL must point at /api/github/app/setup with "Redirect on update"
 * enabled). The state is consumed exactly once; when GitHub omits it
 * (e.g. a repository-selection change made directly on GitHub), the
 * callback only ever refreshes the workspace's OWN already-bound
 * installation — it can never bind a new one without a state.
 */
router.get("/github/app/setup", async (req, res): Promise<void> => {
  const fail = (reason: string): void => {
    res.redirect(connectedAppsUrl(`error:${reason}`));
  };
  const installationId =
    typeof req.query.installation_id === "string"
      ? req.query.installation_id.trim()
      : "";
  const setupAction =
    typeof req.query.setup_action === "string" ? req.query.setup_action : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";

  if (setupAction === "request") {
    // The user asked an org admin to approve the installation; nothing to
    // bind yet. Consume the state so the aborted flow cannot be replayed.
    if (state) {
      await db
        .update(githubInstallStatesTable)
        .set({ usedAt: new Date() })
        .where(eq(githubInstallStatesTable.state, state));
    }
    res.redirect(connectedAppsUrl("install_pending"));
    return;
  }
  if (!/^\d{1,20}$/.test(installationId)) {
    fail("install_params");
    return;
  }

  if (state) {
    // Consume the state exactly once, only for the session that minted it.
    const [row] = await db
      .update(githubInstallStatesTable)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(githubInstallStatesTable.state, state),
          isNull(githubInstallStatesTable.usedAt),
        ),
      )
      .returning();
    if (!row) {
      fail("install_state");
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
  } else {
    // Stateless round-trip: only acceptable for refreshing an installation
    // this workspace ALREADY owns (GitHub redirects without state when the
    // owner edits repository access from GitHub's side).
    const [own] = await db
      .select({ installationId: githubInstallationsTable.installationId })
      .from(githubInstallationsTable)
      .where(eq(githubInstallationsTable.workspaceId, req.workspaceId!))
      .limit(1);
    if (!own || own.installationId !== installationId) {
      fail("install_state");
      return;
    }
  }

  const outcome = await completeInstallationSetup({
    workspaceId: req.workspaceId!,
    clerkUserId: req.workspaceUserId!,
    installationId,
  });
  if (!outcome.ok) {
    fail(outcome.reason);
    return;
  }
  await recordAudit(
    req.workspaceId!,
    "connected_app.github_connected",
    outcome.result === "installed"
      ? `The GitHub App was installed for this workspace (@${outcome.accountLogin}).`
      : `The GitHub App installation for this workspace was updated (@${outcome.accountLogin}).`,
  );
  // A working App binding releases any task parked waiting for a repaired
  // credential, so a preserved approved action resumes immediately.
  await resumeTasksParkedForAppAuth(req.workspaceId!);
  publish(req.workspaceId!, "overview");
  res.redirect(
    connectedAppsUrl(
      outcome.result === "installed" ? "app_installed" : "app_updated",
    ),
  );
});

/**
 * Disconnect: delete the installation binding (and best-effort uninstall
 * the app at GitHub so access disappears there too). Deleting the row is
 * what blocks new work — including already-approved actions, which
 * re-resolve their credential immediately before executing.
 *
 * Any leftover legacy OAuth credential is deleted in the same request:
 * "disconnect GitHub" must mean GitHub access ENDS, not that resolution
 * quietly falls back to an old token the owner forgot about.
 */
router.post(
  "/github/app/disconnect",
  async (req, res, next): Promise<void> => {
    try {
      const workspaceId = req.workspaceId!;
      const [removed] = await db
        .delete(githubInstallationsTable)
        .where(eq(githubInstallationsTable.workspaceId, workspaceId))
        .returning({
          installationId: githubInstallationsTable.installationId,
          accountLogin: githubInstallationsTable.accountLogin,
        });
      invalidateGithubInstallationToken(workspaceId);
      invalidateGithubHealth(workspaceId);
      // Also remove a leftover legacy OAuth credential (best-effort revoke
      // at GitHub happens inside), so no silent fallback survives.
      const removedOauth = await deleteGithubAccount(workspaceId);
      if (removed) {
        try {
          const config = githubAppConfig();
          if (config) {
            await deleteInstallationAtGithub(config, removed.installationId);
          }
        } catch {
          /* uninstalling at GitHub is best-effort */
        }
        await recordAudit(
          workspaceId,
          "connected_app.github_disconnected",
          removedOauth
            ? `The GitHub App installation (@${removed.accountLogin}) and the leftover legacy GitHub sign-in (@${removedOauth.login}) were disconnected from this workspace.`
            : `The GitHub App installation (@${removed.accountLogin}) was disconnected from this workspace.`,
        );
        publish(workspaceId, "overview");
      } else if (removedOauth) {
        await recordAudit(
          workspaceId,
          "connected_app.github_disconnected",
          `GitHub (@${removedOauth.login}) was disconnected from this workspace.`,
        );
        publish(workspaceId, "overview");
      }
      res.json({ disconnected: Boolean(removed || removedOauth) });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
