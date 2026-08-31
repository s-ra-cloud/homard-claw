import { type AppOperation, type ConnectedAppId } from "./catalog";
import { buildRfc822, sanitizeEmailHtml } from "./email-mime";
import {
  MAX_APPEND_ROWS,
  MAX_MUTATION_CELLS,
  MAX_READ_CELLS,
  parseA1Range,
  parseSheetValues,
  quoteTab,
  rowsToRowData,
} from "./sheets";
import {
  GoogleAuthError,
  driveAccessToken,
  gmailAccessToken,
  googleAccountSummary,
} from "../google/credentials";
import {
  GithubAuthError,
  checkGithubConnectionHealth,
  githubAuth,
  githubAuthMethod,
} from "../github/credentials";
import { invalidateGithubInstallationToken } from "../github/app-auth";
import {
  classifyGithubRefusal,
  describeGithubRefusal,
} from "../github/failures";
import { logger } from "../lib/logger";

/**
 * Live connection state of the workspace owner's account for one app.
 * "unavailable" means the connector service itself could not be reached —
 * deliberately distinct from "not_connected" so a transient platform outage
 * never reads as "the owner disconnected this app".
 */
export type ConnectionStatus = {
  status: "connected" | "expired" | "not_connected" | "unavailable";
  detail: string | null;
  /**
   * A human-readable label for the connected account (an email address or
   * login) when the platform exposes one — never a credential, token, or
   * raw connector metadata. Null when no safe label is available.
   */
  accountLabel: string | null;
};

/**
 * Every app now connects per workspace through in-app OAuth: Gmail and
 * Drive share the workspace's own Google account (Drive is an incremental
 * consent on top of it), and GitHub has its own OAuth-app credential. No
 * shared platform connector remains, so a credential can never become a
 * cross-user access path.
 */
export async function connectionStatus(
  app: ConnectedAppId,
  workspaceId: string,
): Promise<ConnectionStatus> {
  if (app === "gmail" || app === "google_drive") {
    const account = await googleAccountSummary(workspaceId);
    if (!account) {
      return { status: "not_connected", detail: null, accountLabel: null };
    }
    if (app === "gmail") {
      if (account.missingScopes.length > 0) {
        return {
          status: "expired",
          detail:
            "The connected Google account is missing required Gmail permissions. Reconnect and grant all requested access.",
          accountLabel: account.email,
        };
      }
      return { status: "connected", detail: null, accountLabel: account.email };
    }
    if (account.missingDriveScopes.length > 0) {
      // The Google account exists but Drive was never granted: to the user
      // this app is simply not connected yet.
      return {
        status: "not_connected",
        detail:
          "Your Google account is connected, but Drive access has not been granted yet. Connect Google Drive to add it.",
        accountLabel: null,
      };
    }
    return { status: "connected", detail: null, accountLabel: account.email };
  }
  // GitHub: a stored row is NOT treated as proof of a working connection.
  // The health check verifies the credential against GitHub itself (with a
  // bounded timeout and a short cache), so a revoked or undecryptable token
  // surfaces as "reconnect needed" here — before any agent task depends on
  // it — while a transient GitHub outage reports "unavailable" instead of
  // silently flipping the account to broken.
  const health = await checkGithubConnectionHealth(workspaceId);
  switch (health.state) {
    case "not_connected":
      return { status: "not_connected", detail: null, accountLabel: null };
    case "connected":
      return {
        status: "connected",
        detail: health.detail,
        accountLabel: health.login,
      };
    case "reconnect_required":
      return {
        status: "expired",
        detail: health.detail,
        accountLabel: health.login,
      };
    default:
      return {
        status: "unavailable",
        detail: health.detail,
        accountLabel: health.login,
      };
  }
}

/** Longest result payload ever fed back to a model or stored on an action. */
const RESULT_CHAR_LIMIT = 4_000;

export type ExecutionOutcome =
  | { ok: true; summary: string }
  | {
      ok: false;
      /**
       * "auth" — the connection is missing, expired, or lacks a scope; the
       * owner must reconnect. "failed" — the provider rejected this call.
       */
      kind: "auth" | "failed";
      message: string;
    };

function truncate(text: string): string {
  return text.length > RESULT_CHAR_LIMIT
    ? `${text.slice(0, RESULT_CHAR_LIMIT)}\n[truncated]`
    : text;
}

/**
 * Map a connector-proxy failure to an outcome. Exposed for tests: the
 * regression suite must pin down that expired/missing authorization becomes
 * an "auth" outcome the owner can act on, not a generic failure.
 */
export function mapProxyFailure(
  status: number,
  bodyText: string,
): ExecutionOutcome {
  const detail = truncate(bodyText.trim()).slice(0, 500);
  if (status === 401 || status === 403) {
    return {
      ok: false,
      kind: "auth",
      message: `The connected account's authorization was refused (HTTP ${status}). It may have expired or lack the needed permission — reconnect the app and try again. ${detail}`,
    };
  }
  return {
    ok: false,
    kind: "failed",
    message: `The app rejected the request (HTTP ${status}). ${detail}`,
  };
}


/**
 * Context threaded into every executor. `actionId` is the durable action
 * row id; write executors derive their idempotency marker from it so an
 * ambiguous outcome (crash mid-call) can later be verified against the
 * provider instead of guessed at.
 */
export type ExecutionContext = {
  actionId: string | null;
  /**
   * The durable workspace that owns the task requesting the operation.
   * Credentials are always resolved from this — never from a browser
   * session or an ambient connector — so an approval decided in one
   * session can only ever execute against its own owner's accounts.
   */
  workspaceId: string | null;
};

/** Outcome for operations attempted without a resolvable owner. */
const NO_WORKSPACE_OUTCOME: ExecutionOutcome = {
  ok: false,
  kind: "auth",
  message:
    "This task has no workspace owner, so no connected account can be used for it.",
};

/* ---------------- Per-workspace credentialed transports ---------------- */

type JsonResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      outcome: ExecutionOutcome;
      /**
       * HTTP status of a provider refusal, when one was received. Lets
       * executors and verifiers distinguish "provably absent" (404) or
       * "stale/conflicting" (409/422) from transport-level uncertainty.
       */
      status?: number;
    };

/** Map a thrown credential-resolution error to an outcome. */
function credentialFailure(
  error: unknown,
): { ok: false; outcome: ExecutionOutcome } | null {
  if (error instanceof GoogleAuthError || error instanceof GithubAuthError) {
    return {
      ok: false,
      outcome: {
        ok: false,
        kind: error.kind === "unavailable" ? "failed" : "auth",
        message: error.message,
      },
    };
  }
  return null;
}

/**
 * Perform one authenticated JSON round-trip against a provider API as the
 * owning workspace's own account. The credential is resolved fresh on
 * every call, so a disconnect or revocation blocks the very next operation.
 */
