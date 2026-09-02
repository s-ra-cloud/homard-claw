import { type AppOperation, type ConnectedAppId } from "./catalog";
import {
  MAX_REPLACE_OCCURRENCES,
  buildParagraphStyleRequests,
  collectDocParagraphTexts,
  countOccurrences,
  docsTextStyle,
  flattenDocTabs,
  parseDocRange,
  parseTextStyleFlags,
  describeStyleFlags,
  summarizeDocTabs,
  type DocTab,
} from "./docs";
import { buildRfc822, sanitizeEmailHtml } from "./email-mime";
import {
  MAX_APPEND_ROWS,
  MAX_CLEAR_CELLS,
  MAX_DELETE_COLUMNS,
  MAX_DELETE_ROWS,
  MAX_MUTATION_CELLS,
  MAX_READ_CELLS,
  columnToIndex,
  parseA1Range,
  parseSheetValues,
  quoteTab,
  rowsToRowData,
} from "./sheets";
import {
  SLIDE_LAYOUTS,
  collectSlidesTexts,
  parseSlideTextRange,
  slideObjectIdForAction,
  slidesTextStyle,
  summarizePresentation,
  type SlidesSlide,
} from "./slides";
import {
  GoogleAuthError,
  driveAccessToken,
  driveOrganizeAccessToken,
  gmailAccessToken,
  googleAccountSummary,
} from "../google/credentials";
import {
  GithubAuthError,
  checkGithubConnectionHealth,
  githubAuth,
  githubAuthMethod,
  recoverPersonalGithubAppBinding,
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
    if (!account.canOrganizeDrive) {
      // Baseline Drive works (reads, app-created files) but the connection
      // predates — or declined — the broad organization scope. That is a
      // reconnect situation, deliberately distinct from "never connected":
      // the account label stays visible and reads keep working meanwhile.
      return {
        status: "expired",
        detail:
          "Drive is connected for reading and app-created files, but organizing existing files (creating folders, renaming, moving) needs full Google Drive access. Reconnect Google Drive and approve the full access request to enable it.",
        accountLabel: account.email,
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
      /**
       * True only when the refusal PROVABLY happened before the provider
       * performed any work: the credential could not be resolved at all
       * (no request was ever sent), or the provider rejected the request's
       * authorization outright (GitHub 401/missing-scope refusals reject
       * before executing anything). Such an action is safe to run again
       * once the connection recovers — no write can have landed. Never set
       * for refusals where partial execution is conceivable.
       */
      refusedBeforeExecution?: boolean;
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
    const kind = error.kind === "unavailable" ? "failed" : "auth";
    return {
      ok: false,
      outcome: {
        ok: false,
        kind,
        message: error.message,
        // The credential never resolved, so no provider request was ever
        // sent — this refusal provably preceded any execution.
        ...(kind === "auth" ? { refusedBeforeExecution: true } : {}),
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
   * When set, a successful response body is returned as verbatim text —
   * never JSON.parsed. Editing a downloaded file requires the exact bytes;
   * a parse/re-stringify round-trip would silently rewrite formatting.
   */
  rawResponse?: boolean;
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
  if (input.rawResponse) return { ok: true, data: text };
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
  options?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    rawResponse?: boolean;
  },
): Promise<JsonResult> {
  return providerJson({
    workspaceId,
    providerLabel: "Google Drive",
    baseUrl: "https://www.googleapis.com",
    resolveToken: async (id) => (await driveAccessToken(id)).token,
    path,
    options,
    rawBody: typeof options?.body === "string",
    rawResponse: options?.rawResponse === true,
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
        // GitHub "auth" refusals (revoked token 401, missing OAuth scope)
        // reject the request's authorization before performing any work —
        // safe to run again once the connection recovers.
        return {
          ok: false,
          ...described,
          ...(described.kind === "auth"
            ? { refusedBeforeExecution: true }
            : {}),
        };
      },
    });

  const auth = await resolveAuth();
  if (!auth.ok) return auth.failure;
  const first = await attempt(auth.token, auth.source);
  if (
    !first.ok &&
    first.status === 401 &&
    auth.source === "oauth" &&
    (await recoverPersonalGithubAppBinding(workspaceId)).recovered
  ) {
    // A 401 means GitHub rejected the OAuth request before performing any
    // work. If the owner's matching personal App installation was present
    // but its callback was lost, repair the binding and retry once under
    // the installation identity.
    const recovered = await resolveAuth();
    if (recovered.ok && recovered.source === "installation") {
      return attempt(recovered.token, recovered.source);
    }
  }
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
  // corpora=allDrives + the two flags make search span My Drive AND every
  // shared drive the owner can reach — without them Google silently omits
  // shared-drive items, leaving rename/move unable to discover their ids.
  const result = await driveJson(
    ctx.workspaceId,
    `/drive/v3/files?q=${q}&pageSize=10&fields=${encodeURIComponent("files(id,name,mimeType,modifiedTime,driveId)")}&corpora=allDrives&supportsAllDrives=true&includeItemsFromAllDrives=true`,
  );
  if (!result.ok) return result.outcome;
  const files =
    (result.data as { files?: { id: string; name: string; mimeType: string; modifiedTime?: string; driveId?: string }[] } | null)
      ?.files ?? [];
  if (files.length === 0) return { ok: true, summary: "No files matched." };
  return {
    ok: true,
    summary: truncate(
      files
        .map(
          (f) =>
            `- fileId ${f.id} | ${f.name} | ${f.mimeType} | modified ${f.modifiedTime ?? "?"}${f.driveId ? " | in a shared drive" : ""}`,
        )
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
  // supportsAllDrives lets reads reach shared-drive files by id too.
  const meta = await driveJson(
    ctx.workspaceId,
    `/drive/v3/files/${fileId}?fields=${encodeURIComponent("id,name,mimeType")}&supportsAllDrives=true`,
  );
  if (!meta.ok) return meta.outcome;
  const file = meta.data as { name?: string; mimeType?: string };
  const mime = file.mimeType ?? "";
  const path = mime.startsWith(DRIVE_EXPORTABLE_PREFIX)
    ? `/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(driveExportMime(mime))}`
    : `/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
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

/* ---------------- Drive organization (folders, rename, move) ------------ */

/** Drive's folder MIME type — the only valid parent/destination kind. */
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Call the Drive API with the broad organization scope. Unlike driveJson,
 * the token resolution here requires the full Drive grant, so a connection
 * that never granted it (or declined it at consent) fails closed with
 * reconnect guidance before Google is ever contacted.
 */
async function driveOrganizeJson(
  workspaceId: string | null,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<JsonResult> {
  return providerJson({
    workspaceId,
    providerLabel: "Google Drive",
    baseUrl: "https://www.googleapis.com",
    resolveToken: async (id) => (await driveOrganizeAccessToken(id)).token,
    path,
    options,
  });
}

/**
 * Translate a 403 on an organization mutation into something actionable.
 * With the full Drive scope granted, a 403 means the OWNER's account lacks
 * edit rights on that specific item (typically shared read-only by someone
 * else) — reconnecting would not change that, so it must not surface as an
 * auth problem. Genuine scope complaints keep their reconnect guidance.
 */
function explainDriveEditDenied(outcome: ExecutionOutcome): ExecutionOutcome {
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
      "Google refused the change (HTTP 403). The connected account can see this item but does not have permission to modify it — it is likely shared read-only by someone else — so it cannot be renamed or moved from here.",
  };
}

/** Fetch id, name, mimeType (and parents) for one Drive item.
 * supportsAllDrives lets organization reach shared-drive items too. */
async function driveItemMeta(
  workspaceId: string | null,
  fileId: string,
): Promise<
  | { ok: true; item: { id?: string; name?: string; mimeType?: string; parents?: string[] } }
  | { ok: false; outcome: ExecutionOutcome }
> {
  const meta = await driveOrganizeJson(
    workspaceId,
    `/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent("id,name,mimeType,parents")}&supportsAllDrives=true`,
  );
  if (!meta.ok) return { ok: false, outcome: meta.outcome };
  return {
    ok: true,
    item: meta.data as {
      id?: string;
      name?: string;
      mimeType?: string;
      parents?: string[];
    },
  };
}

async function driveCreateFolder(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const parent = params.parentFolderId ? String(params.parentFolderId) : null;
  if (parent) {
    // Validate the parent up front: creating "inside" a plain file would
    // either fail opaquely or land somewhere the owner did not approve.
    const meta = await driveItemMeta(ctx.workspaceId, parent);
    if (!meta.ok) return meta.outcome;
    if (meta.item.mimeType !== DRIVE_FOLDER_MIME) {
      return {
        ok: false,
        kind: "failed",
        message: `The parent (${meta.item.name ?? parent}) is a file, not a folder. Folders can only be created inside a folder — or at the top level when parentFolderId is omitted.`,
      };
    }
  }
  const created = await driveOrganizeJson(
    ctx.workspaceId,
    "/drive/v3/files?supportsAllDrives=true",
    {
      method: "POST",
      body: {
        name: String(params.name),
        mimeType: DRIVE_FOLDER_MIME,
        ...(parent ? { parents: [parent] } : {}),
        // Same recovery marker as create_file: a crashed run can later ask
        // Drive "does a folder created by action X exist?" exactly.
        ...(ctx.actionId
          ? { appProperties: { [DRIVE_ACTION_KEY]: ctx.actionId } }
          : {}),
      },
    },
  );
  if (!created.ok) return created.outcome;
  const folder = created.data as { id?: string } | null;
  if (!folder?.id) {
    return {
      ok: false,
      kind: "failed",
      message: "Drive did not return a folder id.",
    };
  }
  return {
    ok: true,
    summary: `Created Drive folder "${params.name}" (folderId ${folder.id})${parent ? ` inside folder ${parent}` : ""}.`,
  };
}

async function driveRenameItem(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const fileId = String(params.fileId);
  const meta = await driveItemMeta(ctx.workspaceId, fileId);
  if (!meta.ok) return meta.outcome;
  const kindWord =
    meta.item.mimeType === DRIVE_FOLDER_MIME ? "folder" : "file";
  const updated = await driveOrganizeJson(
    ctx.workspaceId,
    `/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent("id,name")}&supportsAllDrives=true`,
    {
      method: "PATCH",
      body: {
        name: String(params.newName),
        // The marker rides on the same PATCH, so its presence on the item
        // is the mutation's receipt during crash recovery.
        ...(ctx.actionId
          ? { appProperties: { [DRIVE_ACTION_KEY]: ctx.actionId } }
          : {}),
      },
    },
  );
  if (!updated.ok) return explainDriveEditDenied(updated.outcome);
  return {
    ok: true,
    summary: `Renamed Drive ${kindWord} "${meta.item.name ?? fileId}" to "${params.newName}" (fileId ${fileId}).`,
  };
}

async function driveMoveItem(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const fileId = String(params.fileId);
  const destinationId = String(params.destinationFolderId);
  if (fileId === destinationId) {
    return {
      ok: false,
      kind: "failed",
      message: "An item cannot be moved into itself.",
    };
  }
  const meta = await driveItemMeta(ctx.workspaceId, fileId);
  if (!meta.ok) return meta.outcome;
  const dest = await driveItemMeta(ctx.workspaceId, destinationId);
  if (!dest.ok) return dest.outcome;
  if (dest.item.mimeType !== DRIVE_FOLDER_MIME) {
    return {
      ok: false,
      kind: "failed",
      message: `The destination (${dest.item.name ?? destinationId}) is a file, not a folder — items can only be moved into folders (or "root" for the top level of My Drive).`,
    };
  }
  const resolvedDestId = dest.item.id ?? destinationId;
  // Replace the current parents rather than adding a second one: "move"
  // must never silently turn into "appears in two places". Items without a
  // readable parent (e.g. shared items outside My Drive) just gain one.
  const removeParents = (meta.item.parents ?? [])
    .filter((p) => p !== resolvedDestId)
    .join(",");
  const query = new URLSearchParams({
    addParents: resolvedDestId,
    fields: "id,name,parents",
    supportsAllDrives: "true",
  });
  if (removeParents) query.set("removeParents", removeParents);
  const moved = await driveOrganizeJson(
    ctx.workspaceId,
    `/drive/v3/files/${encodeURIComponent(fileId)}?${query.toString()}`,
    {
      method: "PATCH",
      body: {
        ...(ctx.actionId
          ? { appProperties: { [DRIVE_ACTION_KEY]: ctx.actionId } }
          : {}),
      },
    },
  );
  if (!moved.ok) return explainDriveEditDenied(moved.outcome);
  const kindWord =
    meta.item.mimeType === DRIVE_FOLDER_MIME ? "folder" : "file";
  return {
    ok: true,
    summary: `Moved Drive ${kindWord} "${meta.item.name ?? fileId}" into folder "${dest.item.name ?? destinationId}" (fileId ${fileId}).`,
  };
}

/* ---------------------------- Google Sheets ----------------------------- */

/**
 * Call the Sheets API as the workspace's own Google account. Sheets rides
 * on the SAME Drive consent — the account-wide "spreadsheets" edit scope is
 * never asked for. It runs on the BASELINE Drive token (not the organize
 * one) so connections that predate full Drive access keep editing the
 * spreadsheets HomardClaw created; with full Drive granted, Google extends
 * edits to any spreadsheet the owner's account can edit.
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
 * Translate a Sheets-mutation denial into something actionable. Since the
 * broad Drive scope, the owner's account can edit any spreadsheet it has
 * edit rights on — so a 403 here means either the OWNER lacks edit rights
 * on that document (shared read-only by someone else), or the connection
 * predates full Drive access and can still only edit files HomardClaw
 * created. Neither is fixed by retrying, so it must not surface as a
 * generic auth problem. (Missing scopes on the token itself are caught
 * before any call is made — but only for operations that REQUIRE the broad
 * scope; Sheets edits still run on the baseline token so old connections
 * keep working on app-created spreadsheets.)
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
      "Google refused the edit (HTTP 403). Either the connected account does not have edit rights on this spreadsheet (it may be shared read-only), or the Drive connection predates full Drive access and can only edit spreadsheets HomardClaw created — reconnecting Google Drive with full access fixes the latter.",
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
  | { ok: true; sheetId: number; title: string; tabCount: number }
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
    return {
      ok: true,
      sheetId: relaxed[0].sheetId,
      title: relaxed[0].title,
      tabCount: tabs.length,
    };
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

/* ------------- Sheets destructive edits (bounded, approved) ------------- */

async function sheetsClearRange(
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
        "Clears need the tab in the range, e.g. Sheet1!A2:D50 — never an implicit first tab.",
    };
  }
  if (range.cellCount > MAX_CLEAR_CELLS) {
    return {
      ok: false,
      kind: "failed",
      message: `The range ${range.normalized} covers ${range.cellCount} cells; a single clear is limited to ${MAX_CLEAR_CELLS}. Clear a smaller range.`,
    };
  }
  const id = String(params.spreadsheetId);
  const tab = await sheetsResolveTab(ctx.workspaceId, id, range.tab);
  if (!tab.ok) return tab.outcome;
  const result = await sheetsBatchUpdate(
    ctx.workspaceId,
    id,
    {
      // updateCells with no rows and a values-only field mask erases the
      // cell CONTENTS of exactly the approved rectangle; formatting and
      // everything outside the range stay untouched.
      updateCells: {
        range: {
          sheetId: tab.sheetId,
          startRowIndex: range.startRowIndex,
          endRowIndex: range.endRowIndex,
          startColumnIndex: range.startColumnIndex,
          endColumnIndex: range.endColumnIndex,
        },
        fields: "userEnteredValue",
      },
    },
    ctx.actionId,
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Cleared the values of ${range.normalized} (${range.cellCount} cell(s)) in spreadsheet ${id}. Formatting was left in place; recovery is possible through the spreadsheet's version history.`,
  };
}

async function sheetsDeleteRows(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const startRow = Number(params.startRow);
  const endRow = Number(params.endRow);
  if (!Number.isInteger(startRow) || !Number.isInteger(endRow) || startRow < 1) {
    return {
      ok: false,
      kind: "failed",
      message:
        "startRow and endRow must be the 1-based row numbers shown in Sheets.",
    };
  }
  if (endRow < startRow) {
    return {
      ok: false,
      kind: "failed",
      message: "endRow must be at least startRow (the rows are inclusive).",
    };
  }
  const count = endRow - startRow + 1;
  if (count > MAX_DELETE_ROWS) {
    return {
      ok: false,
      kind: "failed",
      message: `That would delete ${count} rows; a single call is limited to ${MAX_DELETE_ROWS}.`,
    };
  }
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
      deleteDimension: {
        range: {
          sheetId: tab.sheetId,
          dimension: "ROWS",
          startIndex: startRow - 1,
          endIndex: endRow,
        },
      },
    },
    ctx.actionId,
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Deleted rows ${startRow}-${endRow} (${count} row(s)) from tab "${tab.title}" of spreadsheet ${id}. Rows below shifted up; recovery is possible through the spreadsheet's version history.`,
  };
}

