/**
 * Per-workspace Google (Gmail) credentials, created by the in-app OAuth
 * flow. Only the encrypted refresh token is durable; access tokens live in
 * a short in-memory cache and are never persisted or logged. Every helper
 * here resolves the credential from a workspace id — never from a browser
 * session — so background work always uses the mailbox of the task's
 * durable owner.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { db, googleAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export type GoogleAuthClassification =
  | "configuration"
  | "credential"
  | "missing_scope"
  | "network"
  | "provider_refused"
  | "timeout"
  | "cancelled";

export class GoogleAuthError extends Error {
  constructor(
    /**
     * "not_connected" — no Gmail account is connected to the workspace.
      * "reconnect_required" — a credential exists but Google no longer
      * accepts it (revoked, expired consent, rotated SESSION_SECRET) or it
      * lacks a required scope; the user must reconnect. `classification`
      * distinguishes a missing scope from a revoked credential.
     * "unavailable" — a transient failure (network, missing server
     * config); nothing is wrong with the stored credential.
     */
    readonly kind: "not_connected" | "reconnect_required" | "unavailable",
    message: string,
    details?: {
      /**
       * A fixed, non-sensitive reason for the failure. This is deliberately
       * separate from `kind`: callers that already treat every unavailable
       * credential as a failed provider call can keep doing so, while
       * transports that need to distinguish cancellation from a provider
       * outage can use this stable value.
       */
      classification?: GoogleAuthClassification;
      /** Safe provider status metadata; response bodies are never retained. */
      status?: number;
    },
  ) {
    super(message);
    this.name = "GoogleAuthError";
    this.classification = details?.classification;
    this.status = details?.status;
  }

  readonly classification?: GoogleAuthClassification;
  readonly status?: number;
}

const FORMAT = "v1";

/**
 * Key derived from SESSION_SECRET with its own label (never shared with the
 * Codex store). Rotating SESSION_SECRET makes stored refresh tokens
 * undecryptable, which surfaces as "reconnect Gmail" — never as silence.
 */
function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new GoogleAuthError(
      "unavailable",
      "SESSION_SECRET is not set on this server, so a Google sign-in cannot be stored securely.",
      { classification: "configuration" },
    );
  }
  return createHash("sha256").update(`google-credential:${secret}`).digest();
}

export function encryptRefreshToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const sealed = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    FORMAT,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    sealed.toString("base64"),
  ].join(".");
}

function decryptRefreshToken(payload: string): string {
  const [format, iv, tag, sealed] = payload.split(".");
  if (format !== FORMAT || !iv || !tag || !sealed) {
    throw new GoogleAuthError(
      "reconnect_required",
      "The stored Google sign-in is not in a format this server understands. Reconnect Gmail.",
      { classification: "credential" },
    );
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof GoogleAuthError) throw error;
    throw new GoogleAuthError(
      "reconnect_required",
      "The stored Google sign-in could not be decrypted, usually because SESSION_SECRET changed. Reconnect Gmail.",
      { classification: "credential" },
    );
  }
}

/** The Gmail scopes HomardClaw requests — least privilege for its catalog. */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

/**
 * The baseline Drive scopes: read any file, create/manage only the files
 * HomardClaw itself creates. Every existing connection has at least these.
 */
export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
] as const;

/**
 * Google's broad full-Drive scope. The OWNER CHOSE this deliberately: the
 * catalog's organization operations (create folder, rename, move) must work
 * on files that already existed before HomardClaw, which drive.file can
 * never touch. It is requested at Drive consent but never silently assumed:
 * a connection that declined it keeps working for reads and app-created
 * files, and only the organization operations fail closed with reconnect
 * guidance. Delete and share stay out of the catalog regardless of scope.
 */
export const DRIVE_ORGANIZE_SCOPE = "https://www.googleapis.com/auth/drive";

/** Scopes requested at consent: identity + the Gmail set. */
export const REQUESTED_SCOPES = [
  "openid",
  "email",
  ...GMAIL_SCOPES,
] as const;