async function providerJson(input: {
  workspaceId: string | null;
  providerLabel: string;
  baseUrl: string;
  resolveToken: (workspaceId: string) => Promise<string>;
  path: string;
  options?: { method?: string; body?: unknown; headers?: Record<string, string> };
  extraHeaders?: Record<string, string>;
  /** When set, a non-JSON body is sent verbatim with these headers. */
  rawBody?: boolean;
  /**
   * Provider-specific refusal mapping (given the status and response
   * headers, never the credential). Return null to fall back to the
   * generic mapping.
   */
  mapFailure?: (refusal: {
    status: number;
    headers: Headers;
    bodyText: string;
  }) => ExecutionOutcome | null;
}): Promise<JsonResult> {
  const { workspaceId, path, options } = input;
  if (!workspaceId) return { ok: false, outcome: NO_WORKSPACE_OUTCOME };
  let token: string;
  try {
    token = await input.resolveToken(workspaceId);
  } catch (error) {
    const failure = credentialFailure(error);
    if (failure) return failure;
    throw error;
  }
  const hasBody = options?.body !== undefined;
  const raw = input.rawBody === true;
  let response: Response;
  try {
    response = await fetch(`${input.baseUrl}${path}`, {
      method: options?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(input.extraHeaders ?? {}),
        ...(hasBody && !raw ? { "Content-Type": "application/json" } : {}),
        ...(options?.headers ?? {}),
      },
      ...(hasBody
        ? { body: raw ? String(options!.body) : JSON.stringify(options!.body) }
        : {}),
    });
  } catch (error) {
    return {
      ok: false,
      outcome: {
        ok: false,
        kind: "failed",
        message: `Could not reach ${input.providerLabel}: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      outcome:
        input.mapFailure?.({
          status: response.status,
          headers: response.headers,
          bodyText: text,
        }) ?? mapProxyFailure(response.status, text),
      status: response.status,
    };
  }
  if (!text) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: true, data: text };
  }
}

/** Call the Gmail API as the workspace's own Google account. */
async function gmailJson(
  workspaceId: string | null,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<JsonResult> {
  return providerJson({
    workspaceId,
    providerLabel: "Gmail",
    baseUrl: "https://gmail.googleapis.com",
    resolveToken: async (id) => (await gmailAccessToken(id)).token,
    path,
    options,
  });
}

/**
 * Call the Drive API as the workspace's own Google account (Drive scopes).
 * Media uploads pass their body verbatim with an explicit content type.
 */
async function driveJson(
  workspaceId: string | null,
  path: string,
  options?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<JsonResult> {
  return providerJson({
    workspaceId,
    providerLabel: "Google Drive",
    baseUrl: "https://www.googleapis.com",
    resolveToken: async (id) => (await driveAccessToken(id)).token,
    path,
    options,
    rawBody: typeof options?.body === "string",
  });
}

/**
 * Call the GitHub REST API as the workspace's own GitHub access — the
 * GitHub App installation when one is bound, the legacy OAuth token
 * otherwise. GitHub refusals are classified precisely (revoked token vs.
 * missing scope vs. repository/organization permission vs. rate limit vs.
 * outage) instead of collapsing every 401/403 into "expired", and every
 * refusal leaves a structured, secret-free log line carrying the
 * workspace/action correlation ids plus GitHub's own request id.
 *
 * Installation tokens are short-lived by design, so a 401 on one is
 * retried EXACTLY ONCE with a freshly minted token: a 401 means GitHub
 * refused the request before doing any work, so the retry can never
 * duplicate a write, and a second 401 is reported truthfully instead of
 * looping. OAuth tokens are static — a 401 there is never retried.
 */
async function githubJson(
  ctx: Pick<ExecutionContext, "workspaceId"> & { actionId?: string | null },
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<JsonResult> {
  const workspaceId = ctx.workspaceId;
  if (!workspaceId) return { ok: false, outcome: NO_WORKSPACE_OUTCOME };

  const resolveAuth = async (): Promise<
    | { ok: true; token: string; source: "installation" | "oauth" }
    | { ok: false; failure: { ok: false; outcome: ExecutionOutcome } }
  > => {
    try {
      const auth = await githubAuth(workspaceId);
      return { ok: true, token: auth.token, source: auth.source };
    } catch (error) {
      const failure = credentialFailure(error);
      if (failure) return { ok: false, failure };
      throw error;
    }
  };

  const attempt = (token: string, source: "installation" | "oauth") =>
    providerJson({
      workspaceId,
      providerLabel: "GitHub",
      baseUrl: "https://api.github.com",
      resolveToken: async () => token,
      path,
      options,
      extraHeaders: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      mapFailure: ({ status, headers, bodyText }) => {
        const refusal = classifyGithubRefusal(status, headers);
        const level =
          refusal.failureClass === "invalid_token" ||
          refusal.failureClass === "missing_scope"
            ? "warn"
            : "info";
        // Correlation trail only: ids, status, class — never tokens,
        // request paths (repository names), or provider response bodies.
        logger[level](
          {
            component: "github_api",
            workspaceId,
            actionId: ctx.actionId ?? null,
            providerStatus: status,
            failureClass: refusal.failureClass,
            authMethod: source,
            githubRequestId: refusal.requestId,
          },
          "GitHub refused an API call",
        );
        const described = describeGithubRefusal(refusal, status, source);
        if (!described) return null;
        // The described message intentionally omits the raw response body.
        void bodyText;
        return { ok: false, ...described };
      },
    });

  const auth = await resolveAuth();
  if (!auth.ok) return auth.failure;
  const first = await attempt(auth.token, auth.source);
  if (
    first.ok ||
    first.status !== 401 ||
    auth.source !== "installation"
  ) {
    return first;
  }
  // The installation token aged out mid-flight (or was invalidated at
  // GitHub). Refresh once and retry once — never more.
  invalidateGithubInstallationToken(workspaceId);
  const refreshed = await resolveAuth();
  if (!refreshed.ok) return refreshed.failure;
  if (refreshed.source !== "installation") {
    // The installation vanished between attempts; report the original
    // refusal rather than silently switching identities mid-action.
    return first;
  }
  return attempt(refreshed.token, refreshed.source);
}

/* ------------------------------ Gmail ---------------------------------- */

/**
 * Deterministic RFC-822 Message-ID for an action row. Gmail preserves a
 * caller-supplied Message-ID on send, and `rfc822msgid:` search finds it
 * exactly — which turns "did that email actually go out?" into a lookup.
 */
function gmailMessageId(actionId: string): string {
  return `homardclaw-action-${actionId}@agents.homardclaw`;
}

/**
 * Build the raw message for a draft/send operation. The optional bodyHtml
 * param is sanitized (allowlisted tags, http/https/mailto links only) and
 * attached as a multipart/alternative HTML part with the plain-text body as
 * fallback. If sanitization leaves nothing renderable, the message falls
 * back to plain text only.
 */
function gmailRaw(
  params: Record<string, unknown>,
  messageId?: string,
): { raw: string; htmlIncluded: boolean } {
  const html =
    typeof params.bodyHtml === "string" && params.bodyHtml.trim() !== ""
      ? sanitizeEmailHtml(params.bodyHtml)
      : null;
  return {
    raw: buildRfc822({
      to: String(params.to),
      subject: String(params.subject),
      text: String(params.body),
      html,
      messageId,
    }),
    htmlIncluded: html !== null,
  };
}

type GmailHeaders = { name?: string; value?: string }[];

function headerValue(headers: GmailHeaders | undefined, name: string): string {
  return (
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

async function gmailSearch(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const query = encodeURIComponent(String(params.query));
  const listed = await gmailJson(
    ctx.workspaceId,
    `/gmail/v1/users/me/messages?q=${query}&maxResults=5`,
  );
  if (!listed.ok) return listed.outcome;
  const messages =
    ((listed.data as { messages?: { id: string }[] } | null)?.messages ?? []);
  if (messages.length === 0) {
    return { ok: true, summary: "No messages matched the search." };
  }
  const lines: string[] = [];
  for (const message of messages.slice(0, 5)) {
    const detail = await gmailJson(
      ctx.workspaceId,
      `/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    );
    if (!detail.ok) return detail.outcome;
    const data = detail.data as {
      threadId?: string;
      snippet?: string;
      payload?: { headers?: GmailHeaders };
    };
    lines.push(
      `- threadId ${data.threadId ?? "?"} | From: ${headerValue(data.payload?.headers, "From")} | Date: ${headerValue(data.payload?.headers, "Date")} | Subject: ${headerValue(data.payload?.headers, "Subject")} | ${data.snippet ?? ""}`,
    );
  }
  return { ok: true, summary: truncate(lines.join("\n")) };
}

function collectPlainText(part: {
  mimeType?: string;
  body?: { data?: string };
  parts?: unknown[];
}): string {
  let text = "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    try {
      text += Buffer.from(part.body.data, "base64url").toString("utf8");
    } catch {
      /* unreadable part; skip */
    }
  }
  for (const child of part.parts ?? []) {
    text += collectPlainText(child as typeof part);
  }
  return text;
}

async function gmailReadThread(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const threadId = encodeURIComponent(String(params.threadId));
  const result = await gmailJson(
    ctx.workspaceId,
    `/gmail/v1/users/me/threads/${threadId}?format=full`,
  );
  if (!result.ok) return result.outcome;
  const thread = result.data as {
    messages?: { payload?: { headers?: GmailHeaders; mimeType?: string; body?: { data?: string }; parts?: unknown[] } }[];
  };
  const sections = (thread.messages ?? []).map((message) => {
    const headers = message.payload?.headers;
    const body = message.payload ? collectPlainText(message.payload) : "";
    return `From: ${headerValue(headers, "From")}\nDate: ${headerValue(headers, "Date")}\nSubject: ${headerValue(headers, "Subject")}\n${body.trim()}`;
  });
  return {
    ok: true,
    summary: truncate(sections.join("\n---\n") || "The thread is empty."),
  };
}

async function gmailCreateDraft(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const { raw, htmlIncluded } = gmailRaw(params);
  const result = await gmailJson(ctx.workspaceId, "/gmail/v1/users/me/drafts", {
    method: "POST",
    body: {
      message: { raw },
    },
  });
  if (!result.ok) return result.outcome;
  const draft = result.data as { id?: string } | null;
  return {
    ok: true,
    summary: `Draft created (id ${draft?.id ?? "unknown"}) to ${params.to}: "${params.subject}"${htmlIncluded ? " with a formatted (HTML) version and plain-text fallback" : ""}. It has NOT been sent.`,
  };
}

