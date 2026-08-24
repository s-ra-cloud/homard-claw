import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  APP_CATALOG,
  type AppOperation,
  type ConnectedAppId,
} from "./catalog";
import { legacyWorkspaceId } from "../workspace";
import {
  GoogleAuthError,
  gmailAccessToken,
  googleAccountSummary,
} from "../google/credentials";

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
 * The only connector-metadata keys ever surfaced to the UI. Everything else
 * (tokens, scopes, raw settings) stays server-side. Order is preference.
 */
const ACCOUNT_LABEL_KEYS = [
  "email",
  "account_email",
  "user_email",
  "emailAddress",
  "login",
  "username",
  "user_name",
  "account_name",
  "handle",
] as const;

function pickLabel(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const record = source as Record<string, unknown>;
  for (const key of ACCOUNT_LABEL_KEYS) {
    const value = record[key];
    if (
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 120
    ) {
      return value.trim();
    }
  }
  return null;
}

/** Connector status strings that mean "the owner must re-authorize". */
const EXPIRED_STATUS = /expire|revok|invalid|reauth|disconnect|error|fail/i;

/**
 * Map one raw connector listing (or its absence) to the state the UI shows.
 * Pure and exported for tests: this is where "no credential ever leaks" and
 * "expired is not the same as never connected" are pinned down.
 */
export function describeConnection(
  match: Record<string, unknown> | undefined,
): ConnectionStatus {
  if (!match) return { status: "not_connected", detail: null, accountLabel: null };
  const accountLabel =
    pickLabel(match.metadata) ?? pickLabel(match.integration) ?? pickLabel(match);
  const rawStatus = typeof match.status === "string" ? match.status : "";
  const detail =
    typeof match.status_message === "string" && match.status_message.trim()
      ? match.status_message
      : null;
  if (EXPIRED_STATUS.test(rawStatus) || EXPIRED_STATUS.test(detail ?? "")) {
    return { status: "expired", detail, accountLabel };
  }
  return { status: "connected", detail, accountLabel };
}

/**
 * A fresh client per call, never cached: the SDK resolves and refreshes
 * OAuth tokens on the platform side, and holding a client (or anything
 * derived from it) would freeze a token that must be allowed to rotate.
 */
function client(): ReplitConnectors {
  return new ReplitConnectors();
}

/**
 * Gmail's connection is the workspace's own Google account, created by the
 * in-app OAuth flow. Drive and GitHub still ride the Replit workspace
 * connector, which belongs to the original owner alone: any other
 * workspace sees them as not connected, so a shared platform credential
 * can never become a cross-user access path.
 */
