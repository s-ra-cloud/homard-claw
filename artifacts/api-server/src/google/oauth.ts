/**
 * In-app Google OAuth (authorization code + PKCE) for per-user Gmail.
 *
 * Every route runs behind the authenticated workspace middleware — the
 * callback included, since Google redirects the same signed-in browser back
 * to this origin. The state row is the single-use proof that HomardClaw
 * started the flow for exactly this workspace and Clerk user: it is
 * consumed with a guarded UPDATE so a replayed or swapped callback can
 * never complete, and the PKCE verifier plus ID-token nonce close the
 * remaining injection paths.
 */

import { createHash, randomBytes } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { db, googleOauthStatesTable } from "@workspace/db";
import { and, eq, isNull, lt } from "drizzle-orm";
import { requireWorkspace } from "../workspace";
import { recordAudit } from "../audit";
import { publish } from "../events";
import {
  GoogleAuthError,
  REQUESTED_SCOPES,
  DRIVE_REQUESTED_SCOPES,
  deleteGoogleAccount,
  googleClientConfig,
  missingDriveScopes,
  missingGmailScopes,
  saveGoogleAccount,
} from "./credentials";

/** The Google-backed apps a consent flow can be started for. */
type GoogleService = "gmail" | "google_drive";

function parseService(value: unknown): GoogleService {
  return value === "google_drive" ? "google_drive" : "gmail";
}

const SERVICE_CONFIG: Record<
  GoogleService,
  {
    scopes: readonly string[];
    missing: (granted: string) => string[];
    displayName: string;
  }
> = {
  gmail: {
    scopes: REQUESTED_SCOPES,
    missing: missingGmailScopes,
    displayName: "Gmail",
  },
  google_drive: {
    scopes: DRIVE_REQUESTED_SCOPES,
    missing: missingDriveScopes,
    displayName: "Google Drive",
  },
};

const router: IRouter = Router();
router.use(requireWorkspace);

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The public origin serving this request. Path routing puts the web app
 * and this API on one origin, so the callback lives at a fixed path under
 * it. GOOGLE_OAUTH_REDIRECT_URI overrides everything for deployments where
 * the derived origin would be wrong.
 */
function redirectUriFor(req: Request): string {
  const configured = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] ?? "https")
    .split(",")[0]!
    .trim();
  const host = String(
    req.headers["x-forwarded-host"] ?? req.headers.host ?? "",
  )
    .split(",")[0]!
    .trim();
  if (!host) {
    throw new GoogleAuthError(
      "unavailable",
      "Could not determine this deployment's public host for the OAuth redirect.",
    );
  }
  return `${proto}://${host}/api/google/oauth/callback`;
}

/** Where the browser lands after the flow, with a status the page shows. */
function connectedAppsUrl(service: GoogleService, result: string): string {
  return `/connected-apps?${service}=${encodeURIComponent(result)}`;
}

/**
 * Begin the flow: mint a single-use state bound to this workspace and
 * Clerk session, persist the PKCE verifier and nonce server-side, and hand
 * the browser Google's consent URL. Nothing secret leaves the server.
 */
router.post("/google/oauth/start", async (req, res, next): Promise<void> => {
  try {
    const service = parseService(
      (req.body as { service?: unknown } | undefined)?.service,
    );
    const { clientId } = googleClientConfig();
    const redirectUri = redirectUriFor(req);
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const nonce = randomBytes(16).toString("base64url");
    // Housekeeping: drop long-expired states so the table stays small.
    await db
      .delete(googleOauthStatesTable)
      .where(
        lt(googleOauthStatesTable.expiresAt, new Date(Date.now() - STATE_TTL_MS)),
      );
    await db.insert(googleOauthStatesTable).values({
      state,
      service,
      workspaceId: req.workspaceId!,
      clerkUserId: req.workspaceUserId!,
      codeVerifier,
      nonce,
      redirectUri,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SERVICE_CONFIG[service].scopes.join(" "));
    // Incremental consent: adding Drive must not revoke Gmail (or the
    // other way round) — previously granted scopes ride along.
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // Offline + consent guarantees a refresh token even on reconnects.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    res.json({ authUrl: url.toString() });
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      res.status(503).json({ error: error.message });
      return;
    }
    next(error);
  }
});