async function sheetsDeleteColumns(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const startLetters = String(params.startColumn).trim().toUpperCase();
  const endLetters = String(params.endColumn).trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(startLetters) || !/^[A-Z]{1,3}$/.test(endLetters)) {
    return {
      ok: false,
      kind: "failed",
      message:
        'startColumn and endColumn must be column letters like "B" or "AA".',
    };
  }
  const startIndex = columnToIndex(startLetters);
  const endIndex = columnToIndex(endLetters);
  if (endIndex < startIndex) {
    return {
      ok: false,
      kind: "failed",
      message:
        "endColumn must not be before startColumn (the columns are inclusive).",
    };
  }
  const count = endIndex - startIndex + 1;
  if (count > MAX_DELETE_COLUMNS) {
    return {
      ok: false,
      kind: "failed",
      message: `That would delete ${count} columns; a single call is limited to ${MAX_DELETE_COLUMNS}.`,
    };
  }
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
      deleteDimension: {
        range: {
          sheetId: tab.sheetId,
          dimension: "COLUMNS",
          startIndex,
          endIndex: endIndex + 1,
        },
      },
    },
    ctx.actionId,
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Deleted columns ${startLetters}-${endLetters} (${count} column(s)) from tab "${tab.title}" of spreadsheet ${id}. Columns to the right shifted left; recovery is possible through the spreadsheet's version history.`,
  };
}