/** Scopes requested by the incremental Drive consent: identity + Drive,
 * including the broad organization scope (see DRIVE_ORGANIZE_SCOPE). */
export const DRIVE_REQUESTED_SCOPES = [
  "openid",
  "email",
  ...DRIVE_SCOPES,
  DRIVE_ORGANIZE_SCOPE,
] as const;

function missingScopes(
  granted: string,
  required: readonly string[],
): string[] {
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  // The broad Drive scope supersedes both narrow ones: a grant that has it
  // can do everything drive.readonly and drive.file allow, so their literal
  // absence must not read as a narrowed grant.
  if (have.has(DRIVE_ORGANIZE_SCOPE)) {
    for (const scope of DRIVE_SCOPES) have.add(scope);
  }
  return required.filter((scope) => !have.has(scope));
}

export function missingGmailScopes(granted: string): string[] {
  return missingScopes(granted, GMAIL_SCOPES);
}

export function missingDriveScopes(granted: string): string[] {
  return missingScopes(granted, DRIVE_SCOPES);
}

/** True when the grant can organize pre-existing Drive files. */
export function hasDriveOrganizeScope(granted: string): boolean {
  return missingScopes(granted, [DRIVE_ORGANIZE_SCOPE]).length === 0;
}

export type GoogleAccountSummary = {
  email: string;
  scopes: string;
  connectedAt: Date;
  updatedAt: Date;
  missingScopes: string[];
  missingDriveScopes: string[];
  /** False when the grant predates (or declined) the broad Drive scope. */
  canOrganizeDrive: boolean;
};

/** Metadata only — never decrypts, safe on every request. */
export async function googleAccountSummary(
  workspaceId: string,
): Promise<GoogleAccountSummary | null> {
  const [row] = await db
    .select({
      email: googleAccountsTable.email,
      scopes: googleAccountsTable.scopes,
      connectedAt: googleAccountsTable.connectedAt,
      updatedAt: googleAccountsTable.updatedAt,
    })
    .from(googleAccountsTable)
    .where(eq(googleAccountsTable.workspaceId, workspaceId))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    missingScopes: missingGmailScopes(row.scopes),
    missingDriveScopes: missingDriveScopes(row.scopes),
    canOrganizeDrive: hasDriveOrganizeScope(row.scopes),
  };
}

/**
 * Store (or replace) the workspace's Google account after a completed
 * consent. Replacing always overwrites the credential and bumps the
 * revision, so any refresh started against the old account can never fold
 * its token back in.
 */
export async function saveGoogleAccount(input: {
  workspaceId: string;
  clerkUserId: string;
  googleSub: string;
  email: string;
  refreshToken: string;
  scopes: string;
}): Promise<void> {
  const refreshTokenEnc = encryptRefreshToken(input.refreshToken);
  const now = new Date();
  // Incremental consent: when the SAME Google account reconnects (e.g. to
  // add Drive), previously granted scopes are kept — Google's
  // include_granted_scopes usually reports them all, but a union here means
  // a Drive connect can never silently drop Gmail. A different account
  // replaces everything.
  let scopes = input.scopes;
  const [existing] = await db
    .select({
      googleSub: googleAccountsTable.googleSub,
      scopes: googleAccountsTable.scopes,
    })
    .from(googleAccountsTable)
    .where(eq(googleAccountsTable.workspaceId, input.workspaceId))
    .limit(1);
  if (existing && existing.googleSub === input.googleSub) {
    scopes = [
      ...new Set(
        `${existing.scopes} ${input.scopes}`.split(/\s+/).filter(Boolean),
      ),
    ].join(" ");
  }
  await db
    .insert(googleAccountsTable)
    .values({
      workspaceId: input.workspaceId,
      clerkUserId: input.clerkUserId,
      googleSub: input.googleSub,
      email: input.email,
      refreshTokenEnc,
      scopes,
      connectedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: googleAccountsTable.workspaceId,
      set: {
        clerkUserId: input.clerkUserId,
        googleSub: input.googleSub,
        email: input.email,
        refreshTokenEnc,
        scopes,
        revision: randomBytes(16).toString("hex"),
        connectedAt: now,
        updatedAt: now,
      },
    });
  accessTokens.delete(input.workspaceId);
}