/** Decode (without trusting) the payload of a JWT from Google. */
function jwtPayload(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Google redirects here. The ID token arrives over the direct server-to-
 * Google token exchange (TLS, client secret, PKCE verifier), so its payload
 * is trusted the way any token-endpoint response body is; the nonce check
 * additionally pins it to the state row this flow started with.
 */
router.get("/google/oauth/callback", async (req, res): Promise<void> => {
  // Until the state row is loaded, errors are reported against Gmail (the
  // default service); afterwards, against the service the flow was for.
  let service: GoogleService = "gmail";
  const fail = (reason: string): void => {
    res.redirect(connectedAppsUrl(service, `error:${reason}`));
  };
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (typeof req.query.error === "string" && req.query.error) {
    // The user denied consent (or Google reported an error). Consume the
    // state anyway so the aborted flow cannot be resumed later.
    if (state) {
      await db
        .update(googleOauthStatesTable)
        .set({ usedAt: new Date() })
        .where(eq(googleOauthStatesTable.state, state));
    }
    fail(req.query.error === "access_denied" ? "denied" : "google");
    return;
  }
  if (!code || !state) {
    fail("missing_params");
    return;
  }
  // Consume the state exactly once, and only for the session that minted it.
  const [row] = await db
    .update(googleOauthStatesTable)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(googleOauthStatesTable.state, state),
        isNull(googleOauthStatesTable.usedAt),
      ),
    )
    .returning();
  if (!row) {
    fail("state");
    return;
  }
  service = parseService(row.service);
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
    config = googleClientConfig();
  } catch {
    fail("not_configured");
    return;
  }
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: row.redirectUri,
        code_verifier: row.codeVerifier,
      }),
    });
  } catch {
    fail("google_unreachable");
    return;
  }
  if (!tokenResponse.ok) {
    fail("exchange");
    return;
  }
  const tokens = (await tokenResponse.json()) as {
    refresh_token?: string;
    id_token?: string;
    scope?: string;
  };
  const payload = tokens.id_token ? jwtPayload(tokens.id_token) : null;
  const sub = typeof payload?.sub === "string" ? payload.sub : "";
  const email = typeof payload?.email === "string" ? payload.email : "";
  const nonce = typeof payload?.nonce === "string" ? payload.nonce : "";
  const aud = typeof payload?.aud === "string" ? payload.aud : "";
  if (!sub || nonce !== row.nonce || aud !== config.clientId) {
    fail("identity");
    return;
  }
  if (!tokens.refresh_token) {
    fail("no_refresh_token");
    return;
  }
  const grantedScopes = tokens.scope ?? "";
  if (SERVICE_CONFIG[service].missing(grantedScopes).length > 0) {
    fail("scopes");
    return;
  }
  await saveGoogleAccount({
    workspaceId: row.workspaceId,
    clerkUserId: row.clerkUserId,
    googleSub: sub,
    email: email || "(unknown address)",
    refreshToken: tokens.refresh_token,
    scopes: grantedScopes,
  });
  const displayName = SERVICE_CONFIG[service].displayName;
  await recordAudit(
    row.workspaceId,
    service === "gmail"
      ? "connected_app.gmail_connected"
      : "connected_app.google_drive_connected",
    `${displayName} was connected for this workspace (${email || "address withheld"}).`,
  );
  publish(row.workspaceId, "overview");
  res.redirect(connectedAppsUrl(service, "connected"));
});

/**
 * Disconnect: delete the credential (best-effort revoking it at Google).
 * Deleting the row is what blocks new work — including already-approved
 * actions, which re-resolve the credential immediately before executing.
 */
router.post(
  "/google/oauth/disconnect",
  async (req, res, next): Promise<void> => {
    try {
      const removed = await deleteGoogleAccount(req.workspaceId!);
      if (removed) {
        await recordAudit(
          req.workspaceId!,
          "connected_app.gmail_disconnected",
          `The Google account (${removed.email}) was disconnected from this workspace; Gmail and Google Drive access ended with it.`,
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
