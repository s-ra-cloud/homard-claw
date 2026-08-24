import {
  APP_ACCESS_LEVELS,
  CONNECTED_APP_IDS,
  type AppAccessLevel,
  type ConnectedAppId,
} from "@workspace/db";

/**
 * The closed catalog of external apps agents can be granted. Every entry
 * maps to a Replit-managed connector: the owner connects the account once
 * through the platform, and this server never sees or stores a credential.
 */
export const APP_CATALOG: Record<
  ConnectedAppId,
  { displayName: string; connectorName: string }
> = {
  gmail: { displayName: "Gmail", connectorName: "google-mail" },
  google_drive: { displayName: "Google Drive", connectorName: "google-drive" },
  github: { displayName: "GitHub", connectorName: "github" },
};

export { APP_ACCESS_LEVELS, CONNECTED_APP_IDS };
export type { AppAccessLevel, ConnectedAppId };

/** read < draft < write; a grant authorizes its own level and everything below. */
const LEVEL_RANK: Record<AppAccessLevel, number> = {
  read: 0,
  draft: 1,
  write: 2,
};

export function levelAllows(
  granted: AppAccessLevel,
  required: AppAccessLevel,
): boolean {
  return LEVEL_RANK[granted] >= LEVEL_RANK[required];
}

export function isConnectedAppId(value: string): value is ConnectedAppId {
  return (CONNECTED_APP_IDS as readonly string[]).includes(value);
}

type ParamSpec = {
  name: string;
  required: boolean;
  kind: "string" | "number";
  maxLength?: number;
  /**
   * Only body/content params may contain newlines. Everything else feeds
   * headers, queries, or path-like values, where a CR/LF is an injection
   * (e.g. adding a Bcc header to an approved email), never legitimate data.
   */
  multiline?: boolean;
};

export type AppOperation = {
  /** Fully qualified name the model uses, e.g. "gmail.search". */
  name: string;
  app: ConnectedAppId;
  level: AppAccessLevel;
  /** One-line description shown to the model and the owner. */
  description: string;
  params: ParamSpec[];
  /** Human-readable "what/where" for approvals and the audit log. */
  target: (params: Record<string, unknown>) => string;
};

const str = (name: string, required = true, maxLength = 2000): ParamSpec => ({
  name,
  required,
  kind: "string",
  maxLength,
  multiline: name === "body" || name === "content",
});
const num = (name: string, required = true): ParamSpec => ({
  name,
  required,
  kind: "number",
});

export const APP_OPERATIONS: AppOperation[] = [
  {
    name: "gmail.search",
    app: "gmail",
    level: "read",
    description: "Search the mailbox; params: query (Gmail search syntax)",
    params: [str("query")],
    target: (p) => `Gmail search for "${p.query}"`,
  },
  {
    name: "gmail.read_thread",
    app: "gmail",
    level: "read",
    description: "Read one email thread; params: threadId",
    params: [str("threadId", true, 200)],
    target: (p) => `Gmail thread ${p.threadId}`,
  },
  {
    name: "gmail.create_draft",
    app: "gmail",
    level: "draft",
    description:
      "Create an email draft (never sends); params: to, subject, body",
    params: [str("to", true, 500), str("subject", true, 500), str("body", true, 20000)],
    target: (p) => `Draft email to ${p.to}: "${p.subject}"`,
  },
  {
    name: "gmail.send_email",
    app: "gmail",
    level: "write",
    description:
      "Send an email from the owner's account; params: to, subject, body",
    params: [str("to", true, 500), str("subject", true, 500), str("body", true, 20000)],
    target: (p) => `Send email to ${p.to}: "${p.subject}"`,
  },
  {
    name: "google_drive.search",
    app: "google_drive",
    level: "read",
    description: "Find files by name or content; params: query",
    params: [str("query", true, 500)],
    target: (p) => `Drive search for "${p.query}"`,
  },
  {
    name: "google_drive.read_file",
    app: "google_drive",
    level: "read",
    description: "Read a file's text content; params: fileId",
    params: [str("fileId", true, 200)],
    target: (p) => `Drive file ${p.fileId}`,
  },
  {
    name: "google_drive.create_file",
    app: "google_drive",
    level: "draft",
    description:
      "Create a new text file in the owner's Drive; params: name, content",
    params: [str("name", true, 300), str("content", true, 100000)],
    target: (p) => `Create Drive file "${p.name}"`,
  },
  {
    name: "github.list_repos",
    app: "github",
    level: "read",
    description: "List repositories the account can access; no params",
    params: [],
    target: () => "GitHub repository list",
  },
  {
    name: "github.read_file",
    app: "github",
    level: "read",
    description: "Read a file from a repository; params: owner, repo, path, ref (optional)",
    params: [str("owner", true, 200), str("repo", true, 200), str("path", true, 500), str("ref", false, 200)],
    target: (p) => `GitHub file ${p.owner}/${p.repo}/${p.path}`,
  },
  {
    name: "github.list_issues",
    app: "github",
    level: "read",
    description:
      "List issues in a repository; params: owner, repo, state (optional: open|closed|all)",
    params: [str("owner", true, 200), str("repo", true, 200), str("state", false, 20)],
    target: (p) => `GitHub issues in ${p.owner}/${p.repo}`,
  },
  {
    name: "github.create_issue",
    app: "github",
    level: "write",
    description:
      "Open a new issue in a repository; params: owner, repo, title, body (optional)",
    params: [str("owner", true, 200), str("repo", true, 200), str("title", true, 500), str("body", false, 20000)],
    target: (p) => `Open GitHub issue in ${p.owner}/${p.repo}: "${p.title}"`,
  },
  {
    name: "github.comment_on_issue",
    app: "github",
    level: "write",
    description:
      "Comment on an existing issue or pull request; params: owner, repo, issueNumber, body",
    params: [str("owner", true, 200), str("repo", true, 200), num("issueNumber"), str("body", true, 20000)],
    target: (p) =>
      `Comment on GitHub issue ${p.owner}/${p.repo}#${p.issueNumber}`,
  },
];