/** Remove the credential. Returns the row that was deleted, if any. */
export async function deleteGoogleAccount(
  workspaceId: string,
): Promise<{ email: string } | null> {
  const [row] = await db
    .delete(googleAccountsTable)
    .where(eq(googleAccountsTable.workspaceId, workspaceId))
    .returning({
      email: googleAccountsTable.email,
      refreshTokenEnc: googleAccountsTable.refreshTokenEnc,
    });
  accessTokens.delete(workspaceId);
  if (!row) return null;
  // Best-effort revocation at Google so the grant disappears from the
  // user's account page too. Failure is fine — the row is already gone,
  // which is what blocks all new work.
  try {
    const token = decryptRefreshToken(row.refreshTokenEnc);
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    /* revocation is best-effort */
  }
  return { email: row.email };
}

export function googleClientConfig(): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new GoogleAuthError(
      "unavailable",
      "Google OAuth is not configured on this server (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).",
      { classification: "configuration" },
    );
  }
  return { clientId, clientSecret };
}

/**
 * Short-lived access tokens, cached in memory only and bound to the
 * credential revision that produced them: replacing or disconnecting the
 * account invalidates the cache entry even before it expires.
 */
const accessTokens = new Map<
  string,
  { token: string; expiresAt: number; revision: string }
>();
const EXPIRY_SLACK_MS = 60_000;
const GOOGLE_REFRESH_MAX_MS = 30_000;
const REFRESH_TIMEOUT_REASON = "google-refresh-timeout";
const REFRESH_CANCEL_REASON = "google-refresh-cancelled";

export type DriveAccessTokenOptions = {
  signal?: AbortSignal;
  /**
   * Absolute time (milliseconds since the Unix epoch) by which this caller
   * must have a token. A refresh never runs longer than 30 seconds, even when
   * this is omitted or farther in the future.
   */
  deadlineAt?: number;
  /** Receives fixed, non-sensitive credential-resolution stages. */
  onStage?: (stage: string) => void;
};

type RefreshResult = {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
};

type RefreshListener = {
  onStage?: (stage: string) => void;
};

type RefreshFlight = {
  controller: AbortController;
  listeners: Map<symbol, RefreshListener>;
  stage: 0 | 1 | 2;
  promise: Promise<RefreshResult>;
};

/**
 * Google refreshes are shared by workspace + credential revision. Sharing
 * avoids a burst of simultaneous requests all spending the same refresh
 * token, but a caller's deadline/cancellation belongs only to its own wait.
 * The underlying request is aborted only after every subscriber has left.
 */
const refreshFlights = new Map<string, RefreshFlight>();

type RefreshAbortReason = "timeout" | "cancelled";

class RefreshAbort extends Error {
  constructor(readonly reason: RefreshAbortReason) {
    super(reason);
    this.name = "RefreshAbort";
  }
}

function safeStage(
  onStage: ((stage: string) => void) | undefined,
  stage: "credential" | "refresh" | "refresh_body",
): void {
  try {
    onStage?.(stage);
  } catch {
    // Stage reporting is observability only and must never affect auth.
  }
}

function safeRefreshError(
  reason: RefreshAbortReason,
): GoogleAuthError {
  return new GoogleAuthError(
    "unavailable",
    reason === "timeout"
      ? "Google credential refresh timed out. Try again."
      : "Google credential refresh was cancelled.",
    { classification: reason },
  );
}

function abortReason(signal: AbortSignal): RefreshAbortReason {
  return signal.reason === REFRESH_TIMEOUT_REASON ? "timeout" : "cancelled";
}

function signalRefreshAbort(signal: AbortSignal): RefreshAbort {
  return new RefreshAbort(abortReason(signal));
}

/**
 * Race a fetch or body read against the shared refresh controller. Fetch
 * implementations should reject when their signal is aborted; the explicit
 * race is also needed for test doubles and for body readers that do not
 * immediately surface an abort.
 */
function boundedRefreshOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signalRefreshAbort(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () =>
      finish(() => reject(signalRefreshAbort(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function refreshFailure(error: unknown, signal: AbortSignal): GoogleAuthError {
  if (error instanceof GoogleAuthError) return error;
  if (error instanceof RefreshAbort || signal.aborted) {
    return safeRefreshError(
      error instanceof RefreshAbort ? error.reason : abortReason(signal),
    );
  }
  // Fetch implementations report a caller cancellation as AbortError. Keep
  // that safe cancellation classification instead of flattening it into a
  // generic unavailable/network failure.
  if (error instanceof Error && error.name === "AbortError") {
    return safeRefreshError("cancelled");
  }
  return new GoogleAuthError(
    "unavailable",
    "Could not reach Google to refresh the Google credential. Try again.",
    { classification: "network" },
  );
}

function reportFlightStage(
  flight: RefreshFlight,
  stage: 1 | 2,
): void {
  if (flight.stage >= stage) return;
  flight.stage = stage;
  for (const listener of flight.listeners.values()) {
    safeStage(listener.onStage, stage === 1 ? "refresh" : "refresh_body");
  }
}

function removeRefreshListener(
  flight: RefreshFlight,
  key: symbol,
  reason?: RefreshAbortReason,
): void {
  flight.listeners.delete(key);
  if (
    reason &&
    flight.listeners.size === 0 &&
    !flight.controller.signal.aborted
  ) {
    flight.controller.abort(
      reason === "timeout" ? REFRESH_TIMEOUT_REASON : REFRESH_CANCEL_REASON,
    );
  }
}

function callerDeadlineAt(options?: DriveAccessTokenOptions): number | null {
  const deadlineAt = options?.deadlineAt;
  return typeof deadlineAt === "number" && Number.isFinite(deadlineAt)
    ? deadlineAt
    : null;
}

function callerAbort(options?: DriveAccessTokenOptions): RefreshAbortReason | null {
  if (options?.signal?.aborted) {
    return options.signal.reason === REFRESH_TIMEOUT_REASON
      ? "timeout"
      : "cancelled";
  }
  const deadlineAt = callerDeadlineAt(options);
  return deadlineAt !== null && deadlineAt <= Date.now() ? "timeout" : null;
}

function createRefreshFlight(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  key: string,
): RefreshFlight {
  const controller = new AbortController();
  const flight = {
    controller,
    listeners: new Map<symbol, RefreshListener>(),
    stage: 0 as const,
    promise: undefined as unknown as Promise<RefreshResult>,
  };
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  deadlineTimer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(REFRESH_TIMEOUT_REASON);
    }
  }, GOOGLE_REFRESH_MAX_MS);
  deadlineTimer.unref?.();
  const operation = performRefresh({
    refreshToken,
    clientId,
    clientSecret,
    controller,
    reportStage: (stage) => reportFlightStage(flight, stage),
  });
  flight.promise = operation.finally(() => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (refreshFlights.get(key) === flight) refreshFlights.delete(key);
  });
  // A flight can outlive all of its callers for a microtask while its abort
  // rejection propagates. Keep that rejection attached so it is never an
  // unhandled process-level error.
  void flight.promise.catch(() => {});
  return flight;
}

