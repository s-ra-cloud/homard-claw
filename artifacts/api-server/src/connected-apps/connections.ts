import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  APP_CATALOG,
  type AppOperation,
  type ConnectedAppId,
} from "./catalog";

/**
 * Live connection state of the workspace owner's account for one app.
 * "unavailable" means the connector service itself could not be reached —
 * deliberately distinct from "not_connected" so a transient platform outage
 * never reads as "the owner disconnected this app".
 */
export type ConnectionStatus = {
  status: "connected" | "not_connected" | "unavailable";
  detail: string | null;
};

/**
 * A fresh client per call, never cached: the SDK resolves and refreshes
 * OAuth tokens on the platform side, and holding a client (or anything
 * derived from it) would freeze a token that must be allowed to rotate.
 */
function client(): ReplitConnectors {
  return new ReplitConnectors();
}

export async function connectionStatus(
  app: ConnectedAppId,
): Promise<ConnectionStatus> {
  const { connectorName } = APP_CATALOG[app];
  try {
    const connections = await client().listConnections({
      connector_names: connectorName,
    });
    const match = connections.find(
      (item) => item.connector_name === connectorName,
    );
    if (!match) return { status: "not_connected", detail: null };
    return { status: "connected", detail: match.status_message ?? null };
  } catch (error) {
    return {
      status: "unavailable",
      detail:
        error instanceof Error ? error.message : "Connector service unreachable",
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

/* ------------------------------ Gmail ---------------------------------- */

function rfc822(to: string, subject: string, body: string): string {
  return Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`,
    "utf8",
  ).toString("base64url");
}

type GmailHeaders = { name?: string; value?: string }[];

function headerValue(headers: GmailHeaders | undefined, name: string): string {
  return (
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

async function gmailSearch(params: Record<string, unknown>): Promise<ExecutionOutcome> {
  const query = encodeURIComponent(String(params.query));
  const listed = await proxyJson(
    "gmail",
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
    const detail = await proxyJson(
      "gmail",
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

async function gmailReadThread(params: Record<string, unknown>): Promise<ExecutionOutcome> {
  const threadId = encodeURIComponent(String(params.threadId));
  const result = await proxyJson(
    "gmail",
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

async function gmailCreateDraft(params: Record<string, unknown>): Promise<ExecutionOutcome> {
  const result = await proxyJson("gmail", "/gmail/v1/users/me/drafts", {
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

async function gmailSendEmail(params: Record<string, unknown>): Promise<ExecutionOutcome> {
  const result = await proxyJson("gmail", "/gmail/v1/users/me/messages/send", {
    method: "POST",
    body: {
      raw: rfc822(String(params.to), String(params.subject), String(params.body)),
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

async function driveSearch(params: Record<string, unknown>): Promise<ExecutionOutcome> {
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

async function driveReadFile(params: Record<string, unknown>): Promise<ExecutionOutcome> {
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

async function driveCreateFile(params: Record<string, unknown>): Promise<ExecutionOutcome> {
  const created = await proxyJson("google_drive", "/drive/v3/files", {
    method: "POST",
    body: { name: String(params.name), mimeType: "text/plain" },
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

async function githubListRepos(): Promise<ExecutionOutcome> {
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

async function githubReadFile(params: Record<string, unknown>): Promise<ExecutionOutcome> {
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

async function githubListIssues(params: Record<string, unknown>): Promise<ExecutionOutcome> {
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

async function githubCreateIssue(params: Record<string, unknown>): Promise<ExecutionOutcome> {
  const result = await proxyJson(
    "github",
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/issues`,
    {
      method: "POST",
      body: {
        title: String(params.title),
        ...(params.body ? { body: String(params.body) } : {}),
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

async function githubCommentOnIssue(params: Record<string, unknown>): Promise<ExecutionOutcome> {
  const issueNumber = Math.trunc(Number(params.issueNumber));
  const result = await proxyJson(
    "github",
    `/repos/${encodeURIComponent(String(params.owner))}/${encodeURIComponent(String(params.repo))}/issues/${issueNumber}/comments`,
    { method: "POST", body: { body: String(params.body) } },
  );
  if (!result.ok) return result.outcome;
  const comment = result.data as { html_url?: string } | null;
  return {
    ok: true,
    summary: `Commented on ${params.owner}/${params.repo}#${issueNumber}: ${comment?.html_url ?? ""}`,
  };
}

const EXECUTORS: Record<string, (params: Record<string, unknown>) => Promise<ExecutionOutcome>> = {
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

/** Run one validated, authorized operation against its connector. */
export async function executeOperation(
  op: AppOperation,
  params: Record<string, unknown>,
): Promise<ExecutionOutcome> {
  const executor = EXECUTORS[op.name];
  if (!executor) {
    return { ok: false, kind: "failed", message: `No executor for ${op.name}.` };
  }
  try {
    return await executor(params);
  } catch (error) {
    return {
      ok: false,
      kind: "failed",
      message: error instanceof Error ? error.message : "Unexpected app error",
    };
  }
}