async function sheetsDeleteTab(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const id = String(params.spreadsheetId);
  const tab = await sheetsResolveTab(
    ctx.workspaceId,
    id,
    String(params.tabTitle),
  );
  if (!tab.ok) return tab.outcome;
  // Refuse the last tab HERE, not by leaning on Google's own refusal: the
  // rejection must be deterministic and phrased for the agent.
  if (tab.tabCount <= 1) {
    return {
      ok: false,
      kind: "failed",
      message: `Tab "${tab.title}" is the only tab in spreadsheet ${id}, and a spreadsheet cannot lose its last tab. To discard the whole spreadsheet, use google_drive.trash_item instead.`,
    };
  }
  const result = await sheetsBatchUpdate(
    ctx.workspaceId,
    id,
    { deleteSheet: { sheetId: tab.sheetId } },
    ctx.actionId,
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Deleted tab "${tab.title}" and all its data from spreadsheet ${id}. The spreadsheet itself still exists; the tab is recoverable only through the spreadsheet's version history. (Google refuses to delete a spreadsheet's last remaining tab.)`,
  };
}

/* ----------------------------- Google Docs ------------------------------ */

/**
 * Call the Docs API as the workspace's own Google account. Docs rides on
 * the SAME Drive consent as Sheets (documents.batchUpdate accepts the
 * Drive scopes), on the BASELINE Drive token: connections that predate
 * full Drive access keep editing the documents HomardClaw created; with
 * full Drive granted, Google extends edits to any document the owner's
 * account can edit.
 */
async function docsJson(
  workspaceId: string | null,
  path: string,
  options?: { method?: string; body?: unknown },
  mapFailure?: (refusal: {
    status: number;
    headers: Headers;
    bodyText: string;
  }) => ExecutionOutcome | null,
): Promise<JsonResult> {
  return providerJson({
    workspaceId,
    providerLabel: "Google Docs",
    baseUrl: "https://docs.googleapis.com",
    resolveToken: async (id) => (await driveAccessToken(id)).token,
    path,
    options,
    mapFailure,
  });
}

/**
 * Same 403 translation as Sheets, for any Google-native editor: with full
 * Drive granted, a 403 means the OWNER lacks edit rights on that item, or
 * the connection predates full Drive access. Neither is fixed by retrying.
 */
function explainNativeEditDenied(
  what: string,
): (outcome: ExecutionOutcome) => ExecutionOutcome {
  return (outcome) => {
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
      message: `Google refused the edit (HTTP 403). Either the connected account does not have edit rights on this ${what} (it may be shared read-only), or the Drive connection predates full Drive access and can only edit files HomardClaw created — reconnecting Google Drive with full access fixes the latter.`,
    };
  };
}

const explainDocsEditDeniedOutcome = explainNativeEditDenied("document");
const explainSlidesEditDeniedOutcome = explainNativeEditDenied("presentation");

function staleRevisionOutcome(what: string): ExecutionOutcome {
  return {
    ok: false,
    kind: "failed",
    message: `The ${what} has changed since it was read — its revisionId is no longer current, so Google refused the edit and NOTHING was changed. Read the ${what} again, take the fresh revisionId, and re-check any indexes (they may have shifted).`,
  };
}

/**
 * One Docs or Slides batchUpdate fenced by writeControl.requiredRevisionId.
 * Google applies ALL requests or NONE, and refuses the whole call with a
 * 400 when the revision no longer matches — a stale read can never clobber
 * a newer edit, and an interrupted edit can never be double-applied by a
 * recovery retry (the retry carries the same fence, so if the original DID
 * land, the revision has advanced and Google refuses the replay).
 */
async function revisionFencedBatchUpdate(input: {
  transport: typeof docsJson;
  workspaceId: string | null;
  pathPrefix: string;
  what: "document" | "presentation";
  explainDenied: (outcome: ExecutionOutcome) => ExecutionOutcome;
  requests: Record<string, unknown>[];
  requiredRevisionId: string;
}): Promise<JsonResult> {
  const result = await input.transport(
    input.workspaceId,
    `${input.pathPrefix}:batchUpdate`,
    {
      method: "POST",
      body: {
        requests: input.requests,
        writeControl: { requiredRevisionId: input.requiredRevisionId },
      },
    },
    ({ status, bodyText }) =>
      status === 400 && /revision/i.test(bodyText)
        ? staleRevisionOutcome(input.what)
        : null,
  );
  if (!result.ok) {
    return { ok: false, outcome: input.explainDenied(result.outcome), status: result.status };
  }
  return result;
}

/** The post-edit revision a batchUpdate reports, for chained edits. */
function revisionAfterEdit(data: unknown): string {
  return (
    (data as { writeControl?: { requiredRevisionId?: string } } | null)
      ?.writeControl?.requiredRevisionId ?? "?"
  );
}

async function docsBatchUpdate(
  workspaceId: string | null,
  documentId: string,
  requests: Record<string, unknown>[],
  requiredRevisionId: string,
): Promise<JsonResult> {
  return revisionFencedBatchUpdate({
    transport: docsJson,
    workspaceId,
    pathPrefix: `/v1/documents/${encodeURIComponent(documentId)}`,
    what: "document",
    explainDenied: explainDocsEditDeniedOutcome,
    requests,
    requiredRevisionId,
  });
}

/** An integer >= min, or null. */
function intAtLeast(value: unknown, min: number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? n : null;
}

/** The optional tabId param as a spreadable fragment for Docs locations/ranges. */
function docTabId(params: Record<string, unknown>): { tabId?: string } {
  return params.tabId ? { tabId: String(params.tabId) } : {};
}

async function docsReadDocument(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const id = String(params.fileId);
  // includeTabsContent returns EVERY tab's body (multi-tab docs otherwise
  // surface only their first tab), which is what makes the outline — and
  // the replace-all occurrence bound below — cover the whole document.
  const fields = encodeURIComponent("revisionId,title,tabs");
  const result = await docsJson(
    ctx.workspaceId,
    `/v1/documents/${encodeURIComponent(id)}?includeTabsContent=true&fields=${fields}&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`,
  );
  if (!result.ok) return result.outcome;
  const doc = result.data as {
    revisionId?: string;
    title?: string;
    tabs?: DocTab[];
  } | null;
  const tabs = doc?.tabs ?? [];
  const outline = summarizeDocTabs(tabs);
  const tabCount = flattenDocTabs(tabs).length;
  return {
    ok: true,
    summary: truncate(
      `Google Doc "${doc?.title ?? id}" (documentId ${id}${tabCount > 1 ? `, ${tabCount} tabs` : ""}).\nrevisionId: ${doc?.revisionId ?? "?"} — pass it to every edit; if it goes stale, read again.\nEach line is [startIndex..endIndex) of one paragraph (indexes are UTF-16 positions for insert/delete/format; a paragraph's trailing newline is inside its range)${tabCount > 1 ? "; indexes are PER TAB — pass that tab's tabId with the edit" : ""}:\n${outline}`,
    ),
  };
}