async function performRefresh(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  controller: AbortController;
  reportStage: (stage: 1 | 2) => void;
}): Promise<RefreshResult> {
  const { controller } = input;
  input.reportStage(1);
  let response: Response;
  try {
    const request = fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }),
      signal: controller.signal,
    });
    response = await boundedRefreshOperation(request, controller.signal);
  } catch (error) {
    throw refreshFailure(error, controller.signal);
  }

  input.reportStage(2);
  let body: string;
  try {
    // Keep using the same signal/deadline for the response body. A provider
    // can send headers promptly and then leave a body read hanging.
    body = await boundedRefreshOperation(
      response.text(),
      controller.signal,
    );
  } catch (error) {
    throw refreshFailure(error, controller.signal);
  }

  if (!response.ok) {
    const invalidGrant = /invalid_grant/i.test(body);
    if (invalidGrant || response.status === 400 || response.status === 401) {
      throw new GoogleAuthError(
        "reconnect_required",
        "Google no longer accepts this Google connection (access was revoked or consent expired). Reconnect Google.",
        { classification: "provider_refused", status: response.status },
      );
    }
    throw new GoogleAuthError(
      "unavailable",
      "Google's token endpoint failed. Try again shortly.",
      { classification: "provider_refused", status: response.status },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new GoogleAuthError(
      "unavailable",
      "Google's token endpoint returned an unreadable response. Try again shortly.",
      { classification: "provider_refused", status: response.status },
    );
  }
  const data = parsed as {
    access_token?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
  };
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new GoogleAuthError(
      "unavailable",
      "Google's token endpoint returned no access token. Try again shortly.",
      { classification: "provider_refused", status: response.status },
    );
  }
  return {
    accessToken: data.access_token,
    expiresIn:
      typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
        ? data.expires_in
        : 3600,
    refreshToken:
      typeof data.refresh_token === "string" && data.refresh_token.length > 0
        ? data.refresh_token
        : undefined,
  };
}