async function gmailSendEmail(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const { raw, htmlIncluded } = gmailRaw(
    params,
    ctx.actionId ? gmailMessageId(ctx.actionId) : undefined,
  );
  const result = await gmailJson(
    ctx.workspaceId,
    "/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      body: { raw },
    },
  );
  if (!result.ok) return result.outcome;
  const message = result.data as { id?: string } | null;
  return {
    ok: true,
    summary: `Email sent (id ${message?.id ?? "unknown"}) to ${params.to}: "${params.subject}"${htmlIncluded ? " with a formatted (HTML) version and plain-text fallback" : ""}.`,
  };
}

/* --------------------------- Google Drive ------------------------------ */

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveSearch(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const term = escapeDriveQuery(String(params.query));
  const q = encodeURIComponent(
    `(name contains '${term}' or fullText contains '${term}') and trashed = false`,
  );
  const result = await driveJson(
    ctx.workspaceId,
    `/drive/v3/files?q=${q}&pageSize=10&fields=${encodeURIComponent("files(id,name,mimeType,modifiedTime)")}`,
  );
  if (!result.ok) return result.outcome;
  const files =
    (result.data as { files?: { id: string; name: string; mimeType: string; modifiedTime?: string }[] } | null)
      ?.files ?? [];
  if (files.length === 0) return { ok: true, summary: "No files matched." };
  return {
    ok: true,
    summary: truncate(
      files
        .map((f) => `- fileId ${f.id} | ${f.name} | ${f.mimeType} | modified ${f.modifiedTime ?? "?"}`)
        .join("\n"),
    ),
  };
}

/** Google-native docs must be exported; everything else downloads as-is. */
const DRIVE_EXPORTABLE_PREFIX = "application/vnd.google-apps.";

/** Google Sheets reject a text/plain export; CSV keeps rows readable. */
const DRIVE_SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";

/**
 * Pick the Drive export format a Google-native file actually supports.
 * Sheets only export to tabular formats (CSV keeps rows as readable text);
 * Docs and other Google-native types keep the plain-text export.
 */
function driveExportMime(mime: string): string {
  return mime === DRIVE_SPREADSHEET_MIME ? "text/csv" : "text/plain";
}

async function driveReadFile(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const fileId = encodeURIComponent(String(params.fileId));
  const meta = await driveJson(
    ctx.workspaceId,
    `/drive/v3/files/${fileId}?fields=${encodeURIComponent("id,name,mimeType")}`,
  );
  if (!meta.ok) return meta.outcome;
  const file = meta.data as { name?: string; mimeType?: string };
  const mime = file.mimeType ?? "";
  const path = mime.startsWith(DRIVE_EXPORTABLE_PREFIX)
    ? `/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(driveExportMime(mime))}`
    : `/drive/v3/files/${fileId}?alt=media`;
  const content = await driveJson(ctx.workspaceId, path);
  if (!content.ok) return content.outcome;
  const text =
    typeof content.data === "string"
      ? content.data
      : JSON.stringify(content.data);
  return {
    ok: true,
    summary: truncate(`"${file.name ?? params.fileId}" (${mime}):\n${text}`),
  };
}

/** Drive appProperties key carrying the creating action's row id. */
const DRIVE_ACTION_KEY = "homardclawActionId";

async function driveCreateFile(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const created = await driveJson(ctx.workspaceId, "/drive/v3/files", {
    method: "POST",
    body: {
      name: String(params.name),
      mimeType: "text/plain",
      // The action id rides along as an app property so a crashed run can
      // later ask Drive "does a file created by action X exist?" exactly.
      ...(ctx.actionId
        ? { appProperties: { [DRIVE_ACTION_KEY]: ctx.actionId } }
        : {}),
    },
  });
  if (!created.ok) return created.outcome;
  const file = created.data as { id?: string } | null;
  if (!file?.id) {
    return { ok: false, kind: "failed", message: "Drive did not return a file id." };
  }
  const uploaded = await driveJson(
    ctx.workspaceId,
    `/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media`,
    {
      method: "PATCH",
      body: String(params.content),
      headers: { "Content-Type": "text/plain; charset=UTF-8" },
    },
  );
  if (!uploaded.ok) return uploaded.outcome;
  return {
    ok: true,
    summary: `Created Drive file "${params.name}" (fileId ${file.id}).`,
  };
}

/* ---------------------------- Google Sheets ----------------------------- */

/**
 * Call the Sheets API as the workspace's own Google account. Sheets rides
 * on the SAME Drive consent — deliberately no new scope is ever requested:
 * drive.readonly covers reading any spreadsheet the account can see, and
 * drive.file limits every edit to spreadsheets HomardClaw itself created
 * (or was explicitly handed). The account-wide "spreadsheets" edit scope
 * is never asked for, so no tool here can touch data the owner did not
 * make available to this app.
 */