async function docsInsertText(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const index = intAtLeast(params.index, 1);
  if (index === null) {
    return {
      ok: false,
      kind: "failed",
      message:
        "index must be an integer of at least 1, taken from a fresh read_doc.",
    };
  }
  const text = String(params.text);
  const result = await docsBatchUpdate(
    ctx.workspaceId,
    String(params.fileId),
    [{ insertText: { location: { index, ...docTabId(params) }, text } }],
    String(params.revisionId),
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Inserted ${text.length} character(s) into Google Doc ${params.fileId} at index ${index}. New revisionId: ${revisionAfterEdit(result.data)} (later indexes shifted by ${text.length}).`,
  };
}

async function docsReplaceText(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const findText = String(params.findText);
  const replaceText = params.replaceText == null ? "" : String(params.replaceText);
  const id = String(params.fileId);
  const revisionId = String(params.revisionId);
  // Bound the blast radius BEFORE dispatch: count the occurrences against
  // the same revision the edit is fenced to. If the document moves between
  // this count and the batch, the fence rejects the batch — so the count
  // the approval was judged by is exactly the count that gets applied.
  // includeTabsContent matters: an unscoped replaceAllText spans EVERY tab
  // of a multi-tab document, so the count must too.
  const current = await docsJson(
    ctx.workspaceId,
    `/v1/documents/${encodeURIComponent(id)}?includeTabsContent=true`,
  );
  if (!current.ok) return current.outcome;
  const currentRevision = (current.data as { revisionId?: string } | null)
    ?.revisionId;
  if (currentRevision !== revisionId) {
    return {
      ok: false,
      kind: "failed",
      message: `The document has changed since it was read — its revisionId is no longer current, so NOTHING was changed. Read the document again, take the fresh revisionId, and re-check the text to replace.`,
    };
  }
  const occurrences = countOccurrences(
    collectDocParagraphTexts(current.data),
    findText,
  );
  if (occurrences === 0) {
    return {
      ok: true,
      summary: `The exact text was found nowhere in Google Doc ${id}; nothing changed. (Matching is case-sensitive and exact — check the text with read_doc.)`,
    };
  }
  if (occurrences > MAX_REPLACE_OCCURRENCES) {
    return {
      ok: false,
      kind: "failed",
      message: `The text occurs ${occurrences} times in Google Doc ${id}; one replace_doc_text is limited to ${MAX_REPLACE_OCCURRENCES} occurrences, and NOTHING was changed. Narrow the match (a longer, more specific findText) or edit bounded ranges instead.`,
    };
  }
  // Name every tab explicitly in the mutation. The pre-count above walked
  // every tab of this exact revision, so pinning tabsCriteria to the same
  // flattened tab set makes the request scope provably identical to the
  // counted scope — no reliance on the API's per-request tab defaults.
  const tabIds = flattenDocTabs(
    (current.data as { tabs?: DocTab[] } | null)?.tabs ?? [],
  )
    .map((tab) => tab.tabProperties?.tabId)
    .filter((tabId): tabId is string => typeof tabId === "string");
  const result = await docsBatchUpdate(
    ctx.workspaceId,
    id,
    [
      {
        replaceAllText: {
          containsText: { text: findText, matchCase: true },
          replaceText,
          ...(tabIds.length > 0 ? { tabsCriteria: { tabIds } } : {}),
        },
      },
    ],
    revisionId,
  );
  if (!result.ok) return result.outcome;
  const replies =
    (result.data as {
      replies?: { replaceAllText?: { occurrencesChanged?: number } }[];
    } | null)?.replies ?? [];
  const changed = replies[0]?.replaceAllText?.occurrencesChanged ?? occurrences;
  return {
    ok: true,
    summary: `Replaced ${changed} occurrence(s) in Google Doc ${id}. New revisionId: ${revisionAfterEdit(result.data)}.`,
  };
}

async function docsDeleteRange(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const range = parseDocRange(params.startIndex, params.endIndex);
  if (!range.ok) return { ok: false, kind: "failed", message: range.error };
  const result = await docsBatchUpdate(
    ctx.workspaceId,
    String(params.fileId),
    [
      {
        deleteContentRange: {
          range: {
            startIndex: range.startIndex,
            endIndex: range.endIndex,
            ...docTabId(params),
          },
        },
      },
    ],
    String(params.revisionId),
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Deleted [${range.startIndex}..${range.endIndex}) (${range.endIndex - range.startIndex} character(s)) from Google Doc ${params.fileId}. New revisionId: ${revisionAfterEdit(result.data)} (later indexes shifted).`,
  };
}

async function docsFormatRange(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const range = parseDocRange(params.startIndex, params.endIndex);
  if (!range.ok) return { ok: false, kind: "failed", message: range.error };
  const flags = parseTextStyleFlags(params);
  if (!flags.ok) return { ok: false, kind: "failed", message: flags.error };
  const { textStyle, fields } = docsTextStyle(flags.flags);
  const result = await docsBatchUpdate(
    ctx.workspaceId,
    String(params.fileId),
    [
      {
        updateTextStyle: {
          range: {
            startIndex: range.startIndex,
            endIndex: range.endIndex,
            ...docTabId(params),
          },
          textStyle,
          fields,
        },
      },
    ],
    String(params.revisionId),
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Applied ${describeStyleFlags(flags.flags)} to [${range.startIndex}..${range.endIndex}) in Google Doc ${params.fileId}. New revisionId: ${revisionAfterEdit(result.data)}.`,
  };
}

async function docsStyleParagraphs(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const range = parseDocRange(params.startIndex, params.endIndex);
  if (!range.ok) return { ok: false, kind: "failed", message: range.error };
  const built = buildParagraphStyleRequests(params, {
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    ...docTabId(params),
  });
  if (!built.ok) return { ok: false, kind: "failed", message: built.error };
  const result = await docsBatchUpdate(
    ctx.workspaceId,
    String(params.fileId),
    built.requests,
    String(params.revisionId),
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Applied ${built.described} to the paragraphs overlapping [${range.startIndex}..${range.endIndex}) in Google Doc ${params.fileId}. New revisionId: ${revisionAfterEdit(result.data)}.`,
  };
}

/* ---------------------------- Google Slides ----------------------------- */

/** Call the Slides API — same consent and token policy as Docs above. */
async function slidesJson(
  workspaceId: string | null,
  path: string,
  options?: { method?: string; body?: unknown },
  mapFailure?: (refusal: {
    status: number;
    headers: Headers;
    bodyText: string;
  }) => ExecutionOutcome | null,
): Promise<JsonResult> {
  return providerJson({
    workspaceId,
    providerLabel: "Google Slides",
    baseUrl: "https://slides.googleapis.com",
    resolveToken: async (id) => (await driveAccessToken(id)).token,
    path,
    options,
    mapFailure,
  });
}

const DRIVE_PRESENTATION_MIME = "application/vnd.google-apps.presentation";

/** The stable link for a presentation id. */
function presentationLink(id: string): string {
  return `https://docs.google.com/presentation/d/${id}/edit`;
}

async function slidesBatchUpdate(
  workspaceId: string | null,
  presentationId: string,
  requests: Record<string, unknown>[],
  requiredRevisionId: string,
): Promise<JsonResult> {
  return revisionFencedBatchUpdate({
    transport: slidesJson,
    workspaceId,
    pathPrefix: `/v1/presentations/${encodeURIComponent(presentationId)}`,
    what: "presentation",
    explainDenied: explainSlidesEditDeniedOutcome,
    requests,
    requiredRevisionId,
  });
}