export async function connectionStatus(
  app: ConnectedAppId,
  workspaceId: string,
): Promise<ConnectionStatus> {
  if (app === "gmail") {
    const account = await googleAccountSummary(workspaceId);
    if (!account) {
      return { status: "not_connected", detail: null, accountLabel: null };
    }
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
  const legacyId = await legacyWorkspaceId();
  if (!legacyId || legacyId !== workspaceId) {
    return {
      status: "not_connected",
      detail:
        "This app is not yet available for personal accounts — per-user connections for it are coming later.",
      accountLabel: null,
    };
  }
  const { connectorName } = APP_CATALOG[app];
  try {
    const connections = await client().listConnections({
      connector_names: connectorName,
    });
    const match = connections.find(
      (item) => item.connector_name === connectorName,
    );
    return describeConnection(match);
  } catch (error) {
    return {
      status: "unavailable",
      detail:
        error instanceof Error ? error.message : "Connector service unreachable",
      accountLabel: null,
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

async function proxyJson(
  app: ConnectedAppId,
  path: string,
  options?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<
  | { ok: true; data: unknown }
  | { ok: false; outcome: ExecutionOutcome }
> {
  const { connectorName } = APP_CATALOG[app];
  let response: Response;
  try {
    response = await client().proxy(connectorName, path, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The SDK throws before any HTTP round-trip when no connection exists
    // for the connector; that is an authorization problem, not a provider one.
    const authLike = /not.{0,10}connect|no connection|unauthoriz|forbidden|credential|token/i.test(
      message,
    );
    return {
      ok: false,
      outcome: {
        ok: false,
        kind: authLike ? "auth" : "failed",
        message: authLike
          ? `No usable connection for this app: ${message}. The owner must connect or reconnect it.`
          : `Could not reach the app: ${message}`,
      },
    };
  }
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, outcome: mapProxyFailure(response.status, text) };
  }
  if (!text) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: true, data: text };
  }
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

/**
 * Guard for apps still served by the Replit workspace connector: only the
 * legacy owner's workspace may use them.
 */
async function requireLegacyWorkspace(
  ctx: ExecutionContext,
): Promise<ExecutionOutcome | null> {
  if (!ctx.workspaceId) return NO_WORKSPACE_OUTCOME;
  const legacyId = await legacyWorkspaceId();
  if (!legacyId || legacyId !== ctx.workspaceId) {
    return {
      ok: false,
      kind: "auth",
      message:
        "This app is not connected for this workspace. Per-user connections for it are not available yet.",
    };
  }
  return null;
}

/* -------------------- Per-workspace Gmail transport -------------------- */

const GMAIL_API = "https://gmail.googleapis.com";

/**
 * Call the Gmail API as the owning workspace's own Google account. Every
 * call resolves (and if needed refreshes) the credential fresh, so a
 * disconnect or revocation blocks the very next operation.
 */
async function gmailJson(
  workspaceId: string | null,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<
  | { ok: true; data: unknown }
  | { ok: false; outcome: ExecutionOutcome }
> {
  if (!workspaceId) return { ok: false, outcome: NO_WORKSPACE_OUTCOME };
  let token: string;
  try {
    ({ token } = await gmailAccessToken(workspaceId));
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      return {
        ok: false,
        outcome: {
          ok: false,
          kind: error.kind === "unavailable" ? "failed" : "auth",
          message: error.message,
        },
      };
    }
    throw error;
  }
  let response: Response;
  try {
    response = await fetch(`${GMAIL_API}${path}`, {
      method: options?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options?.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(options?.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
  } catch (error) {
    return {
      ok: false,
      outcome: {
        ok: false,
        kind: "failed",
        message: `Could not reach Gmail: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, outcome: mapProxyFailure(response.status, text) };
  }
  if (!text) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: true, data: text };
  }
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

function rfc822(
  to: string,
  subject: string,
  body: string,
  messageId?: string,
): string {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    ...(messageId ? [`Message-ID: <${messageId}>`] : []),
    `Content-Type: text/plain; charset="UTF-8"`,
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString(
    "base64url",
  );
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
  const result = await gmailJson(ctx.workspaceId, "/gmail/v1/users/me/drafts", {
    method: "POST",
    body: {
      message: {
        raw: rfc822(String(params.to), String(params.subject), String(params.body)),
      },
    },
  });
  if (!result.ok) return result.outcome;
  const draft = result.data as { id?: string } | null;
  return {
    ok: true,
    summary: `Draft created (id ${draft?.id ?? "unknown"}) to ${params.to}: "${params.subject}". It has NOT been sent.`,
  };
}

async function gmailSendEmail(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const result = await gmailJson(
    ctx.workspaceId,
    "/gmail/v1/users/me/messages/send",
    {
      method: "POST",
    body: {
      raw: rfc822(
        String(params.to),
        String(params.subject),
        String(params.body),
        ctx.actionId ? gmailMessageId(ctx.actionId) : undefined,
      ),
    },
  });
  if (!result.ok) return result.outcome;
  const message = result.data as { id?: string } | null;
  return {
    ok: true,
    summary: `Email sent (id ${message?.id ?? "unknown"}) to ${params.to}: "${params.subject}".`,
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
  const denied = await requireLegacyWorkspace(ctx);
  if (denied) return denied;
  const term = escapeDriveQuery(String(params.query));
  const q = encodeURIComponent(
    `(name contains '${term}' or fullText contains '${term}') and trashed = false`,
  );
  const result = await proxyJson(
    "google_drive",
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

async function driveReadFile(
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const denied = await requireLegacyWorkspace(ctx);
  if (denied) return denied;
  const fileId = encodeURIComponent(String(params.fileId));
  const meta = await proxyJson(
    "google_drive",
    `/drive/v3/files/${fileId}?fields=${encodeURIComponent("id,name,mimeType")}`,
  );
  if (!meta.ok) return meta.outcome;
  const file = meta.data as { name?: string; mimeType?: string };
  const mime = file.mimeType ?? "";
  const path = mime.startsWith(DRIVE_EXPORTABLE_PREFIX)
    ? `/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent("text/plain")}`
    : `/drive/v3/files/${fileId}?alt=media`;
  const content = await proxyJson("google_drive", path);
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
  const denied = await requireLegacyWorkspace(ctx);
  if (denied) return denied;
  const created = await proxyJson("google_drive", "/drive/v3/files", {
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
  const uploaded = await proxyJson(
    "google_drive",
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

/* ------------------------------- GitHub -------------------------------- */

async function githubListRepos(
  _params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionOutcome> {
  const denied = await requireLegacyWorkspace(ctx);
  if (denied) return denied;
  const result = await proxyJson(
    "github",
    "/user/repos?sort=pushed&per_page=30",
  );
  if (!result.ok) return result.outcome;
  const repos = (result.data as { full_name: string; private: boolean; description?: string | null }[] | null) ?? [];
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
  const denied = await requireLegacyWorkspace(ctx);
  if (denied) return denied;
  const { owner, repo, path } = params;
  const ref = params.ref ? `?ref=${encodeURIComponent(String(params.ref))}` : "";
  const result = await proxyJson(
    "github",
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
  const denied = await requireLegacyWorkspace(ctx);
  if (denied) return denied;
  const state = ["open", "closed", "all"].includes(String(params.state))
    ? String(params.state)
    : "open";
  const result = await proxyJson(
    "github",
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
  const denied = await requireLegacyWorkspace(ctx);
  if (denied) return denied;
  const body = withGithubMarker(
    params.body ? String(params.body) : "",
    ctx.actionId,
  );
  const result = await proxyJson(
    "github",
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
  const denied = await requireLegacyWorkspace(ctx);
  if (denied) return denied;
  const issueNumber = Math.trunc(Number(params.issueNumber));
  const result = await proxyJson(
    "github",
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
  "github.list_repos": githubListRepos,
  "github.read_file": githubReadFile,
  "github.list_issues": githubListIssues,
  "github.create_issue": githubCreateIssue,
  "github.comment_on_issue": githubCommentOnIssue,
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
  const denied = await requireLegacyWorkspace({ actionId, workspaceId });
  if (denied) return { kind: "unknown", message: failureMessage(denied) };
  const result = await proxyJson(
    "github",
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
  const denied = await requireLegacyWorkspace({ actionId, workspaceId });
  if (denied) return { kind: "unknown", message: failureMessage(denied) };
  const issueNumber = Math.trunc(Number(params.issueNumber));
  const result = await proxyJson(
    "github",
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

async function verifyDriveCreateFile(
  params: Record<string, unknown>,
  actionId: string,
  workspaceId: string | null,
): Promise<VerificationResult> {
  const denied = await requireLegacyWorkspace({ actionId, workspaceId });
  if (denied) return { kind: "unknown", message: failureMessage(denied) };
  const q = encodeURIComponent(
    `appProperties has { key='${DRIVE_ACTION_KEY}' and value='${actionId}' } and trashed = false`,
  );
  const result = await proxyJson(
    "google_drive",
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
    const uploaded = await proxyJson(
      "google_drive",
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
  "google_drive.create_file": {
    consistency: "eventual",
    verify: verifyDriveCreateFile,
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