async function sheetsJson(
  workspaceId: string | null,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<JsonResult> {
  return providerJson({
    workspaceId,
    providerLabel: "Google Sheets",
    baseUrl: "https://sheets.googleapis.com",
    resolveToken: async (id) => (await driveAccessToken(id)).token,
    path,
    options,
  });
}

/** The stable link for a spreadsheet id. */
function spreadsheetLink(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

/**
 * Translate the drive.file denial into something actionable. A 403 on a
 * Sheets mutation almost always means "this spreadsheet was never made
 * available to HomardClaw" — reconnecting would not change that, so it
 * must not surface as an auth problem the owner tries to fix by
 * reconnecting. (Missing scopes are caught before any call is made.)
 */
function explainSheetsEditDenied(outcome: ExecutionOutcome): ExecutionOutcome {
  if (
    outcome.ok ||
    outcome.kind !== "auth" ||
    !outcome.message.includes("HTTP 403") ||
    /insufficient|scope/i.test(outcome.message)
  ) {
    return outcome;
  }
  return {
    ok: false,
    kind: "failed",
    message:
      "Google refused the edit (HTTP 403). HomardClaw can only edit spreadsheets it created itself — other spreadsheets in the connected account stay read-only by design. Create a new spreadsheet with google_drive.create_spreadsheet and work there instead.",
  };
}

async function driveCreateSpreadsheet(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  // One atomic Drive call creates the native spreadsheet; the action id
  // rides along as an app property exactly like create_file, so recovery
  // can ask Drive "does the spreadsheet created by action X exist?".
  const created = await driveJson(ctx.workspaceId, "/drive/v3/files", {
    method: "POST",
    body: {
      name: String(params.name),
      mimeType: DRIVE_SPREADSHEET_MIME,
      ...(ctx.actionId
        ? { appProperties: { [DRIVE_ACTION_KEY]: ctx.actionId } }
        : {}),
    },
  });
  if (!created.ok) return created.outcome;
  const file = created.data as { id?: string } | null;
  if (!file?.id) {
    return {
      ok: false,
      kind: "failed",
      message: "Drive did not return a spreadsheet id.",
    };
  }
  return {
    ok: true,
    summary: `Created Google spreadsheet "${params.name}" (spreadsheetId ${file.id}). Link: ${spreadsheetLink(file.id)}`,
  };
}

type SheetTabProperties = {
  sheetId?: number;
  title?: string;
  index?: number;
  gridProperties?: { rowCount?: number; columnCount?: number };
};

async function sheetsListTabs(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const id = String(params.spreadsheetId);
  const fields = encodeURIComponent(
    "properties.title,sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))",
  );
  const result = await sheetsJson(
    ctx.workspaceId,
    `/v4/spreadsheets/${encodeURIComponent(id)}?fields=${fields}`,
  );
  if (!result.ok) return result.outcome;
  const data = result.data as {
    properties?: { title?: string };
    sheets?: { properties?: SheetTabProperties }[];
  } | null;
  const tabs = data?.sheets ?? [];
  const lines = tabs.map((sheet) => {
    const p = sheet.properties ?? {};
    return `- tab "${p.title ?? "?"}" (sheetId ${p.sheetId ?? "?"}) | ${p.gridProperties?.rowCount ?? "?"} rows x ${p.gridProperties?.columnCount ?? "?"} columns`;
  });
  return {
    ok: true,
    summary: truncate(
      `Spreadsheet "${data?.properties?.title ?? id}" (spreadsheetId ${id}) has ${tabs.length} tab(s):\n${lines.join("\n")}`,
    ),
  };
}

async function sheetsReadRange(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const parsed = parseA1Range(String(params.range));
  if (!parsed.ok) return { ok: false, kind: "failed", message: parsed.error };
  if (parsed.range.cellCount > MAX_READ_CELLS) {
    return {
      ok: false,
      kind: "failed",
      message: `The range ${parsed.range.normalized} covers ${parsed.range.cellCount} cells; reads are limited to ${MAX_READ_CELLS}. Read a smaller range.`,
    };
  }
  const id = String(params.spreadsheetId);
  const result = await sheetsJson(
    ctx.workspaceId,
    `/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(parsed.range.normalized)}?majorDimension=ROWS`,
  );
  if (!result.ok) return result.outcome;
  const values =
    (result.data as { values?: unknown[][] } | null)?.values ?? [];
  if (values.length === 0) {
    return {
      ok: true,
      summary: `Range ${parsed.range.normalized} of spreadsheet ${id} is empty.`,
    };
  }
  const lines = values.map((row) =>
    row.map((cell) => String(cell ?? "")).join(" | "),
  );
  return {
    ok: true,
    summary: truncate(
      `Values in ${parsed.range.normalized} of spreadsheet ${id} (${values.length} row(s), cells separated by " | "):\n${lines.join("\n")}`,
    ),
  };
}

/**
 * Resolve a tab title to its sheetId, with disambiguation the agent can
 * act on: exact title first, then a unique case-insensitive match; zero or
 * several matches list the actual tabs instead of guessing.
 */
async function sheetsResolveTab(
  workspaceId: string | null,
  spreadsheetId: string,
  tabTitle: string,
): Promise<
  | { ok: true; sheetId: number; title: string }
  | { ok: false; outcome: ExecutionOutcome }
> {
  const fields = encodeURIComponent("sheets(properties(sheetId,title))");
  const result = await sheetsJson(
    workspaceId,
    `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${fields}`,
  );
  if (!result.ok) return { ok: false, outcome: result.outcome };
  const tabs = (
    (result.data as { sheets?: { properties?: SheetTabProperties }[] } | null)
      ?.sheets ?? []
  )
    .map((sheet) => sheet.properties ?? {})
    .filter(
      (p): p is { sheetId: number; title: string } =>
        typeof p.sheetId === "number" && typeof p.title === "string",
    );
  const exact = tabs.filter((p) => p.title === tabTitle);
  const relaxed =
    exact.length > 0
      ? exact
      : tabs.filter((p) => p.title.toLowerCase() === tabTitle.toLowerCase());
  if (relaxed.length === 1) {
    return { ok: true, sheetId: relaxed[0].sheetId, title: relaxed[0].title };
  }
  const listing = tabs.map((p) => `"${p.title}"`).join(", ") || "(none)";
  return {
    ok: false,
    outcome: {
      ok: false,
      kind: "failed",
      message:
        relaxed.length === 0
          ? `No tab named "${tabTitle}" exists in spreadsheet ${spreadsheetId}. Its tabs are: ${listing}.`
          : `The tab name "${tabTitle}" is ambiguous in spreadsheet ${spreadsheetId}. Its tabs are: ${listing}. Use the exact title.`,
    },
  };
}

/**
 * One spreadsheet mutation plus its action marker, in a single atomic
 * batchUpdate: Sheets applies all requests or none, so the developer
 * metadata (key = the same marker key Drive files use, value = action id)
 * exists exactly when the mutation landed. That equivalence is what makes
 * interrupted writes verifiable instead of guessable.
 */
async function sheetsBatchUpdate(
  workspaceId: string | null,
  spreadsheetId: string,
  request: Record<string, unknown>,
  actionId: string | null,
): Promise<JsonResult> {
  const requests: Record<string, unknown>[] = [request];
  if (actionId) {
    requests.push({
      createDeveloperMetadata: {
        developerMetadata: {
          metadataKey: DRIVE_ACTION_KEY,
          metadataValue: actionId,
          location: { spreadsheet: true },
          visibility: "DOCUMENT",
        },
      },
    });
  }
  const result = await sheetsJson(
    workspaceId,
    `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    { method: "POST", body: { requests } },
  );
  if (!result.ok) {
    return { ok: false, outcome: explainSheetsEditDenied(result.outcome) };
  }
  return result;
}

async function sheetsWriteRange(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const parsed = parseA1Range(String(params.range));
  if (!parsed.ok) return { ok: false, kind: "failed", message: parsed.error };
  const range = parsed.range;
  if (!range.tab) {
    return {
      ok: false,
      kind: "failed",
      message:
        "Writes need the tab in the range, e.g. Sheet1!A1:C10 — never an implicit first tab.",
    };
  }
  if (range.cellCount > MAX_MUTATION_CELLS) {
    return {
      ok: false,
      kind: "failed",
      message: `The range ${range.normalized} covers ${range.cellCount} cells; a single write is limited to ${MAX_MUTATION_CELLS}.`,
    };
  }
  const values = parseSheetValues(String(params.values), {
    maxRows: range.rowCount,
    maxCells: MAX_MUTATION_CELLS,
  });
  if (!values.ok) return { ok: false, kind: "failed", message: values.error };
  if (
    !values.rectangular ||
    values.rowCount !== range.rowCount ||
    values.columnCount !== range.columnCount
  ) {
    return {
      ok: false,
      kind: "failed",
      message: `values is ${values.rowCount} row(s) x ${values.columnCount} column(s)${values.rectangular ? "" : " (ragged)"}, but the range ${range.normalized} is ${range.rowCount} x ${range.columnCount}. They must match exactly so the approved range is exactly what changes.`,
    };
  }
  const id = String(params.spreadsheetId);
  const tab = await sheetsResolveTab(ctx.workspaceId, id, range.tab);
  if (!tab.ok) return tab.outcome;
  const result = await sheetsBatchUpdate(
    ctx.workspaceId,
    id,
    {
      updateCells: {
        range: {
          sheetId: tab.sheetId,
          startRowIndex: range.startRowIndex,
          endRowIndex: range.endRowIndex,
          startColumnIndex: range.startColumnIndex,
          endColumnIndex: range.endColumnIndex,
        },
        rows: rowsToRowData(values.rows),
        fields: "userEnteredValue",
      },
    },
    ctx.actionId,
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Wrote ${values.rowCount} row(s) x ${values.columnCount} column(s) to ${quoteTab(tab.title)}!${range.normalized.split("!").pop()} in spreadsheet ${id}, replacing whatever the range held.`,
  };
}

async function sheetsAppendRows(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const values = parseSheetValues(String(params.values), {
    maxRows: MAX_APPEND_ROWS,
    maxCells: MAX_MUTATION_CELLS,
  });
  if (!values.ok) return { ok: false, kind: "failed", message: values.error };
  const id = String(params.spreadsheetId);
  const tab = await sheetsResolveTab(
    ctx.workspaceId,
    id,
    String(params.tabTitle),
  );
  if (!tab.ok) return tab.outcome;
  const result = await sheetsBatchUpdate(
    ctx.workspaceId,
    id,
    {
      appendCells: {
        sheetId: tab.sheetId,
        rows: rowsToRowData(values.rows),
        fields: "userEnteredValue",
      },
    },
    ctx.actionId,
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Appended ${values.rowCount} row(s) (up to ${values.columnCount} column(s) wide) to tab "${tab.title}" of spreadsheet ${id}, after the last row with data. No existing cells were changed.`,
  };
}

async function sheetsAddTab(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const id = String(params.spreadsheetId);
  const title = String(params.tabTitle);
  const result = await sheetsBatchUpdate(
    ctx.workspaceId,
    id,
    { addSheet: { properties: { title } } },
    ctx.actionId,
  );
  if (!result.ok) return result.outcome;
  const replies =
    (result.data as {
      replies?: { addSheet?: { properties?: { sheetId?: number } } }[];
    } | null)?.replies ?? [];
  const sheetId = replies[0]?.addSheet?.properties?.sheetId;
  return {
    ok: true,
    summary: `Added tab "${title}" (sheetId ${sheetId ?? "?"}) to spreadsheet ${id}.`,
  };
}

async function sheetsRenameTab(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const id = String(params.spreadsheetId);
  const newTitle = String(params.newTitle);
  const tab = await sheetsResolveTab(
    ctx.workspaceId,
    id,
    String(params.tabTitle),
  );
  if (!tab.ok) return tab.outcome;
  const result = await sheetsBatchUpdate(
    ctx.workspaceId,
    id,
    {
      updateSheetProperties: {
        properties: { sheetId: tab.sheetId, title: newTitle },
        fields: "title",
      },
    },
    ctx.actionId,
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Renamed tab "${tab.title}" to "${newTitle}" in spreadsheet ${id}. Its data is unchanged; formulas that referenced the old name now point at "${newTitle}" automatically inside this spreadsheet, but external references may break.`,
  };
}

/* ------------------------------- GitHub -------------------------------- */

async function githubListRepos(
  _params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  // Installation tokens are not user tokens: /user/* endpoints do not
  // exist for them. The equivalent listing is /installation/repositories
  // (exactly the repositories the owner granted to the app).
  const method = ctx.workspaceId
    ? await githubAuthMethod(ctx.workspaceId)
    : null;
  const viaApp = method === "github_app";
  const result = await githubJson(
    ctx,
    viaApp
      ? "/installation/repositories?per_page=30"
      : "/user/repos?sort=pushed&per_page=30",
  );
  if (!result.ok) return result.outcome;
  const repos =
    ((viaApp
      ? (result.data as {
          repositories?: { full_name: string; private: boolean; description?: string | null }[];
        } | null)?.repositories
      : result.data) as
      | { full_name: string; private: boolean; description?: string | null }[]
      | null) ?? [];
  if (repos.length === 0) return { ok: true, summary: "No repositories accessible." };
  return {
    ok: true,
    summary: truncate(
      repos
        .map((r) => `- ${r.full_name}${r.private ? " (private)" : ""}${r.description ? `: ${r.description}` : ""}`)
        .join("\n"),
    ),
  };
}

async function githubReadFile(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const { owner, repo, path } = params;
  const ref = params.ref ? `?ref=${encodeURIComponent(String(params.ref))}` : "";
  const result = await githubJson(
    ctx,
    `/repos/${encodeURIComponent(String(owner))}/${encodeURIComponent(String(repo))}/contents/${String(path).split("/").map(encodeURIComponent).join("/")}${ref}`,
  );
  if (!result.ok) return result.outcome;
  const file = result.data as { content?: string; encoding?: string; type?: string };
  if (file.type !== "file" || !file.content) {
    return { ok: false, kind: "failed", message: "The path is not a readable file." };
  }
  const text =
    file.encoding === "base64"
      ? Buffer.from(file.content, "base64").toString("utf8")
      : file.content;
  return { ok: true, summary: truncate(text) };
}

async function githubListIssues(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const state = ["open", "closed", "all"].includes(String(params.state))
    ? String(params.state)
    : "open";
  const result = await githubJson(
    ctx,
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/issues?state=${state}&per_page=20`,
  );
  if (!result.ok) return result.outcome;
  const issues = (result.data as { number: number; title: string; state: string; pull_request?: unknown }[] | null) ?? [];
  if (issues.length === 0) return { ok: true, summary: "No issues found." };
  return {
    ok: true,
    summary: truncate(
      issues
        .map((i) => `- #${i.number} [${i.state}]${i.pull_request ? " (PR)" : ""} ${i.title}`)
        .join("\n"),
    ),
  };
}

/**
 * Idempotency marker embedded in GitHub issue/comment bodies. An HTML
 * comment never renders in the GitHub UI, but it survives in the raw body,
 * so a recovery pass can list recent items and find exactly the one this
 * action row created — or prove it never landed.
 */
function githubMarker(actionId: string): string {
  return `<!-- homardclaw-action:${actionId} -->`;
}

function withGithubMarker(body: string, actionId: string | null): string {
  if (!actionId) return body;
  const marker = githubMarker(actionId);
  return body ? `${body}\n\n${marker}` : marker;
}

async function githubCreateIssue(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const body = withGithubMarker(
    params.body ? String(params.body) : "",
    ctx.actionId,
  );
  const result = await githubJson(
    ctx,
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/issues`,
    {
      method: "POST",
      body: {
        title: String(params.title),
        ...(body ? { body } : {}),
      },
    },
  );
  if (!result.ok) return result.outcome;
  const issue = result.data as { number?: number; html_url?: string } | null;
  return {
    ok: true,
    summary: `Opened issue #${issue?.number ?? "?"} in ${params.owner}/${params.repo}: ${issue?.html_url ?? ""}`,
  };
}

async function githubCommentOnIssue(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const issueNumber = Math.trunc(Number(params.issueNumber));
  const result = await githubJson(
    ctx,
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      body: { body: withGithubMarker(String(params.body), ctx.actionId) },
    },
  );
  if (!result.ok) return result.outcome;
  const comment = result.data as { html_url?: string } | null;
  return {
    ok: true,
    summary: `Commented on ${params.owner}/${params.repo}#${issueNumber}: ${comment?.html_url ?? ""}`,
  };
}