export function findOperation(name: string): AppOperation | null {
  return APP_OPERATIONS.find((op) => op.name === name) ?? null;
}

/**
 * Check raw params against an operation's spec. Returns normalized params
 * (unknown keys dropped — nothing an operation did not declare ever reaches
 * a connector call) or a human-readable error.
 */
export function validateParams(
  op: AppOperation,
  raw: unknown,
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const input =
    raw === undefined || raw === null
      ? {}
      : typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
  if (input === null) return { ok: false, error: "params must be an object" };
  const params: Record<string, unknown> = {};
  for (const spec of op.params) {
    const value = input[spec.name];
    if (value === undefined || value === null || value === "") {
      if (spec.required) {
        return { ok: false, error: `missing required param "${spec.name}"` };
      }
      continue;
    }
    if (spec.kind === "string") {
      if (typeof value !== "string") {
        return { ok: false, error: `param "${spec.name}" must be a string` };
      }
      if (spec.maxLength && value.length > spec.maxLength) {
        return {
          ok: false,
          error: `param "${spec.name}" exceeds ${spec.maxLength} characters`,
        };
      }
      // Control characters are never legitimate; CR/LF only in multiline
      // fields. This is the header-injection gate for everything that ends
      // up in an RFC-822 header, URL, or path.
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) {
        return {
          ok: false,
          error: `param "${spec.name}" contains control characters`,
        };
      }
      if (!spec.multiline && /[\r\n]/.test(value)) {
        return {
          ok: false,
          error: `param "${spec.name}" must not contain line breaks`,
        };
      }
      params[spec.name] = value;
    } else {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `param "${spec.name}" must be a number` };
      }
      params[spec.name] = n;
    }
  }
  return { ok: true, params };
}

/**
 * The instructions injected into an agent's system prompt when it holds at
 * least one usable grant. Only operations the agent's grants actually allow
 * are listed — the model never sees an operation it would be denied.
 */
export function buildAppsPromptSection(
  grants: ReadonlyMap<ConnectedAppId, AppAccessLevel>,
): string | null {
  const allowed = APP_OPERATIONS.filter((op) => {
    const granted = grants.get(op.app);
    return granted !== undefined && levelAllows(granted, op.level);
  });
  if (allowed.length === 0) return null;
  const lines = allowed.map(
    (op) =>
      `- ${op.name} (${op.level}${op.level === "write" ? ", needs owner approval" : ""}): ${op.description}`,
  );
  return [
    "CONNECTED APPS",
    "You may use the owner's connected apps through the operations listed below — and only these; anything else is refused.",
    lines.join("\n"),
    'To run an operation, output an action block on its own line, exactly like this:\n<app_action>{"operation":"gmail.search","params":{"query":"from:alice"}}</app_action>',
    "The results come back to you in a follow-up message before you write your final answer. Request at most 3 action blocks at a time, and only when the objective truly needs them.",
    "Operations marked \"needs owner approval\" pause the task until the owner approves — the action runs after approval, so request it and stop; do not assume it happened.",
    "Your final answer must contain no action blocks.",
  ].join("\n\n");
}