function waitForRefresh(
  flight: RefreshFlight,
  options?: DriveAccessTokenOptions,
): Promise<RefreshResult> {
  const key = Symbol("google-refresh-caller");
  const signal = options?.signal;
  const deadlineAt = callerDeadlineAt(options);
  const immediateReason = callerAbort(options);
  return new Promise<RefreshResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = (reason?: RefreshAbortReason) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      removeRefreshListener(flight, key, reason);
    };
    const finish = (
      callback: () => void,
      reason?: RefreshAbortReason,
    ) => {
      if (settled) return;
      settled = true;
      cleanup(reason);
      callback();
    };
    const onAbort = () => {
      const reason: RefreshAbortReason =
        signal?.reason === REFRESH_TIMEOUT_REASON ? "timeout" : "cancelled";
      finish(() => reject(safeRefreshError(reason)), reason);
    };

    flight.listeners.set(key, { onStage: options?.onStage });
    if (flight.stage >= 1) safeStage(options?.onStage, "refresh");
    if (flight.stage >= 2) safeStage(options?.onStage, "refresh_body");
    if (immediateReason) {
      finish(() => reject(safeRefreshError(immediateReason)), immediateReason);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (deadlineAt !== null) {
      const delay = Math.max(0, deadlineAt - Date.now());
      timer = setTimeout(() => {
        finish(() => reject(safeRefreshError("timeout")), "timeout");
      }, delay);
      timer.unref?.();
    }
    flight.promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * Resolve a usable access token for the workspace's Gmail account,
 * refreshing (and rotating, revision-fenced) as needed. Throws
 * GoogleAuthError — never returns a stale or foreign credential.
 */
export async function gmailAccessToken(workspaceId: string): Promise<{
  token: string;
  email: string;
  googleSub: string;
}> {
  return googleAccessToken(workspaceId, GMAIL_SCOPES, "Gmail");
}

/**
 * Resolve a usable access token for the workspace's Google account with
 * Drive access. Fails closed when Drive scopes were never granted.
 */
export async function driveAccessToken(
  workspaceId: string,
  options?: DriveAccessTokenOptions,
): Promise<{
  token: string;
  email: string;
  googleSub: string;
}> {
  return googleAccessToken(workspaceId, DRIVE_SCOPES, "Google Drive", {
    refreshOptions: options,
  });
}

/**
 * Resolve a token for Drive ORGANIZATION work (create folder, rename,
 * move). Requires the broad Drive scope on top of the baseline: a
 * connection made before that scope existed — or one that declined it —
 * fails closed here with reconnect guidance, before any provider call.
 */
export async function driveOrganizeAccessToken(workspaceId: string): Promise<{
  token: string;
  email: string;
  googleSub: string;
}> {
  return googleAccessToken(
    workspaceId,
    [...DRIVE_SCOPES, DRIVE_ORGANIZE_SCOPE],
    "Google Drive",
    {
      partialScopeMessage:
        "Organizing existing Drive files (creating folders, renaming, moving) needs full Google Drive access, which this connection has not granted. Reconnect Google Drive from the Connected Apps page and approve the full access request.",
    },
  );
}

async function googleAccessToken(
  workspaceId: string,
  requiredScopes: readonly string[],
  serviceLabel: string,
  options?: {
    /** Overrides the generic message when SOME scopes are granted but the
     * required set is incomplete (reconnect_required, not not_connected). */
    partialScopeMessage?: string;
    refreshOptions?: DriveAccessTokenOptions;
  },
): Promise<{
  token: string;
  email: string;
  googleSub: string;
}> {
  safeStage(options?.refreshOptions?.onStage, "credential");
  const immediateReason = callerAbort(options?.refreshOptions);
  if (immediateReason) throw safeRefreshError(immediateReason);
  const [row] = await db
    .select()
    .from(googleAccountsTable)
    .where(eq(googleAccountsTable.workspaceId, workspaceId))
    .limit(1);
  const postCredentialReason = callerAbort(options?.refreshOptions);
  if (postCredentialReason) throw safeRefreshError(postCredentialReason);
  if (!row) {
    throw new GoogleAuthError(
      "not_connected",
      `No Google account is connected to this workspace. Connect ${serviceLabel} first.`,
    );
  }
  const missing = missingScopes(row.scopes, requiredScopes);
  if (missing.length > 0) {
    // All scopes absent = this service was never connected; a partial set
    // means a grant was narrowed (or an expanded scope was never granted)
    // and must be re-consented.
    const partial = missing.length < requiredScopes.length;
    throw new GoogleAuthError(
      partial ? "reconnect_required" : "not_connected",
      partial && options?.partialScopeMessage
        ? options.partialScopeMessage
        : `The connected Google account has not granted the required ${serviceLabel} permissions (${missing.join(", ")}). Connect ${serviceLabel} and grant all requested access.`,
        { classification: "missing_scope" },
    );
  }
  const cached = accessTokens.get(workspaceId);
  if (
    cached &&
    cached.revision === row.revision &&
    cached.expiresAt - EXPIRY_SLACK_MS > Date.now()
  ) {
    return { token: cached.token, email: row.email, googleSub: row.googleSub };
  }

  const refreshToken = decryptRefreshToken(row.refreshTokenEnc);
  const { clientId, clientSecret } = googleClientConfig();
  const refreshKey = `${workspaceId}:${row.revision}`;
  let flight = refreshFlights.get(refreshKey);
  if (!flight || flight.controller.signal.aborted) {
    flight = createRefreshFlight(
      refreshToken,
      clientId,
      clientSecret,
      refreshKey,
    );
    refreshFlights.set(refreshKey, flight);
  }
  const data = await waitForRefresh(flight, options?.refreshOptions);
  // Rotation: if Google issued a new refresh token, fold it in only when
  // the row still carries the revision this refresh started from, so a
  // concurrent reconnect or disconnect is never undone by a stale write.
  if (data.refreshToken && data.refreshToken !== refreshToken) {
    await db
      .update(googleAccountsTable)
      .set({
        refreshTokenEnc: encryptRefreshToken(data.refreshToken),
        revision: randomBytes(16).toString("hex"),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(googleAccountsTable.workspaceId, workspaceId),
          eq(googleAccountsTable.revision, row.revision),
        ),
      );
  }
  const expiresAt = Date.now() + Math.max(60, data.expiresIn) * 1000;
  // Cache under the revision we read; a concurrent replace invalidates it.
  accessTokens.set(workspaceId, {
    token: data.accessToken,
    expiresAt,
    revision: row.revision,
  });
  return {
    token: data.accessToken,
    email: row.email,
    googleSub: row.googleSub,
  };
}

/** Test hook: clear the in-memory access-token cache. */
export function clearGoogleTokenCache(): void {
  accessTokens.clear();
}