/* ------------------- GitHub code workflows (bounded) ------------------- */

/**
 * Validate a git ref name (branch, tag, or commit SHA) destined for a fixed
 * GitHub route. Rejects anything git itself forbids plus everything that
 * could change the meaning of a URL or ref path ("..", "@{", leading "-").
 * Returns the raw ref; callers encode per segment when building paths.
 */
function safeGitRef(value: unknown): string | null {
  const ref = String(value ?? "");
  if (
    !ref ||
    ref.length > 200 ||
    /[\s~^:?*[\]\\]/.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    ref.startsWith("refs/")
  ) {
    return null;
  }
  return ref;
}

/** Encode a ref for use as URL path segments, keeping its "/" structure. */
function encodeRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/**
 * Validate and encode a repository file path. Rejects absolute paths and
 * any "", "." or ".." segment, so a validated path can only name a file
 * inside the repository tree — never traverse the API route.
 */
function safeRepoFilePath(value: unknown): string | null {
  const path = String(value ?? "");
  if (!path || path.length > 500 || path.startsWith("/") || path.endsWith("/")) {
    return null;
  }
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments.map(encodeURIComponent).join("/");
}

/** A pull-request/issue number must be an explicit positive integer. */
function positiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return n;
}

/** A full git object SHA (40-hex SHA-1 or 64-hex SHA-256), nothing looser. */
function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value) || /^[0-9a-f]{64}$/i.test(value);
}

function badParam(message: string): ExecutionOutcome {
  return { ok: false, kind: "failed", message };
}

async function githubListBranches(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const result = await githubJson(
    ctx,
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/branches?per_page=100`,
  );
  if (!result.ok) return result.outcome;
  const branches =
    (result.data as
      | { name: string; commit?: { sha?: string }; protected?: boolean }[]
      | null) ?? [];
  if (branches.length === 0) {
    return { ok: true, summary: "The repository has no branches." };
  }
  return {
    ok: true,
    summary: truncate(
      branches
        .map(
          (b) =>
            `- ${b.name} @ ${b.commit?.sha ?? "?"}${b.protected ? " (protected)" : ""}`,
        )
        .join("\n"),
    ),
  };
}

async function githubListDirectory(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const rawPath = params.path ? String(params.path) : "";
  let encodedPath = "";
  if (rawPath) {
    const encoded = safeRepoFilePath(rawPath);
    if (encoded === null) {
      return badParam(
        "The path is not a valid repository path (no leading/trailing slash, no empty, '.' or '..' segments).",
      );
    }
    encodedPath = encoded;
  }
  let query = "";
  if (params.ref) {
    const ref = safeGitRef(params.ref);
    if (ref === null) return badParam("The ref is not a valid git ref name.");
    query = `?ref=${encodeURIComponent(ref)}`;
  }
  const result = await githubJson(
    ctx,
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/contents/${encodedPath}${query}`,
  );
  if (!result.ok) return result.outcome;
  const entries = result.data;
  if (!Array.isArray(entries)) {
    return badParam(
      "The path is a file, not a directory. Use github.read_file to read it.",
    );
  }
  if (entries.length === 0) return { ok: true, summary: "The directory is empty." };
  const listing = (
    entries as { type?: string; name?: string; sha?: string; size?: number }[]
  )
    .map((entry) =>
      entry.type === "dir"
        ? `- [dir] ${entry.name}`
        : `- [${entry.type ?? "file"}] ${entry.name} (${entry.size ?? 0} bytes, blob ${entry.sha ?? "?"})`,
    )
    .join("\n");
  return { ok: true, summary: truncate(listing) };
}

/** One-line, provider-grounded description of a PR's merge state. */
function describePullRequest(pr: {
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  merge_commit_sha?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string; sha?: string };
  html_url?: string;
}): string {
  const lines = [
    `PR #${pr.number ?? "?"}: "${pr.title ?? ""}" [${pr.state ?? "?"}${pr.draft ? ", draft" : ""}]`,
    `merged: ${pr.merged ? `yes (merge commit ${pr.merge_commit_sha ?? "?"})` : "no"}`,
    `mergeable: ${pr.mergeable === null || pr.mergeable === undefined ? "unknown (GitHub is still computing)" : pr.mergeable ? "yes" : "NO (conflicts or blocked)"}${pr.mergeable_state ? ` (state: ${pr.mergeable_state})` : ""}`,
    `head: ${pr.head?.ref ?? "?"} @ ${pr.head?.sha ?? "?"}`,
    `base: ${pr.base?.ref ?? "?"} @ ${pr.base?.sha ?? "?"}`,
    pr.html_url ?? "",
  ];
  return lines.filter(Boolean).join("\n");
}