async function slidesCreatePresentation(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  // One atomic Drive call, exactly like create_spreadsheet: the action id
  // rides along as an app property so recovery can ask Drive "does the
  // presentation created by action X exist?".
  const created = await driveJson(ctx.workspaceId, "/drive/v3/files", {
    method: "POST",
    body: {
      name: String(params.name),
      mimeType: DRIVE_PRESENTATION_MIME,
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
      message: "Drive did not return a presentation id.",
    };
  }
  return {
    ok: true,
    summary: `Created Google Slides presentation "${params.name}" (presentationId ${file.id}). It starts with one title slide. Link: ${presentationLink(file.id)}`,
  };
}

async function slidesReadPresentation(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const id = String(params.fileId);
  const fields = encodeURIComponent(
    "revisionId,title,slides(objectId,slideProperties(notesPage(notesProperties(speakerNotesObjectId),pageElements(objectId,shape(text(textElements(textRun(content))))))),pageElements(objectId,shape(placeholder(type),text(textElements(textRun(content)))),table(rows,columns)))",
  );
  const result = await slidesJson(
    ctx.workspaceId,
    `/v1/presentations/${encodeURIComponent(id)}?fields=${fields}`,
  );
  if (!result.ok) return result.outcome;
  const data = result.data as {
    revisionId?: string;
    title?: string;
    slides?: SlidesSlide[];
  } | null;
  const slides = data?.slides ?? [];
  return {
    ok: true,
    summary: truncate(
      `Google Slides presentation "${data?.title ?? id}" (presentationId ${id}, ${slides.length} slide(s)).\nrevisionId: ${data?.revisionId ?? "?"} — pass it to every edit; if it goes stale, read again.\nText positions are UTF-16 indexes within one element ([0..length]):\n${summarizePresentation(slides)}`,
    ),
  };
}

async function slidesAddSlide(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const layoutKey = params.layout
    ? String(params.layout).trim().toLowerCase()
    : "blank";
  const layout = SLIDE_LAYOUTS[layoutKey];
  if (!layout) {
    return {
      ok: false,
      kind: "failed",
      message: `layout "${params.layout}" is not supported. Use one of: ${Object.keys(SLIDE_LAYOUTS).join(", ")}.`,
    };
  }
  let insertionIndex: number | undefined;
  if (params.insertAtIndex !== undefined && params.insertAtIndex !== null) {
    const parsed = intAtLeast(params.insertAtIndex, 0);
    if (parsed === null) {
      return {
        ok: false,
        kind: "failed",
        message: "insertAtIndex must be an integer of at least 0.",
      };
    }
    insertionIndex = parsed;
  }
  const result = await slidesBatchUpdate(
    ctx.workspaceId,
    String(params.fileId),
    [
      {
        createSlide: {
          // Deterministic id derived from the action row: its presence in
          // the presentation later is this creation's receipt in recovery.
          ...(ctx.actionId
            ? { objectId: slideObjectIdForAction(ctx.actionId) }
            : {}),
          ...(insertionIndex !== undefined ? { insertionIndex } : {}),
          slideLayoutReference: { predefinedLayout: layout },
        },
      },
    ],
    String(params.revisionId),
  );
  if (!result.ok) return result.outcome;
  const replies =
    (result.data as {
      replies?: { createSlide?: { objectId?: string } }[];
    } | null)?.replies ?? [];
  const objectId = replies[0]?.createSlide?.objectId;
  return {
    ok: true,
    summary: `Added a ${layoutKey} slide (slideObjectId ${objectId ?? "?"}) to presentation ${params.fileId}${insertionIndex !== undefined ? ` at position ${insertionIndex}` : " at the end"}. New revisionId: ${revisionAfterEdit(result.data)}. Read the presentation to get the new slide's text-element ids before writing text into it.`,
  };
}

async function slidesDuplicateSlide(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const slideId = String(params.slideObjectId);
  // duplicateObject copies ANY object by id; guard so an approval that says
  // "duplicate slide X" can never quietly copy a text box instead. (Recovery
  // also depends on this: it looks for the action-derived copy id among the
  // presentation's SLIDES, so a duplicated page element could never be
  // confirmed.)
  const listing = await slidesListSlideIds(
    ctx.workspaceId,
    String(params.fileId),
  );
  if (!listing.ok) return listing.outcome;
  if (!listing.ids.includes(slideId)) {
    return {
      ok: false,
      kind: "failed",
      message: `"${slideId}" is not a slide in this presentation (it may be a text element id, or the slide is gone). duplicate_slide only duplicates whole slides, and NOTHING was changed — check read_presentation.`,
    };
  }
  const result = await slidesBatchUpdate(
    ctx.workspaceId,
    String(params.fileId),
    [
      {
        duplicateObject: {
          objectId: slideId,
          // Same deterministic-receipt trick as add_slide: pin the copy's
          // id so recovery can prove whether the duplicate exists.
          ...(ctx.actionId
            ? { objectIds: { [slideId]: slideObjectIdForAction(ctx.actionId) } }
            : {}),
        },
      },
    ],
    String(params.revisionId),
  );
  if (!result.ok) return result.outcome;
  const replies =
    (result.data as {
      replies?: { duplicateObject?: { objectId?: string } }[];
    } | null)?.replies ?? [];
  const objectId = replies[0]?.duplicateObject?.objectId;
  return {
    ok: true,
    summary: `Duplicated slide ${slideId} in presentation ${params.fileId}; the copy (slideObjectId ${objectId ?? "?"}) is right after the original. New revisionId: ${revisionAfterEdit(result.data)}. The copy's text elements have NEW ids — read the presentation before editing them.`,
  };
}

/** The slide object ids a presentation currently has, for validation. */
async function slidesListSlideIds(
  workspaceId: string | null,
  presentationId: string,
): Promise<
  | { ok: true; ids: string[]; revisionId: string | null }
  | { ok: false; outcome: ExecutionOutcome }
> {
  const result = await slidesJson(
    workspaceId,
    `/v1/presentations/${encodeURIComponent(presentationId)}?fields=${encodeURIComponent("revisionId,slides.objectId")}`,
  );
  if (!result.ok) return { ok: false, outcome: result.outcome };
  const data = result.data as {
    revisionId?: string;
    slides?: { objectId?: string }[];
  } | null;
  return {
    ok: true,
    ids: (data?.slides ?? [])
      .map((s) => s.objectId)
      .filter((id): id is string => typeof id === "string"),
    revisionId: data?.revisionId ?? null,
  };
}

async function slidesMoveSlide(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const newIndex = intAtLeast(params.newIndex, 0);
  if (newIndex === null) {
    return {
      ok: false,
      kind: "failed",
      message: "newIndex must be an integer of at least 0.",
    };
  }
  const slideId = String(params.slideObjectId);
  const result = await slidesBatchUpdate(
    ctx.workspaceId,
    String(params.fileId),
    [
      {
        updateSlidesPosition: {
          slideObjectIds: [slideId],
          insertionIndex: newIndex,
        },
      },
    ],
    String(params.revisionId),
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Moved slide ${slideId} to position ${newIndex} in presentation ${params.fileId}. New revisionId: ${revisionAfterEdit(result.data)}.`,
  };
}

async function slidesDeleteSlide(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const slideId = String(params.slideObjectId);
  // deleteObject removes ANY object by id; guard so an approval that says
  // "delete slide X" can never quietly delete a text box instead.
  const listing = await slidesListSlideIds(
    ctx.workspaceId,
    String(params.fileId),
  );
  if (!listing.ok) return listing.outcome;
  if (!listing.ids.includes(slideId)) {
    return {
      ok: false,
      kind: "failed",
      message: `"${slideId}" is not a slide in this presentation (it may be a text element id, or the slide is already gone). delete_slide only deletes whole slides — check read_presentation.`,
    };
  }
  const result = await slidesBatchUpdate(
    ctx.workspaceId,
    String(params.fileId),
    [{ deleteObject: { objectId: slideId } }],
    String(params.revisionId),
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Deleted slide ${slideId} (and everything on it) from presentation ${params.fileId}. New revisionId: ${revisionAfterEdit(result.data)}. Recovery is possible only through the presentation's version history.`,
  };
}

async function slidesInsertText(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const insertionIndex = intAtLeast(params.insertAtIndex, 0);
  if (insertionIndex === null) {
    return {
      ok: false,
      kind: "failed",
      message:
        "insertAtIndex must be an integer of at least 0 (0 = the start of the element's text).",
    };
  }
  const text = String(params.text);
  const elementId = String(params.elementObjectId);
  const result = await slidesBatchUpdate(
    ctx.workspaceId,
    String(params.fileId),
    [
      {
        insertText: {
          objectId: elementId,
          insertionIndex,
          text,
        },
      },
    ],
    String(params.revisionId),
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Inserted ${text.length} character(s) into element ${elementId} of presentation ${params.fileId} at index ${insertionIndex}. New revisionId: ${revisionAfterEdit(result.data)}.`,
  };
}

async function slidesDeleteText(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const range = parseSlideTextRange(params.startIndex, params.endIndex);
  if (!range.ok) return { ok: false, kind: "failed", message: range.error };
  const elementId = String(params.elementObjectId);
  const result = await slidesBatchUpdate(
    ctx.workspaceId,
    String(params.fileId),
    [
      {
        deleteText: {
          objectId: elementId,
          textRange: {
            type: "FIXED_RANGE",
            startIndex: range.startIndex,
            endIndex: range.endIndex,
          },
        },
      },
    ],
    String(params.revisionId),
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Deleted [${range.startIndex}..${range.endIndex}) from element ${elementId} of presentation ${params.fileId}. New revisionId: ${revisionAfterEdit(result.data)}.`,
  };
}

async function slidesReplaceText(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const findText = String(params.findText);
  const replaceText =
    params.replaceText == null ? "" : String(params.replaceText);
  const slideId = params.slideObjectId ? String(params.slideObjectId) : null;
  const id = String(params.fileId);
  const revisionId = String(params.revisionId);
  // Bound the blast radius BEFORE dispatch, against the fenced revision
  // (same contract as replace_doc_text). A scoped count walks only that
  // slide's subtree; unscoped walks the whole presentation.
  const current = await slidesJson(
    ctx.workspaceId,
    `/v1/presentations/${encodeURIComponent(id)}`,
  );
  if (!current.ok) return current.outcome;
  const presentation = current.data as {
    revisionId?: string;
    slides?: { objectId?: string }[];
  } | null;
  if (presentation?.revisionId !== revisionId) {
    return {
      ok: false,
      kind: "failed",
      message: `The presentation has changed since it was read — its revisionId is no longer current, so NOTHING was changed. Read the presentation again, take the fresh revisionId, and re-check the text to replace.`,
    };
  }
  let countScope: unknown = current.data;
  if (slideId) {
    const slide = (presentation?.slides ?? []).find(
      (s) => s.objectId === slideId,
    );
    if (!slide) {
      return {
        ok: false,
        kind: "failed",
        message: `No slide with objectId "${slideId}" exists in presentation ${id}; NOTHING was changed. Use read_presentation to list the slides.`,
      };
    }
    countScope = slide;
  }
  const occurrences = countOccurrences(
    collectSlidesTexts(countScope),
    findText,
  );
  if (occurrences === 0) {
    return {
      ok: true,
      summary: `The exact text was found nowhere in presentation ${id}${slideId ? ` (slide ${slideId})` : ""}; nothing changed. (Matching is case-sensitive and exact.)`,
    };
  }
  if (occurrences > MAX_REPLACE_OCCURRENCES) {
    return {
      ok: false,
      kind: "failed",
      message: `The text occurs ${occurrences} times in presentation ${id}${slideId ? ` (slide ${slideId})` : ""}; one replace_slide_text is limited to ${MAX_REPLACE_OCCURRENCES} occurrences, and NOTHING was changed. Narrow the match or edit specific elements instead.`,
    };
  }
  const result = await slidesBatchUpdate(
    ctx.workspaceId,
    id,
    [
      {
        replaceAllText: {
          containsText: { text: findText, matchCase: true },
          replaceText,
          ...(slideId ? { pageObjectIds: [slideId] } : {}),
        },
      },
    ],
    revisionId,
  );
  if (!result.ok) return result.outcome;
  const replies =
    (result.data as {
      replies?: { replaceAllText?: { occurrencesChanged?: number } }[];
    } | null)?.replies ?? [];
  const changed = replies[0]?.replaceAllText?.occurrencesChanged ?? occurrences;
  return {
    ok: true,
    summary: `Replaced ${changed} occurrence(s) in presentation ${id}${slideId ? ` (slide ${slideId} only)` : ""}. New revisionId: ${revisionAfterEdit(result.data)}.`,
  };
}

async function slidesFormatText(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const range = parseSlideTextRange(params.startIndex, params.endIndex);
  if (!range.ok) return { ok: false, kind: "failed", message: range.error };
  const flags = parseTextStyleFlags(params);
  if (!flags.ok) return { ok: false, kind: "failed", message: flags.error };
  const { style, fields } = slidesTextStyle(flags.flags);
  const elementId = String(params.elementObjectId);
  const result = await slidesBatchUpdate(
    ctx.workspaceId,
    String(params.fileId),
    [
      {
        updateTextStyle: {
          objectId: elementId,
          textRange: {
            type: "FIXED_RANGE",
            startIndex: range.startIndex,
            endIndex: range.endIndex,
          },
          style,
          fields,
        },
      },
    ],
    String(params.revisionId),
  );
  if (!result.ok) return result.outcome;
  return {
    ok: true,
    summary: `Applied ${describeStyleFlags(flags.flags)} to [${range.startIndex}..${range.endIndex}) in element ${elementId} of presentation ${params.fileId}. New revisionId: ${revisionAfterEdit(result.data)}.`,
  };
}

/* ------------- Plain-text file editing and the Drive Trash -------------- */

/** Files bigger than this are refused for in-place editing. */
const TEXT_FILE_MAX_BYTES = 400_000;

/** Non-"text/*" MIME types that are still plain text in practice. */
const TEXT_LIKE_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/csv",
  "application/x-sh",
  "application/sql",
  "application/rtf",
  "application/octet-stream", // Drive's fallback for extensionless text
]);