async function githubGetPullRequest(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const pullNumber = positiveInt(params.pullNumber);
  if (pullNumber === null) {
    return badParam("pullNumber must be a positive integer.");
  }
  const result = await githubJson(
    ctx,
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/pulls/${pullNumber}`,
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: truncate(
      describePullRequest(result.data as Parameters<typeof describePullRequest>[0]),
    ),
  };
}

async function githubCreateBranch(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const branch = safeGitRef(params.branch);
  if (branch === null) {
    return badParam("The new branch name is not a valid git ref name.");
  }
  const fromRef = safeGitRef(params.fromRef);
  if (fromRef === null) {
    return badParam("fromRef is not a valid branch, tag, or commit SHA.");
  }
  const repoPath = `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}`;
  // Resolve the explicit source ref to an exact commit first: the branch is
  // always created at a SHA the owner can audit, never at a moving target
  // interpreted server-side.
  const resolved = await githubJson(
    ctx,
    `${repoPath}/commits/${encodeRefPath(fromRef)}`,
  );
  if (!resolved.ok) {
    if (resolved.status === 404 || resolved.status === 422) {
      return badParam(
        `The source ref "${fromRef}" was not found in ${params.owner}/${params.repo}. No branch was created.`,
      );
    }
    return resolved.outcome;
  }
  const sha = (resolved.data as { sha?: string } | null)?.sha;
  if (!sha) {
    return badParam(
      `GitHub did not return a commit for "${fromRef}". No branch was created.`,
    );
  }
  const created = await githubJson(ctx, `${repoPath}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha },
  });
  if (!created.ok) {
    if (created.status === 422) {
      return badParam(
        `GitHub refused to create branch "${branch}" (it likely already exists). Nothing was changed. ${failureMessage(created.outcome)}`,
      );
    }
    return created.outcome;
  }
  return {
    ok: true,
    summary: `Created branch "${branch}" at ${sha} (from ${fromRef}) in ${params.owner}/${params.repo}.`,
  };
}

async function githubPutFile(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const branch = safeGitRef(params.branch);
  if (branch === null) return badParam("The branch is not a valid git ref name.");
  const encodedPath = safeRepoFilePath(params.path);
  if (encodedPath === null) {
    return badParam(
      "The file path is not a valid repository path (no leading/trailing slash, no empty, '.' or '..' segments).",
    );
  }
  const expectedSha = params.expectedSha ? String(params.expectedSha) : null;
  if (expectedSha !== null && !isFullSha(expectedSha)) {
    return badParam(
      "expectedSha must be the file's full blob SHA (from github.list_directory).",
    );
  }
  // The commit message carries the action marker: recovery can later list
  // the branch's commits and prove whether exactly this commit landed.
  const message = withGithubMarker(String(params.message), ctx.actionId);
  const result = await githubJson(
    ctx,
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/contents/${encodedPath}`,
    {
      method: "PUT",
      body: {
        message,
        content: Buffer.from(String(params.content), "utf8").toString("base64"),
        branch,
        ...(expectedSha ? { sha: expectedSha } : {}),
      },
    },
  );
  if (!result.ok) {
    if (result.status === 409 || result.status === 422) {
      return badParam(
        `GitHub refused the commit to ${params.path} on "${branch}" — nothing was written. The file likely changed since it was read (stale expectedSha), expectedSha was omitted for a file that already exists, or the branch does not exist. Re-read the current file state and try again. ${failureMessage(result.outcome)}`,
      );
    }
    return result.outcome;
  }
  const data = result.data as {
    commit?: { sha?: string };
    content?: { sha?: string };
  } | null;
  return {
    ok: true,
    summary: `Committed ${params.path} to ${params.owner}/${params.repo} on branch "${branch}" (commit ${data?.commit?.sha ?? "?"}, file blob ${data?.content?.sha ?? "?"}).`,
  };
}

async function githubOpenPullRequest(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const head = safeGitRef(params.head);
  if (head === null) return badParam("head is not a valid branch name.");
  const base = safeGitRef(params.base);
  if (base === null) return badParam("base is not a valid branch name.");
  // The PR body carries the hidden action marker (same scheme as issues):
  // it never renders, but recovery can find exactly this pull request.
  const body = withGithubMarker(
    params.body ? String(params.body) : "",
    ctx.actionId,
  );
  const result = await githubJson(
    ctx,
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/pulls`,
    {
      method: "POST",
      body: {
        title: String(params.title),
        head,
        base,
        ...(body ? { body } : {}),
      },
    },
  );
  if (!result.ok) {
    if (result.status === 422) {
      return badParam(
        `GitHub refused to open the pull request "${head}" into "${base}" — nothing was opened. A pull request for these branches may already exist, the branches may have no differences, or one of them does not exist. ${failureMessage(result.outcome)}`,
      );
    }
    return result.outcome;
  }
  const pr = result.data as {
    number?: number;
    html_url?: string;
    head?: { sha?: string };
  } | null;
  return {
    ok: true,
    summary: `Opened pull request #${pr?.number ?? "?"} in ${params.owner}/${params.repo} ("${head}" into "${base}", head ${pr?.head?.sha ?? "?"}): ${pr?.html_url ?? ""}`,
  };
}

const MERGE_METHODS = ["merge", "squash", "rebase"] as const;

async function githubMergePullRequest(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const pullNumber = positiveInt(params.pullNumber);
  if (pullNumber === null) {
    return badParam("pullNumber must be a positive integer.");
  }
  const expectedHeadSha = String(params.expectedHeadSha ?? "");
  if (!isFullSha(expectedHeadSha)) {
    return badParam(
      "expectedHeadSha must be the pull request's full head commit SHA (from github.get_pull_request).",
    );
  }
  const method = params.method ? String(params.method) : "merge";
  if (!(MERGE_METHODS as readonly string[]).includes(method)) {
    return badParam("method must be one of: merge, squash, rebase.");
  }
  const result = await githubJson(
    ctx,
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/pulls/${pullNumber}/merge`,
    {
      method: "PUT",
      // GitHub only merges when the head still equals this SHA (409
      // otherwise), so the owner approves exactly the code that merges.
      body: { sha: expectedHeadSha, merge_method: method },
    },
  );
  if (!result.ok) {
    if (result.status === 409) {
      return badParam(
        `The merge was refused because the head branch moved: pull request #${pullNumber} no longer points at ${expectedHeadSha}. Nothing was merged. Re-inspect it with github.get_pull_request and request the merge again with the current head SHA.`,
      );
    }
    if (result.status === 405) {
      return badParam(
        `GitHub refused to merge pull request #${pullNumber} — nothing was merged. Branch protection, required reviews or checks, merge conflicts, a draft state, or a disallowed merge method can all cause this. ${failureMessage(result.outcome)}`,
      );
    }
    return result.outcome;
  }
  const merge = result.data as { merged?: boolean; sha?: string } | null;
  if (!merge?.merged) {
    return badParam(
      `GitHub did not confirm the merge of pull request #${pullNumber}. Inspect it with github.get_pull_request before retrying.`,
    );
  }
  return {
    ok: true,
    summary: `Merged pull request ${params.owner}/${params.repo}#${pullNumber} (${method}; merge commit ${merge.sha ?? "?"}).`,
  };
}

const EXECUTORS: Record<
  string,
  (
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<ExecutionOutcome>
> = {
  "gmail.search": gmailSearch,
  "gmail.read_thread": gmailReadThread,
  "gmail.create_draft": gmailCreateDraft,
  "gmail.send_email": gmailSendEmail,
  "google_drive.search": driveSearch,
  "google_drive.read_file": driveReadFile,
  "google_drive.create_file": driveCreateFile,
  "google_drive.create_spreadsheet": driveCreateSpreadsheet,
  "google_drive.list_sheet_tabs": sheetsListTabs,
  "google_drive.read_sheet_range": sheetsReadRange,
  "google_drive.write_sheet_range": sheetsWriteRange,
  "google_drive.append_sheet_rows": sheetsAppendRows,
  "google_drive.add_sheet_tab": sheetsAddTab,
  "google_drive.rename_sheet_tab": sheetsRenameTab,
  "github.list_repos": githubListRepos,
  "github.read_file": githubReadFile,
  "github.list_issues": githubListIssues,
  "github.list_branches": githubListBranches,
  "github.list_directory": githubListDirectory,
  "github.get_pull_request": githubGetPullRequest,
  "github.create_issue": githubCreateIssue,
  "github.comment_on_issue": githubCommentOnIssue,
  "github.create_branch": githubCreateBranch,
  "github.put_file": githubPutFile,
  "github.open_pull_request": githubOpenPullRequest,
  "github.merge_pull_request": githubMergePullRequest,
};

/**
 * Run one validated, authorized operation against its connector. Pass the
 * action row id whenever one exists: write executors derive an idempotency
 * marker from it, which is what makes crash recovery verifiable.
 */
export async function executeOperation(
  op: AppOperation,
  params: Record<string, unknown>,
  ctx: ExecutionContext = { actionId: null, workspaceId: null },
): Promise<ExecutionOutcome> {
  const executor = EXECUTORS[op.name];
  if (!executor) {
    return { ok: false, kind: "failed", message: `No executor for ${op.name}.` };
  }
  try {
    return await executor(params, ctx);
  } catch (error) {
    return {
      ok: false,
      kind: "failed",
      message: error instanceof Error ? error.message : "Unexpected app error",
    };
  }
}

/* --------------------- Crash-recovery verification ---------------------- */

/**
 * The answer to "did that interrupted write actually happen?", obtained by
 * reading the provider — never by guessing.
 *
 * - "executed": the write provably landed; settle the row as done.
 * - "not_executed": the provider provably has no trace; a retry is safe.
 * - "unknown": the read itself failed or could not be conclusive; the row
 *   must be settled as unknown-outcome, exactly as before this existed.
 */
export type VerificationResult =
  | { kind: "executed"; summary: string }
  | { kind: "not_executed" }
  | { kind: "unknown"; message: string };

/** Message of a failed outcome (verifier reads only ever fail this way). */
function failureMessage(outcome: ExecutionOutcome): string {
  return outcome.ok ? "Unexpected verifier state" : outcome.message;
}

async function verifyGmailSend(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  // rfc822msgid: is an exact-match lookup on the Message-ID the send call
  // embedded, so this cannot false-positive on a similar email. The lookup
  // runs against the OWNING workspace's mailbox — the same account the
  // interrupted send used — never any other user's.
  const q = encodeURIComponent(`rfc822msgid:${gmailMessageId(actionId)}`);
  const result = await gmailJson(
    workspaceId,
    `/gmail/v1/users/me/messages?q=${q}&maxResults=1&includeSpamTrash=true`,
  );
  if (!result.ok) {
    return { kind: "unknown", message: failureMessage(result.outcome) };
  }
  const messages =
    (result.data as { messages?: { id: string }[] } | null)?.messages ?? [];
  if (messages.length === 0) return { kind: "not_executed" };
  return {
    kind: "executed",
    summary: `Email sent (id ${messages[0].id}) to ${params.to}: "${params.subject}". Confirmed in the mailbox after an interrupted run.`,
  };
}

async function verifyGithubCreateIssue(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const result = await githubJson(
    { workspaceId, actionId },
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/issues?state=all&sort=created&direction=desc&per_page=100`,
  );
  if (!result.ok) {
    return { kind: "unknown", message: failureMessage(result.outcome) };
  }
  const issues =
    (result.data as
      | { number: number; html_url?: string; body?: string | null }[]
      | null) ?? [];
  const marker = githubMarker(actionId);
  const match = issues.find((issue) => issue.body?.includes(marker));
  if (match) {
    return {
      kind: "executed",
      summary: `Opened issue #${match.number} in ${params.owner}/${params.repo}: ${match.html_url ?? ""} (confirmed after an interrupted run)`,
    };
  }
  // A full first page means older issues were not scanned; the marker could
  // hide beyond it, so absence here is not proof of absence.
  if (issues.length >= 100) {
    return {
      kind: "unknown",
      message:
        "Too many recent issues to conclusively verify whether the interrupted creation landed.",
    };
  }
  return { kind: "not_executed" };
}

async function verifyGithubComment(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const issueNumber = Math.trunc(Number(params.issueNumber));
  const result = await githubJson(
    { workspaceId, actionId },
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/issues/${issueNumber}/comments?per_page=100`,
  );
  if (!result.ok) {
    return { kind: "unknown", message: failureMessage(result.outcome) };
  }
  const comments =
    (result.data as { html_url?: string; body?: string | null }[] | null) ?? [];
  const marker = githubMarker(actionId);
  const match = comments.find((comment) => comment.body?.includes(marker));
  if (match) {
    return {
      kind: "executed",
      summary: `Commented on ${params.owner}/${params.repo}#${issueNumber}: ${match.html_url ?? ""} (confirmed after an interrupted run)`,
    };
  }
  if (comments.length >= 100) {
    return {
      kind: "unknown",
      message:
        "Too many comments on the issue to conclusively verify whether the interrupted comment landed.",
    };
  }
  return { kind: "not_executed" };
}

async function verifyGithubCreateBranch(
  params: Record<string, unknown>,
  _actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const branch = safeGitRef(params.branch);
  if (branch === null) return { kind: "not_executed" };
  const result = await githubJson(
    { workspaceId, actionId: _actionId },
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/git/ref/heads/${encodeRefPath(branch)}`,
  );
  if (result.ok) {
    const sha = (result.data as { object?: { sha?: string } } | null)?.object
      ?.sha;
    return {
      kind: "executed",
      summary: `Branch "${branch}" exists in ${params.owner}/${params.repo} at ${sha ?? "?"} (confirmed after an interrupted run).`,
    };
  }
  // GitHub's ref lookup is read-after-write consistent: a 404 proves the
  // branch does not exist, so the interrupted creation never landed.
  if (result.status === 404) return { kind: "not_executed" };
  return { kind: "unknown", message: failureMessage(result.outcome) };
}

async function verifyGithubPutFile(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const branch = safeGitRef(params.branch);
  if (branch === null) return { kind: "not_executed" };
  const result = await githubJson(
    { workspaceId, actionId },
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(String(params.path))}&per_page=100`,
  );
  if (!result.ok) {
    // A 404 here is ambiguous: the branch may never have been created — or
    // repository access may have been revoked AFTER the commit landed
    // (GitHub hides inaccessible private repos behind 404). Never treat it
    // as proof of non-execution.
    return { kind: "unknown", message: failureMessage(result.outcome) };
  }
  const commits =
    (result.data as
      | { sha: string; commit?: { message?: string } }[]
      | null) ?? [];
  const marker = githubMarker(actionId);
  const match = commits.find((c) => c.commit?.message?.includes(marker));
  if (match) {
    return {
      kind: "executed",
      summary: `Committed ${params.path} to ${params.owner}/${params.repo} on branch "${branch}" (commit ${match.sha}). Confirmed by the commit's action marker after an interrupted run.`,
    };
  }
  if (commits.length >= 100) {
    return {
      kind: "unknown",
      message:
        "Too many commits touch that file to conclusively verify whether the interrupted commit landed.",
    };
  }
  return { kind: "not_executed" };
}

async function verifyGithubOpenPullRequest(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const head = safeGitRef(params.head);
  if (head === null) return { kind: "not_executed" };
  const result = await githubJson(
    { workspaceId, actionId },
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/pulls?state=all&head=${encodeURIComponent(`${String(params.owner)}:${head}`)}&per_page=100`,
  );
  if (!result.ok) {
    return { kind: "unknown", message: failureMessage(result.outcome) };
  }
  const pulls =
    (result.data as
      | { number: number; html_url?: string; body?: string | null }[]
      | null) ?? [];
  const marker = githubMarker(actionId);
  const match = pulls.find((pr) => pr.body?.includes(marker));
  if (match) {
    return {
      kind: "executed",
      summary: `Opened pull request #${match.number} in ${params.owner}/${params.repo}: ${match.html_url ?? ""} (confirmed by its hidden action marker after an interrupted run)`,
    };
  }
  if (pulls.length >= 100) {
    return {
      kind: "unknown",
      message:
        "Too many pull requests for that branch to conclusively verify whether the interrupted one was opened.",
    };
  }
  return { kind: "not_executed" };
}

async function verifyGithubMergePullRequest(
  params: Record<string, unknown>,
  _actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const pullNumber = positiveInt(params.pullNumber);
  if (pullNumber === null) return { kind: "not_executed" };
  const result = await githubJson(
    { workspaceId, actionId: _actionId },
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/pulls/${pullNumber}`,
  );
  if (!result.ok) {
    return { kind: "unknown", message: failureMessage(result.outcome) };
  }
  const pr = result.data as {
    merged?: boolean;
    merge_commit_sha?: string | null;
    state?: string;
  } | null;
  if (pr?.merged) {
    return {
      kind: "executed",
      summary: `Pull request ${params.owner}/${params.repo}#${pullNumber} is merged (merge commit ${pr.merge_commit_sha ?? "?"}). Confirmed after an interrupted run.`,
    };
  }
  // Not merged is definitive either way: an open PR can safely be retried
  // (the expectedHeadSha still gates it), and a closed-unmerged PR makes a
  // retry fail loudly instead of merging anything.
  return { kind: "not_executed" };
}