function isEditableTextMime(mime: string): boolean {
  const bare = mime.split(";")[0].trim().toLowerCase();
  return bare.startsWith("text/") || TEXT_LIKE_MIMES.has(bare);
}

const explainTextFileEditDenied = explainNativeEditDenied("file");

async function driveUpdateTextFile(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const mode = String(params.mode).trim().toLowerCase();
  if (mode !== "overwrite" && mode !== "append" && mode !== "replace") {
    return {
      ok: false,
      kind: "failed",
      message: 'mode must be "overwrite", "append", or "replace".',
    };
  }
  const findText = params.findText == null ? "" : String(params.findText);
  if (mode === "replace" && findText.length === 0) {
    return {
      ok: false,
      kind: "failed",
      message: "replace mode needs findText — the exact text to swap out.",
    };
  }
  const fileId = String(params.fileId);
  const encoded = encodeURIComponent(fileId);
  const meta = await driveJson(
    ctx.workspaceId,
    `/drive/v3/files/${encoded}?fields=${encodeURIComponent("id,name,mimeType,size,headRevisionId")}&supportsAllDrives=true`,
  );
  if (!meta.ok) return meta.outcome;
  const file = meta.data as {
    name?: string;
    mimeType?: string;
    size?: string;
    headRevisionId?: string;
  } | null;
  const mime = file?.mimeType ?? "";
  if (mime.startsWith(DRIVE_EXPORTABLE_PREFIX)) {
    return {
      ok: false,
      kind: "failed",
      message: `"${file?.name ?? fileId}" is a native Google file (${mime}). Edit it with the Docs, Sheets, or Slides operations instead of update_text_file.`,
    };
  }
  if (!isEditableTextMime(mime)) {
    return {
      ok: false,
      kind: "failed",
      message: `"${file?.name ?? fileId}" is ${mime || "of unknown type"} — not a plain-text file, so it cannot be edited this way.`,
    };
  }
  if (Number(file?.size ?? 0) > TEXT_FILE_MAX_BYTES) {
    return {
      ok: false,
      kind: "failed",
      message: `"${file?.name ?? fileId}" is ${file?.size} bytes; in-place editing is limited to files up to ${TEXT_FILE_MAX_BYTES} bytes.`,
    };
  }

  const content = String(params.content);
  const isOctetStream =
    mime.split(";")[0].trim().toLowerCase() === "application/octet-stream";
  let updated: string;
  let describeChange: string;
  if (mode === "overwrite" && !isOctetStream) {
    updated = content;
    describeChange = `Overwrote the content (now ${content.length} character(s))`;
  } else {
    // append/replace need the exact current bytes — downloaded verbatim,
    // never JSON-parsed and re-serialized. octet-stream files (Drive's
    // fallback for extensionless uploads) are downloaded in EVERY mode:
    // the label covers arbitrary binaries too, so the actual bytes must
    // prove the file is text before we rewrite it as text.
    const current = await driveJson(
      ctx.workspaceId,
      `/drive/v3/files/${encoded}?alt=media&supportsAllDrives=true`,
      { rawResponse: true },
    );
    if (!current.ok) return current.outcome;
    const existing = String(current.data ?? "");
    if (isOctetStream && /[\u0000\uFFFD]/.test(existing)) {
      return {
        ok: false,
        kind: "failed",
        message: `"${file?.name ?? fileId}" is labeled ${mime} and its content is not valid text (it contains binary bytes), so it cannot be edited this way.`,
      };
    }
    if (mode === "overwrite") {
      updated = content;
      describeChange = `Overwrote the content (now ${content.length} character(s))`;
    } else if (mode === "append") {
      updated = existing + content;
      describeChange = `Appended ${content.length} character(s)`;
    } else {
      const occurrences = existing.split(findText).length - 1;
      if (occurrences === 0) {
        return {
          ok: false,
          kind: "failed",
          message: `The exact findText was found nowhere in "${file?.name ?? fileId}"; nothing was changed. (Matching is case-sensitive and exact — read the file first.)`,
        };
      }
      if (occurrences > MAX_REPLACE_OCCURRENCES) {
        return {
          ok: false,
          kind: "failed",
          message: `The findText occurs ${occurrences} times in "${file?.name ?? fileId}"; one replace edit is limited to ${MAX_REPLACE_OCCURRENCES} occurrences, and nothing was changed. Narrow the match (a longer, more specific findText) or overwrite the file with explicit content instead.`,
        };
      }
      updated = existing.split(findText).join(content);
      describeChange = `Replaced ${occurrences} occurrence(s) of the approved text`;
    }
  }
  if (Buffer.byteLength(updated, "utf8") > TEXT_FILE_MAX_BYTES) {
    return {
      ok: false,
      kind: "failed",
      message: `The edit would make the file ${Buffer.byteLength(updated, "utf8")} bytes — over the ${TEXT_FILE_MAX_BYTES}-byte editing limit. Nothing was changed.`,
    };
  }

  // Stale-write fence for content DERIVED from a read (append/replace):
  // Drive v3 has no conditional upload, so re-check the head revision
  // right before writing and refuse if the file changed under us. This
  // narrows — it cannot eliminate — the race window; the last narrow
  // sliver is why update_text_file settles as unknown in crash recovery
  // rather than claiming a fence Docs/Slides actually have.
  if (mode !== "overwrite" && file?.headRevisionId) {
    const recheck = await driveJson(
      ctx.workspaceId,
      `/drive/v3/files/${encoded}?fields=headRevisionId&supportsAllDrives=true`,
    );
    if (!recheck.ok) return recheck.outcome;
    const nowRevision = (recheck.data as { headRevisionId?: string } | null)
      ?.headRevisionId;
    if (nowRevision !== file.headRevisionId) {
      return {
        ok: false,
        kind: "failed",
        message: `"${file?.name ?? fileId}" changed while the edit was being prepared (its revision moved). Nothing was changed — read the file again and retry against its current content.`,
      };
    }
  }

  // Metadata (the action marker) and content travel in ONE multipart
  // request, so the marker on the file is the edit's atomic receipt.
  let boundary = `hc-${ctx.actionId ?? "edit"}-boundary`;
  while (updated.includes(boundary)) boundary = `${boundary}-x`;
  const metadata = ctx.actionId
    ? { appProperties: { [DRIVE_ACTION_KEY]: ctx.actionId } }
    : {};
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mime.split(";")[0].trim() || "text/plain"}; charset=UTF-8`,
    "",
    updated,
    `--${boundary}--`,
  ].join("\r\n");
  const uploaded = await driveJson(
    ctx.workspaceId,
    `/upload/drive/v3/files/${encoded}?uploadType=multipart&supportsAllDrives=true`,
    {
      method: "PATCH",
      body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    },
  );
  if (!uploaded.ok) return explainTextFileEditDenied(uploaded.outcome);
  return {
    ok: true,
    summary: `${describeChange} in Drive file "${file?.name ?? fileId}" (fileId ${fileId}). Earlier versions remain available in the file's Drive version history for a limited time.`,
  };
}