async function verifyDriveCreateFile(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const q = encodeURIComponent(
    `appProperties has { key='${DRIVE_ACTION_KEY}' and value='${actionId}' } and trashed = false`,
  );
  const result = await driveJson(
    workspaceId,
    `/drive/v3/files?q=${q}&pageSize=1&fields=${encodeURIComponent("files(id,name,size)")}`,
  );
  if (!result.ok) {
    return { kind: "unknown", message: failureMessage(result.outcome) };
  }
  const files =
    (result.data as
      | { files?: { id: string; name: string; size?: string }[] }
      | null)?.files ?? [];
  if (files.length === 0) return { kind: "not_executed" };
  const file = files[0];
  // Creation is two calls (create metadata, then upload content), so the
  // file can exist with the upload missing. The media PATCH is idempotent
  // for this exact fileId, so completing it here is safe — never a dupe.
  const content = String(params.content ?? "");
  const expectedBytes = Buffer.byteLength(content, "utf8");
  const actualBytes = Number(file.size ?? 0);
  if (expectedBytes > 0 && actualBytes !== expectedBytes) {
    const uploaded = await driveJson(
      workspaceId,
      `/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media`,
      {
        method: "PATCH",
        body: content,
        headers: { "Content-Type": "text/plain; charset=UTF-8" },
      },
    );
    if (!uploaded.ok) {
      return {
        kind: "unknown",
        message: `The file exists but its content upload was interrupted, and re-uploading failed: ${failureMessage(uploaded.outcome)}`,
      };
    }
    return {
      kind: "executed",
      summary: `Created Drive file "${file.name}" (fileId ${file.id}). An interrupted run had left it without content; the content upload was completed during recovery.`,
    };
  }
  return {
    kind: "executed",
    summary: `Created Drive file "${file.name}" (fileId ${file.id}). Confirmed complete after an interrupted run.`,
  };
}

async function verifyDriveCreateSpreadsheet(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  // Same marker, same query as create_file: the appProperties key carries
  // the action id, so Drive answers "did action X create its spreadsheet?"
  // exactly. Creation is a single call, so found = fully done.
  const q = encodeURIComponent(
    `appProperties has { key='${DRIVE_ACTION_KEY}' and value='${actionId}' } and trashed = false`,
  );
  const result = await driveJson(
    workspaceId,
    `/drive/v3/files?q=${q}&pageSize=1&fields=${encodeURIComponent("files(id,name)")}`,
  );
  if (!result.ok) {
    return { kind: "unknown", message: failureMessage(result.outcome) };
  }
  const files =
    (result.data as { files?: { id: string; name: string }[] } | null)
      ?.files ?? [];
  if (files.length === 0) return { kind: "not_executed" };
  const file = files[0];
  return {
    kind: "executed",
    summary: `Created Google spreadsheet "${file.name}" (spreadsheetId ${file.id}). Link: ${spreadsheetLink(file.id)} — confirmed after an interrupted run.`,
  };
}

/**
 * Shared verifier for the four spreadsheet mutations. Every mutation ships
 * in one atomic batchUpdate with a developer-metadata marker keyed by the
 * action id, so the marker's presence in the document IS the mutation's
 * receipt: found ⇒ it landed. Absence is weaker: the metadata search reads
 * the document, but it cannot order itself against the ORIGINAL request,
 * which may still be executing inside Google after our process died. An
 * absent marker therefore only proves non-execution once the interrupted
 * attempt is old enough that no HTTP request could still be in flight —
 * which is exactly the "eventual" grace protocol below.
 */
function verifySheetsMutation(
  describe: (params: Record<string, unknown>) => string,
): (
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
) => Promise<VerificationResult> {
  return async (params, actionId, workspaceId) => {
    const result = await sheetsJson(
      workspaceId,
      `/v4/spreadsheets/${encodeURIComponent(String(params.spreadsheetId))}/developerMetadata:search`,
      {
        method: "POST",
        body: {
          dataFilters: [
            {
              developerMetadataLookup: {
                metadataKey: DRIVE_ACTION_KEY,
                metadataValue: actionId,
              },
            },
          ],
        },
      },
    );
    if (!result.ok) {
      return { kind: "unknown", message: failureMessage(result.outcome) };
    }
    const matches =
      (result.data as { matchedDeveloperMetadata?: unknown[] } | null)
        ?.matchedDeveloperMetadata ?? [];
    if (matches.length === 0) return { kind: "not_executed" };
    return {
      kind: "executed",
      summary: `${describe(params)} Confirmed by the spreadsheet's embedded action marker after an interrupted run.`,
    };
  };
}

/**
 * How trustworthy a verifier's "absent" answer is. GitHub's REST list
 * endpoints are read-after-write consistent, so absence there is proof.
 * Gmail search and Drive queries are eventually consistent indexes: absence
 * shortly after the interrupted call proves nothing, so callers must only
 * trust "not_executed" from them once the attempt is comfortably old.
 */
export type VerifierConsistency = "strong" | "eventual";

const VERIFIERS: Record<
  string,
  {
    consistency: VerifierConsistency;
    verify: (
      params: Record<string, unknown>,
      actionId: string,
      workspaceId: string | null,
    ) => Promise<VerificationResult>;
  }
> = {
  "gmail.send_email": { consistency: "eventual", verify: verifyGmailSend },
  "github.create_issue": {
    consistency: "strong",
    verify: verifyGithubCreateIssue,
  },
  "github.comment_on_issue": {
    consistency: "strong",
    verify: verifyGithubComment,
  },
  // The code-workflow mutations are verified against GitHub's core git
  // data (refs, commit lists, pull-request state), which is read-after-
  // write consistent — absence there is proof of absence.
  "github.create_branch": {
    consistency: "strong",
    verify: verifyGithubCreateBranch,
  },
  "github.put_file": {
    consistency: "strong",
    verify: verifyGithubPutFile,
  },
  "github.open_pull_request": {
    consistency: "strong",
    verify: verifyGithubOpenPullRequest,
  },
  "github.merge_pull_request": {
    consistency: "strong",
    verify: verifyGithubMergePullRequest,
  },
  "google_drive.create_file": {
    consistency: "eventual",
    verify: verifyDriveCreateFile,
  },
  "google_drive.create_spreadsheet": {
    consistency: "eventual",
    verify: verifyDriveCreateSpreadsheet,
  },
  // Sheets mutations are "eventual" NOT because the metadata read lags —
  // it reads the document — but because absence cannot be ordered against
  // the interrupted batchUpdate itself, which may still be running inside
  // Google when recovery looks seconds after a crash. Requeueing on a
  // fresh absence could double-apply an append or tab change (metadata
  // keys are not unique), so absence only counts once the attempt is old
  // enough that the original request can no longer be in flight.
  "google_drive.write_sheet_range": {
    consistency: "eventual",
    verify: verifySheetsMutation(
      (p) =>
        `Wrote the approved values to ${p.range} in spreadsheet ${p.spreadsheetId}.`,
    ),
  },
  "google_drive.append_sheet_rows": {
    consistency: "eventual",
    verify: verifySheetsMutation(
      (p) =>
        `Appended the approved rows to tab "${p.tabTitle}" of spreadsheet ${p.spreadsheetId}.`,
    ),
  },
  "google_drive.add_sheet_tab": {
    consistency: "eventual",
    verify: verifySheetsMutation(
      (p) =>
        `Added tab "${p.tabTitle}" to spreadsheet ${p.spreadsheetId}.`,
    ),
  },
  "google_drive.rename_sheet_tab": {
    consistency: "eventual",
    verify: verifySheetsMutation(
      (p) =>
        `Renamed tab "${p.tabTitle}" to "${p.newTitle}" in spreadsheet ${p.spreadsheetId}.`,
    ),
  },
};

/** Whether an operation's outcome can be verified against the provider. */
export function hasOutcomeVerifier(operation: string): boolean {
  return operation in VERIFIERS;
}

/** The consistency class of an operation's verifier, if it has one. */
export function verifierConsistency(
  operation: string,
): VerifierConsistency | null {
  return VERIFIERS[operation]?.consistency ?? null;
}

/**
 * Ask the provider whether an interrupted write actually happened, using
 * the idempotency marker derived from the action row id. Any thrown error
 * degrades to "unknown" — a verification failure must never be mistaken
 * for "it did not run".
 */
export async function verifyOperationOutcome(
  operation: string,
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const verifier = VERIFIERS[operation];
  if (!verifier) {
    return {
      kind: "unknown",
      message: `No outcome verification exists for ${operation}.`,
    };
  }
  try {
    return await verifier.verify(params, actionId, workspaceId);
  } catch (error) {
    return {
      kind: "unknown",
      message: error instanceof Error ? error.message : "Verification failed",
    };
  }
}