async function driveTrashItem(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const fileId = String(params.fileId);
  const meta = await driveItemMeta(ctx.workspaceId, fileId);
  if (!meta.ok) return meta.outcome;
  const isFolder = meta.item.mimeType === DRIVE_FOLDER_MIME;
  const kindWord = isFolder ? "folder" : "file";
  const trashed = await driveOrganizeJson(
    ctx.workspaceId,
    `/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent("id,name,trashed")}&supportsAllDrives=true`,
    {
      method: "PATCH",
      body: {
        trashed: true,
        // The marker rides on the same PATCH: trashed=true plus this
        // marker land atomically, making the receipt trustworthy.
        ...(ctx.actionId
          ? { appProperties: { [DRIVE_ACTION_KEY]: ctx.actionId } }
          : {}),
      },
    },
  );
  if (!trashed.ok) return explainDriveEditDenied(trashed.outcome);
  return {
    ok: true,
    summary: `Moved Drive ${kindWord} "${meta.item.name ?? fileId}" to the Trash (fileId ${fileId}).${isFolder ? " Everything inside the folder went to the Trash with it." : ""} The owner can restore it from the Trash at drive.google.com; Google removes trashed items permanently after 30 days.`,
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
  "google_drive.create_folder": driveCreateFolder,
  "google_drive.rename_item": driveRenameItem,
  "google_drive.move_item": driveMoveItem,
  "google_drive.create_spreadsheet": driveCreateSpreadsheet,
  "google_drive.list_sheet_tabs": sheetsListTabs,
  "google_drive.read_sheet_range": sheetsReadRange,
  "google_drive.write_sheet_range": sheetsWriteRange,
  "google_drive.append_sheet_rows": sheetsAppendRows,
  "google_drive.add_sheet_tab": sheetsAddTab,
  "google_drive.rename_sheet_tab": sheetsRenameTab,
  "google_drive.clear_sheet_range": sheetsClearRange,
  "google_drive.delete_sheet_rows": sheetsDeleteRows,
  "google_drive.delete_sheet_columns": sheetsDeleteColumns,
  "google_drive.delete_sheet_tab": sheetsDeleteTab,
  "google_drive.read_doc": docsReadDocument,
  "google_drive.insert_doc_text": docsInsertText,
  "google_drive.replace_doc_text": docsReplaceText,
  "google_drive.delete_doc_range": docsDeleteRange,
  "google_drive.format_doc_range": docsFormatRange,
  "google_drive.style_doc_paragraphs": docsStyleParagraphs,
  "google_drive.create_presentation": slidesCreatePresentation,
  "google_drive.read_presentation": slidesReadPresentation,
  "google_drive.add_slide": slidesAddSlide,
  "google_drive.duplicate_slide": slidesDuplicateSlide,
  "google_drive.move_slide": slidesMoveSlide,
  "google_drive.delete_slide": slidesDeleteSlide,
  "google_drive.insert_slide_text": slidesInsertText,
  "google_drive.delete_slide_text": slidesDeleteText,
  "google_drive.replace_slide_text": slidesReplaceText,
  "google_drive.format_slide_text": slidesFormatText,
  "google_drive.update_text_file": driveUpdateTextFile,
  "google_drive.trash_item": driveTrashItem,
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

async function verifyDriveCreatePresentation(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  // Same marker, same query as create_spreadsheet: one atomic Drive call,
  // so a found marker means the presentation fully exists.
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
    summary: `Created Google Slides presentation "${file.name}" (presentationId ${file.id}). Link: ${presentationLink(file.id)} — confirmed after an interrupted run.`,
  };
}

async function verifyDriveCreateFolder(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  // Same marker, same query as create_file. Folder creation is a single
  // call, so found = fully done. The query needs only the baseline scope;
  // the shared-drive flags let it find folders created in shared drives.
  const q = encodeURIComponent(
    `appProperties has { key='${DRIVE_ACTION_KEY}' and value='${actionId}' } and trashed = false`,
  );
  const result = await driveJson(
    workspaceId,
    `/drive/v3/files?q=${q}&pageSize=1&fields=${encodeURIComponent("files(id,name)")}&supportsAllDrives=true&includeItemsFromAllDrives=true`,
  );
  if (!result.ok) {
    return { kind: "unknown", message: failureMessage(result.outcome) };
  }
  const files =
    (result.data as { files?: { id: string; name: string }[] } | null)
      ?.files ?? [];
  if (files.length === 0) return { kind: "not_executed" };
  const folder = files[0];
  return {
    kind: "executed",
    summary: `Created Drive folder "${folder.name}" (folderId ${folder.id}). Confirmed after an interrupted run.`,
  };
}

/**
 * Shared verifier for rename_item and move_item. The mutation PATCH writes
 * the item's name/parents AND the action-id marker in one atomic request,
 * so the marker on the item IS the mutation's receipt: match ⇒ it landed.
 *
 * Marker ABSENCE, however, is deliberately never treated as proof of
 * non-execution. Unlike a folder's creation marker (immutable once set) or
 * Sheets developer metadata (additive entries), this marker is a single
 * per-app key on a MUTABLE item: the original PATCH can succeed and a
 * later legitimate change — the owner, another approved action — can
 * overwrite the key before recovery looks. Requeueing on absence could
 * then replay an already-done rename/move over that later change without
 * a fresh approval. Ambiguous evidence settles "unknown": the owner
 * re-approves if the change is still wanted, and nothing is ever silently
 * done twice.
 */
function verifyDriveOrganizeMutation(
  describe: (params: Record<string, unknown>) => string,
): (
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
) => Promise<VerificationResult> {
  return async (params, actionId, workspaceId) => {
    const result = await driveOrganizeJson(
      workspaceId,
      `/drive/v3/files/${encodeURIComponent(String(params.fileId))}?fields=${encodeURIComponent("id,name,parents,appProperties")}&supportsAllDrives=true`,
    );
    if (!result.ok) {
      return { kind: "unknown", message: failureMessage(result.outcome) };
    }
    const item = result.data as {
      name?: string;
      parents?: string[];
      appProperties?: Record<string, string>;
    } | null;
    if (item?.appProperties?.[DRIVE_ACTION_KEY] === actionId) {
      return {
        kind: "executed",
        summary: `${describe(params)} Confirmed by the item's embedded action marker after an interrupted run.`,
      };
    }
    return {
      kind: "unknown",
      message:
        "The item does not carry this action's marker, so the change cannot be confirmed — but a later change to the same item could have replaced the marker, so it cannot be ruled out either. It was not retried; check the item in Drive and approve the change again if it is still wanted.",
    };
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
 * Verifier for the revision-fenced Docs and Slides edits. Every such edit
 * carries writeControl.requiredRevisionId = the revisionId param, so the
 * provider's CURRENT revision answers the recovery question:
 *
 * - current === the fenced revision ⇒ the edit provably did NOT land (a
 *   landed edit always advances the revision). Answering "not_executed" is
 *   safe even against an original request still in flight inside Google:
 *   whichever of the two fenced requests lands first advances the
 *   revision, and Google then refuses the other one as stale — at most ONE
 *   can ever apply, which is why this verifier is "strong" despite the
 *   crash-timing ambiguity that forces Sheets to be "eventual".
 * - current !== the fenced revision ⇒ someone advanced the document — our
 *   interrupted edit, the owner, anyone. Impossible to attribute, so it
 *   settles unknown (and a retry would be refused as stale anyway).
 */
function verifyRevisionFencedEdit(
  fetchRevision: (
    workspaceId: string | null,
    params: Record<string, unknown>,
  ) => Promise<JsonResult>,
  what: "document" | "presentation",
): (
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
) => Promise<VerificationResult> {
  return async (params, _actionId, workspaceId) => {
    const result = await fetchRevision(workspaceId, params);
    if (!result.ok) {
      return { kind: "unknown", message: failureMessage(result.outcome) };
    }
    const current = (result.data as { revisionId?: string } | null)
      ?.revisionId;
    if (!current) {
      return {
        kind: "unknown",
        message: `Google did not report the ${what}'s current revision.`,
      };
    }
    if (current === String(params.revisionId)) return { kind: "not_executed" };
    return {
      kind: "unknown",
      message: `The ${what}'s revision advanced past the one this edit was fenced to, so it is impossible to tell whether the interrupted edit itself landed. It was not retried (Google would refuse the stale replay anyway); read the ${what} to check, and request the edit again if it is still wanted.`,
    };
  };
}

const fetchDocsRevision = (
  workspaceId: string | null,
  params: Record<string, unknown>,
) =>
  docsJson(
    workspaceId,
    `/v1/documents/${encodeURIComponent(String(params.fileId))}?fields=revisionId`,
  );

const fetchSlidesRevision = (
  workspaceId: string | null,
  params: Record<string, unknown>,
) =>
  slidesJson(
    workspaceId,
    `/v1/presentations/${encodeURIComponent(String(params.fileId))}?fields=revisionId`,
  );

const verifyDocsEdit = verifyRevisionFencedEdit(fetchDocsRevision, "document");
const verifySlidesEdit = verifyRevisionFencedEdit(
  fetchSlidesRevision,
  "presentation",
);

/**
 * Verifier for add_slide and duplicate_slide, which pin the new slide's
 * object id to one derived from the action row: the id's presence in the
 * presentation IS the creation's receipt (executed), and when it is absent
 * the revision fence decides exactly like verifyRevisionFencedEdit.
 */
async function verifySlideCreation(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const expected = slideObjectIdForAction(actionId);
  const listing = await slidesListSlideIds(
    workspaceId,
    String(params.fileId),
  );
  if (!listing.ok) {
    return { kind: "unknown", message: failureMessage(listing.outcome) };
  }
  if (listing.ids.includes(expected)) {
    return {
      kind: "executed",
      summary: `The slide (slideObjectId ${expected}) exists in presentation ${params.fileId} — confirmed by its action-derived object id after an interrupted run.`,
    };
  }
  if (listing.revisionId === String(params.revisionId)) {
    return { kind: "not_executed" };
  }
  return {
    kind: "unknown",
    message:
      "The presentation's revision advanced and the action-pinned slide id is absent — the slide may have landed and been deleted since, or never landed at all. It was not retried; read the presentation and request the change again if it is still wanted.",
  };
}

/**
 * Verifier for update_text_file: metadata (the marker) and content land in
 * ONE multipart PATCH, so a matching marker proves the edit. Absence
 * settles unknown for the same reason as rename/move — the marker is a
 * single mutable per-app key that any later approved action on the same
 * file can overwrite, so absence never proves non-execution.
 */
async function verifyDriveTextFileUpdate(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const result = await driveJson(
    workspaceId,
    `/drive/v3/files/${encodeURIComponent(String(params.fileId))}?fields=${encodeURIComponent("id,name,appProperties")}&supportsAllDrives=true`,
  );
  if (!result.ok) {
    return { kind: "unknown", message: failureMessage(result.outcome) };
  }
  const item = result.data as {
    name?: string;
    appProperties?: Record<string, string>;
  } | null;
  if (item?.appProperties?.[DRIVE_ACTION_KEY] === actionId) {
    return {
      kind: "executed",
      summary: `Edited Drive file "${item?.name ?? params.fileId}" (fileId ${params.fileId}). Confirmed by the file's embedded action marker after an interrupted run.`,
    };
  }
  return {
    kind: "unknown",
    message:
      "The file does not carry this action's marker, so the edit cannot be confirmed — but a later change to the same file could have replaced the marker, so it cannot be ruled out either. It was not retried; check the file's content and version history, and approve the edit again if it is still wanted.",
  };
}

/**
 * Verifier for trash_item: trashed=true and the marker land in one atomic
 * PATCH. Marker match ⇒ executed; the item simply BEING in the Trash also
 * confirms the approved end state. Neither ⇒ unknown — the PATCH may have
 * landed and the owner restored the item since, and re-trashing an item
 * the owner deliberately restored would be a silent replay.
 */
async function verifyDriveTrash(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const result = await driveOrganizeJson(
    workspaceId,
    `/drive/v3/files/${encodeURIComponent(String(params.fileId))}?fields=${encodeURIComponent("id,name,trashed,appProperties")}&supportsAllDrives=true`,
  );
  if (!result.ok) {
    return { kind: "unknown", message: failureMessage(result.outcome) };
  }
  const item = result.data as {
    name?: string;
    trashed?: boolean;
    appProperties?: Record<string, string>;
  } | null;
  if (
    item?.appProperties?.[DRIVE_ACTION_KEY] === actionId ||
    item?.trashed === true
  ) {
    return {
      kind: "executed",
      summary: `Moved Drive item "${item?.name ?? params.fileId}" to the Trash (fileId ${params.fileId}). Confirmed after an interrupted run; the owner can restore it at drive.google.com.`,
    };
  }
  return {
    kind: "unknown",
    message:
      "The item is not in the Trash and carries no marker from this action — it may never have been trashed, or it was trashed and restored since. It was not retried; approve the change again if it is still wanted.",
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
  "google_drive.create_folder": {
    consistency: "eventual",
    verify: verifyDriveCreateFolder,
  },
  // Rename/move read the item itself by id (read-after-write consistent,
  // hence "strong": a found marker is trusted immediately). The verifier
  // never answers not_executed — see verifyDriveOrganizeMutation for why
  // marker absence on a mutable item must settle unknown, not requeue.
  "google_drive.rename_item": {
    consistency: "strong",
    verify: verifyDriveOrganizeMutation(
      (p) => `Renamed the Drive item to "${p.newName}" (fileId ${p.fileId}).`,
    ),
  },
  "google_drive.move_item": {
    consistency: "strong",
    verify: verifyDriveOrganizeMutation(
      (p) =>
        `Moved the Drive item (fileId ${p.fileId}) into folder ${p.destinationFolderId}.`,
    ),
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
  "google_drive.clear_sheet_range": {
    consistency: "eventual",
    verify: verifySheetsMutation(
      (p) =>
        `Cleared the values of ${p.range} in spreadsheet ${p.spreadsheetId}.`,
    ),
  },
  "google_drive.delete_sheet_rows": {
    consistency: "eventual",
    verify: verifySheetsMutation(
      (p) =>
        `Deleted rows ${p.startRow}-${p.endRow} from tab "${p.tabTitle}" of spreadsheet ${p.spreadsheetId}.`,
    ),
  },
  "google_drive.delete_sheet_columns": {
    consistency: "eventual",
    verify: verifySheetsMutation(
      (p) =>
        `Deleted columns ${p.startColumn}-${p.endColumn} from tab "${p.tabTitle}" of spreadsheet ${p.spreadsheetId}.`,
    ),
  },
  "google_drive.delete_sheet_tab": {
    consistency: "eventual",
    verify: verifySheetsMutation(
      (p) =>
        `Deleted tab "${p.tabTitle}" from spreadsheet ${p.spreadsheetId}.`,
    ),
  },
  // Docs and Slides edits are fenced by requiredRevisionId, which lets the
  // revision verifiers answer "not_executed" safely even seconds after a
  // crash — see verifyRevisionFencedEdit for the argument. Hence "strong".
  "google_drive.insert_doc_text": {
    consistency: "strong",
    verify: verifyDocsEdit,
  },
  "google_drive.replace_doc_text": {
    consistency: "strong",
    verify: verifyDocsEdit,
  },
  "google_drive.delete_doc_range": {
    consistency: "strong",
    verify: verifyDocsEdit,
  },
  "google_drive.format_doc_range": {
    consistency: "strong",
    verify: verifyDocsEdit,
  },
  "google_drive.style_doc_paragraphs": {
    consistency: "strong",
    verify: verifyDocsEdit,
  },
  "google_drive.create_presentation": {
    consistency: "eventual",
    verify: verifyDriveCreatePresentation,
  },
  "google_drive.add_slide": {
    consistency: "strong",
    verify: verifySlideCreation,
  },
  "google_drive.duplicate_slide": {
    consistency: "strong",
    verify: verifySlideCreation,
  },
  "google_drive.move_slide": {
    consistency: "strong",
    verify: verifySlidesEdit,
  },
  "google_drive.delete_slide": {
    consistency: "strong",
    verify: verifySlidesEdit,
  },
  "google_drive.insert_slide_text": {
    consistency: "strong",
    verify: verifySlidesEdit,
  },
  "google_drive.delete_slide_text": {
    consistency: "strong",
    verify: verifySlidesEdit,
  },
  "google_drive.replace_slide_text": {
    consistency: "strong",
    verify: verifySlidesEdit,
  },
  "google_drive.format_slide_text": {
    consistency: "strong",
    verify: verifySlidesEdit,
  },
  // The marker lands atomically with the content/trash flag, and the item
  // is read back by id (read-after-write). Like rename/move, absence of
  // the mutable marker never answers not_executed — only unknown.
  "google_drive.update_text_file": {
    consistency: "strong",
    verify: verifyDriveTextFileUpdate,
  },
  "google_drive.trash_item": {
    consistency: "strong",
    verify: verifyDriveTrash,
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
