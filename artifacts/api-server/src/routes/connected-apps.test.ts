/**
 * Connected-app coverage:
 *  - the action parser only accepts explicit, well-formed blocks
 *  - the authorization deny matrix (unknown op, no grant, insufficient
 *    level, invalid params) and the write→approval rule
 *  - the /connected-apps inventory and the workspace-wide enable switch
 *  - agent grant CRUD: create with grants, replace on update, leave
 *    unchanged when omitted, and never copy grants on duplication
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md):
 * impersonate the existing owner, tag and clean up all created rows, never
 * clobber owner_clerk_id, and restore any shared setting rows we touch.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentAppGrantsTable,
  agentsTable,
  db,
  googleAccountsTable,
  tasksTable,
  workspaceConnectedAppsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({
  userId: "hc-apps-owner" as string | null,
  emails: {} as Record<string, string>,
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
  clerkClient: {
    users: {
      getUser: async (id: string) => {
        const email = authState.emails[id];
        if (!email) throw new Error("no such user");
        return {
          primaryEmailAddress: {
            emailAddress: email,
            verification: { status: "verified" },
          },
        };
      },
    },
  },
}));

import officeRouter from "./office";
import { parseAppActions } from "../connected-apps/parser";
import {
  ACTION_HISTORY_CHAR_BUDGET,
  ACTION_RESULT_HEAD_CHARS,
  ACTION_RESULT_TAIL_CHARS,
  COMPACT_ACTION_ENTRY_MAX_CHARS,
  compactActionEntry,
  compactActionHistoryForPrompt,
} from "../connected-apps/actions";
import { authorizeAppAction } from "../connected-apps/authorize";
import {
  buildAppsPromptSection,
  findOperation,
  validateParams,
} from "../connected-apps/catalog";
import { encryptRefreshToken } from "../google/credentials";
import type { AppAccessLevel, ConnectedAppId } from "@workspace/db";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Apps Test ${Date.now()}`;
const createdAgentIds: string[] = [];
let workspaceId: string;
/** app → original settings row (or null when there was none) to restore. */
const touchedSettings = new Map<string, { enabled: boolean } | null>();

function agentInput(name: string, extra: Record<string, unknown> = {}) {
  return {
    name: `${name} ${RUN_TAG}`,
    title: "Test Analyst",
    mission: "Exercise connected-app grants and report back.",
    provider: "claude_max",
    securityPreset: "assistant",
    avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
    ...extra,
  };
}

async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agents")
    .send(agentInput(name, extra));
  if (res.status === 201) createdAgentIds.push(res.body.id);
  return res;
}

async function rememberSetting(appId: string) {
  if (touchedSettings.has(appId)) return;
  const [row] = await db
    .select()
    .from(workspaceConnectedAppsTable)
    .where(
      and(
        eq(workspaceConnectedAppsTable.workspaceId, workspaceId),
        eq(workspaceConnectedAppsTable.app, appId),
      ),
    )
    .limit(1);
  touchedSettings.set(appId, row ? { enabled: row.enabled } : null);
}

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "connected-apps-route-test-secret");
  const [workspaceInsert] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `connected-apps-route-${Date.now()}` })
    .returning();
  const workspace = workspaceInsert!;
  workspaceId = workspace.id;
  authState.userId = workspace.clerkUserId;
  await db.insert(googleAccountsTable).values({
    workspaceId,
    clerkUserId: workspace.clerkUserId,
    googleSub: `google-${RUN_TAG}`,
    email: "route-test@example.com",
    refreshTokenEnc: encryptRefreshToken("test-refresh-token"),
    scopes:
      "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send",
  });
});

afterAll(async () => {
  // Restore any shared enable-switch rows exactly as we found them.
  for (const [appId, original] of touchedSettings) {
    if (original === null) {
      await db
        .delete(workspaceConnectedAppsTable)
        .where(
          and(
            eq(workspaceConnectedAppsTable.workspaceId, workspaceId),
            eq(workspaceConnectedAppsTable.app, appId),
          ),
        );
    } else {
      await db
        .insert(workspaceConnectedAppsTable)
        .values({
          workspaceId,
          app: appId,
          enabled: original.enabled,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            workspaceConnectedAppsTable.workspaceId,
            workspaceConnectedAppsTable.app,
          ],
          set: { enabled: original.enabled, updatedAt: new Date() },
        });
    }
  }
  if (createdAgentIds.length > 0) {
    await db
      .delete(agentAppGrantsTable)
      .where(inArray(agentAppGrantsTable.agentId, createdAgentIds));
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db
      .delete(agentsTable)
      .where(inArray(agentsTable.id, createdAgentIds));
  }
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  vi.unstubAllEnvs();
});

describe("action block parser", () => {
  it("parses explicit blocks and strips them from the prose", () => {
    const { requests, cleaned } = parseAppActions(
      'Check the mailbox.\n<app_action>{"operation":"gmail.search","params":{"query":"from:alice"}}</app_action>\nDone.',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ ok: true, operation: "gmail.search" });
    expect(cleaned).not.toContain("app_action");
    expect(cleaned).toContain("Check the mailbox.");
  });

  it("never treats prose as an action", () => {
    const { requests } = parseAppActions(
      "You should run gmail.search with query from:alice, then send an email.",
    );
    expect(requests).toHaveLength(0);
  });

  it("flags malformed JSON and missing operations as errors, not guesses", () => {
    const { requests } = parseAppActions(
      "<app_action>not json</app_action>\n<app_action>{\"params\":{}}</app_action>",
    );
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => !r.ok)).toBe(true);
  });

  it("returns a precise, actionable validation error for each failure mode", () => {
    const [badJson] = parseAppActions(
      "<app_action>{oops}</app_action>",
    ).requests;
    expect(badJson!.ok).toBe(false);
    if (!badJson!.ok) {
      expect(badJson!.error).toMatch(/not valid JSON/i);
      // The error restates the exact shape a corrected block must take.
      expect(badJson!.error).toContain('{"operation":"<name>","params":{...}}');
    }

    const [noOp] = parseAppActions(
      '<app_action>{"params":{"query":"x"}}</app_action>',
    ).requests;
    expect(noOp!.ok).toBe(false);
    if (!noOp!.ok) expect(noOp!.error).toMatch(/"operation" string/);

    const [emptyOp] = parseAppActions(
      '<app_action>{"operation":"","params":{}}</app_action>',
    ).requests;
    expect(emptyOp!.ok).toBe(false);
    if (!emptyOp!.ok) expect(emptyOp!.error).toMatch(/"operation" string/);
  });

  it("keeps valid requests when a sibling block is malformed", () => {
    const { requests, cleaned } = parseAppActions(
      '<app_action>not json</app_action>\n<app_action>{"operation":"gmail.search","params":{"query":"q"}}</app_action>',
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]!.ok).toBe(false);
    expect(requests[1]).toMatchObject({ ok: true, operation: "gmail.search" });
    expect(cleaned).not.toContain("app_action");
  });
});

describe("action history compaction", () => {
  it("returns bounded entries verbatim and elides only the middle of oversized ones", () => {
    const short = "[Gmail] gmail.search → SUCCESS:\n2 messages.";
    expect(compactActionEntry(short)).toBe(short);

    const entry = `HEAD-id-123 ${"x".repeat(50_000)} TAIL-id-789`;
    const compacted = compactActionEntry(entry);
    expect(compacted.length).toBeLessThanOrEqual(COMPACT_ACTION_ENTRY_MAX_CHARS);
    // The head and tail — where identifiers and newest rows live — are
    // verbatim, and the marker states exactly how much was cut.
    expect(compacted.startsWith("HEAD-id-123")).toBe(true);
    expect(compacted.endsWith("TAIL-id-789")).toBe(true);
    expect(compacted).toContain("characters omitted");
    expect(compacted).toContain(
      String(
        entry.length - (ACTION_RESULT_HEAD_CHARS + ACTION_RESULT_TAIL_CHARS),
      ),
    );
  });

  it("keeps a slightly-over entry verbatim when an elision marker would not shrink it", () => {
    const entry = "y".repeat(
      ACTION_RESULT_HEAD_CHARS + ACTION_RESULT_TAIL_CHARS + 100,
    );
    expect(compactActionEntry(entry)).toBe(entry);
  });

  it("keeps newest entries detailed, collapses older ones, and counts the oldest out loud", () => {
    // 150 large entries — far beyond every budget tier.
    const entries = Array.from(
      { length: 150 },
      (_, i) => `entry-${i} status line\n${"z".repeat(3_000)}`,
    );
    const out = compactActionHistoryForPrompt(entries);
    const joined = out.join("\n");

    // The whole section respects the hard budgets (detailed + collapsed
    // tiers plus one omission note), instead of 150 × 3k chars.
    expect(joined.length).toBeLessThanOrEqual(
      ACTION_HISTORY_CHAR_BUDGET + 4_000 + 300,
    );
    // Newest entry keeps (compacted) detail; its middle elision is explicit.
    expect(joined).toContain("entry-149 status line");
    expect(out[out.length - 1]).toContain("characters omitted");
    // Older kept entries collapse to their status line — no silent detail.
    expect(joined).toContain("(result details omitted)");
    // The oldest are summarized by count, never dropped silently.
    expect(out[0]).toMatch(/\d+ earlier settled action result/);
    // Original order is preserved for everything that stayed.
    expect(joined.indexOf("entry-100 ")).toBeLessThan(
      joined.indexOf("entry-149 "),
    );
  });
});

describe("authorization deny matrix", () => {
  const grants = (
    entries: [ConnectedAppId, AppAccessLevel][],
  ): {
    grants: Map<ConnectedAppId, AppAccessLevel>;
    sensitiveDataSandbox: boolean;
  } => ({
    grants: new Map(entries),
    sensitiveDataSandbox: false,
  });

  it("denies unknown operations", () => {
    const verdict = authorizeAppAction(grants([["gmail", "write"]]), "gmail.delete_everything", {});
    expect(verdict.kind).toBe("deny");
  });

  it("denies apps the agent holds no grant for", () => {
    const verdict = authorizeAppAction(grants([["gmail", "read"]]), "github.list_repos", {});
    expect(verdict.kind).toBe("deny");
  });

  it("denies operations above the granted level", () => {
    const verdict = authorizeAppAction(
      grants([["gmail", "read"]]),
      "gmail.create_draft",
      { to: "a@b.c", subject: "Hi", body: "Hello" },
    );
    expect(verdict.kind).toBe("deny");
  });

  it("denies invalid params and drops undeclared ones", () => {
    const missing = authorizeAppAction(grants([["gmail", "read"]]), "gmail.search", {});
    expect(missing.kind).toBe("deny");
    const sneaky = authorizeAppAction(grants([["gmail", "read"]]), "gmail.search", {
      query: "from:alice",
      rawPath: "/gmail/v1/users/me/settings",
    });
    expect(sneaky.kind).toBe("allow");
    if (sneaky.kind === "allow") {
      expect(Object.keys(sneaky.params)).toEqual(["query"]);
    }
  });

  it("denies header injection via CR/LF in header-bound params", () => {
    const bcc = authorizeAppAction(
      grants([["gmail", "write"]]),
      "gmail.send_email",
      { to: "a@b.c\r\nBcc: everyone@evil.example", subject: "Hi", body: "Hello" },
    );
    expect(bcc.kind).toBe("deny");
    const subj = authorizeAppAction(
      grants([["gmail", "write"]]),
      "gmail.send_email",
      { to: "a@b.c", subject: "Hi\nX-Injected: yes", body: "Hello" },
    );
    expect(subj.kind).toBe("deny");
    // Multiline bodies remain legitimate.
    const ok = authorizeAppAction(
      grants([["gmail", "write"]]),
      "gmail.send_email",
      { to: "a@b.c", subject: "Hi", body: "Hello\n\nBest,\nMarlow" },
    );
    expect(ok.kind).toBe("needs_approval");
  });

  it("denies control characters anywhere", () => {
    const verdict = authorizeAppAction(grants([["gmail", "read"]]), "gmail.search", {
      query: "from:alice\x07",
    });
    expect(verdict.kind).toBe("deny");
  });

  it("routes writes to owner approval even at write level", () => {
    const verdict = authorizeAppAction(
      grants([["gmail", "write"]]),
      "gmail.send_email",
      { to: "a@b.c", subject: "Hi", body: "Hello" },
    );
    expect(verdict.kind).toBe("needs_approval");
  });

  it("allows reads within the grant", () => {
    const verdict = authorizeAppAction(grants([["gmail", "read"]]), "gmail.search", {
      query: "from:alice",
    });
    expect(verdict.kind).toBe("allow");
  });

  it("classifies GitHub code discovery as read and every code mutation as write", () => {
    const read = grants([["github", "read"]]);
    for (const [op, params] of [
      ["github.list_branches", { owner: "o", repo: "r" }],
      ["github.list_directory", { owner: "o", repo: "r", path: "src" }],
      ["github.get_pull_request", { owner: "o", repo: "r", pullNumber: 5 }],
    ] as const) {
      expect(authorizeAppAction(read, op, params).kind).toBe("allow");
    }
    const mutations: [string, Record<string, unknown>][] = [
      ["github.create_branch", { owner: "o", repo: "r", branch: "b", fromRef: "main" }],
      [
        "github.put_file",
        { owner: "o", repo: "r", branch: "b", path: "a.txt", content: "x", message: "m" },
      ],
      [
        "github.open_pull_request",
        { owner: "o", repo: "r", title: "t", head: "b", base: "main" },
      ],
      [
        "github.merge_pull_request",
        { owner: "o", repo: "r", pullNumber: 5, expectedHeadSha: "a".repeat(40) },
      ],
    ];
    for (const [op, params] of mutations) {
      // Read grant: denied outright.
      expect(authorizeAppAction(read, op, params).kind).toBe("deny");
      // Write grant: still parks for explicit owner approval.
      expect(
        authorizeAppAction(grants([["github", "write"]]), op, params).kind,
      ).toBe("needs_approval");
    }
  });

  it("names the exact mutation in each GitHub approval target", () => {
    const putFile = findOperation("github.put_file")!;
    expect(
      putFile.target({
        owner: "acme",
        repo: "site",
        branch: "fix-1",
        path: "src/app.ts",
        message: "Fix crash",
        expectedSha: "a".repeat(40),
      }),
    ).toBe(
      'Commit to GitHub acme/site on branch "fix-1": update src/app.ts ("Fix crash")',
    );
    const merge = findOperation("github.merge_pull_request")!;
    expect(
      merge.target({ owner: "acme", repo: "site", pullNumber: 7, expectedHeadSha: "abc123" }),
    ).toContain("Merge GitHub pull request acme/site#7 at head abc123");
    const branch = findOperation("github.create_branch")!;
    expect(
      branch.target({ owner: "acme", repo: "site", branch: "fix-1", fromRef: "main" }),
    ).toBe('Create GitHub branch "fix-1" from main in acme/site');
    const pr = findOperation("github.open_pull_request")!;
    expect(
      pr.target({ owner: "acme", repo: "site", title: "Fix", head: "fix-1", base: "main" }),
    ).toBe('Open GitHub pull request in acme/site: "fix-1" into "main" ("Fix")');
  });

  it("bounds GitHub code params: no line breaks in refs/paths/messages, multiline file content ok", () => {
    const putFile = findOperation("github.put_file")!;
    const ok = validateParams(putFile, {
      owner: "o",
      repo: "r",
      branch: "b",
      path: "src/a.txt",
      content: "line one\nline two\n",
      message: "Add file",
    });
    expect(ok.ok).toBe(true);
    for (const bad of [
      { branch: "b\nmain" },
      { path: "a\r\nb" },
      { message: "hi\nthere" },
    ]) {
      const res = validateParams(putFile, {
        owner: "o",
        repo: "r",
        branch: "b",
        path: "a.txt",
        content: "x",
        message: "m",
        ...bad,
      });
      expect(res.ok).toBe(false);
    }
    // Oversized file content is rejected before any executor runs.
    const oversized = validateParams(putFile, {
      owner: "o",
      repo: "r",
      branch: "b",
      path: "a.txt",
      content: "x".repeat(200001),
      message: "m",
    });
    expect(oversized.ok).toBe(false);
    // A merge without the reviewed head SHA never validates.
    const merge = findOperation("github.merge_pull_request")!;
    const missingSha = validateParams(merge, { owner: "o", repo: "r", pullNumber: 3 });
    expect(missingSha.ok).toBe(false);
  });
});

describe("prompt section", () => {
  it("is absent without grants and lists only allowed operations", () => {
    expect(buildAppsPromptSection(new Map())).toBeNull();
    const section = buildAppsPromptSection(
      new Map<ConnectedAppId, AppAccessLevel>([["gmail", "read"]]),
    );
    expect(section).toContain("gmail.search");
    expect(section).not.toContain("gmail.create_draft");
    expect(section).not.toContain("github.");
  });

  it("gates the Sheets operations by grant level like any other Drive op", () => {
    const read = buildAppsPromptSection(
      new Map<ConnectedAppId, AppAccessLevel>([["google_drive", "read"]]),
    );
    expect(read).toContain("google_drive.list_sheet_tabs");
    expect(read).toContain("google_drive.read_sheet_range");
    expect(read).not.toContain("google_drive.create_spreadsheet");
    expect(read).not.toContain("google_drive.append_sheet_rows");
    const draft = buildAppsPromptSection(
      new Map<ConnectedAppId, AppAccessLevel>([["google_drive", "draft"]]),
    );
    expect(draft).toContain("google_drive.create_spreadsheet");
    expect(draft).not.toContain("google_drive.write_sheet_range");
    const write = buildAppsPromptSection(
      new Map<ConnectedAppId, AppAccessLevel>([["google_drive", "write"]]),
    );
    for (const op of [
      "google_drive.write_sheet_range",
      "google_drive.append_sheet_rows",
      "google_drive.add_sheet_tab",
      "google_drive.rename_sheet_tab",
    ]) {
      expect(write).toContain(op);
    }
    // A sandboxed agent never sees the spreadsheet mutations.
    const sandboxed = buildAppsPromptSection(
      new Map<ConnectedAppId, AppAccessLevel>([["google_drive", "write"]]),
      { sensitiveDataSandbox: true },
    );
    expect(sandboxed).toContain("google_drive.read_sheet_range");
    expect(sandboxed).not.toContain("google_drive.write_sheet_range");
    expect(sandboxed).not.toContain("google_drive.append_sheet_rows");
  });

  it("gates the GitHub code operations by grant level and sandbox", () => {
    const read = buildAppsPromptSection(
      new Map<ConnectedAppId, AppAccessLevel>([["github", "read"]]),
    );
    for (const op of [
      "github.list_branches",
      "github.list_directory",
      "github.get_pull_request",
    ]) {
      expect(read).toContain(op);
    }
    for (const op of [
      "github.create_branch",
      "github.put_file",
      "github.open_pull_request",
      "github.merge_pull_request",
    ]) {
      expect(read).not.toContain(op);
    }
    const write = buildAppsPromptSection(
      new Map<ConnectedAppId, AppAccessLevel>([["github", "write"]]),
    );
    for (const op of [
      "github.create_branch",
      "github.put_file",
      "github.open_pull_request",
      "github.merge_pull_request",
    ]) {
      expect(write).toContain(op);
    }
    // A sandboxed agent sees discovery only — never a code mutation.
    const sandboxed = buildAppsPromptSection(
      new Map<ConnectedAppId, AppAccessLevel>([["github", "write"]]),
      { sensitiveDataSandbox: true },
    );
    expect(sandboxed).toContain("github.list_branches");
    expect(sandboxed).not.toContain("github.put_file");
    expect(sandboxed).not.toContain("github.merge_pull_request");
  });

  it("accepts multiline JSON in the values param but not in single-line params", () => {
    const op = findOperation("google_drive.append_sheet_rows")!;
    const multiline = validateParams(op, {
      spreadsheetId: "s",
      tabTitle: "Data",
      values: '[\n  ["a", 1],\n  ["b", 2]\n]',
    });
    expect(multiline.ok).toBe(true);
    const sneakyTab = validateParams(op, {
      spreadsheetId: "s",
      tabTitle: "Data\nInjected",
      values: '[["a"]]',
    });
    expect(sneakyTab.ok).toBe(false);
  });
});

describe("connected-apps routes", () => {
  it("lists all three apps with enable state, identity, and grant counts", async () => {
    const res = await request(app).get("/api/connected-apps");
    expect(res.status).toBe(200);
    const apps = res.body.apps.map((a: { app: string }) => a.app);
    expect(apps).toEqual(["gmail", "google_drive", "github"]);
    for (const entry of res.body.apps) {
      expect(typeof entry.enabled).toBe("boolean");
      expect(typeof entry.grantedAgents).toBe("number");
      expect(["connected", "expired", "not_connected", "unavailable"]).toContain(
        entry.status,
      );
      // Identity is always present and safe: a string label or an explicit null.
      expect("accountLabel" in entry).toBe(true);
      expect(
        entry.accountLabel === null || typeof entry.accountLabel === "string",
      ).toBe(true);
    }
    const gmail = res.body.apps.find(
      (entry: { app: string }) => entry.app === "gmail",
    );
    expect(gmail).toMatchObject({
      status: "connected",
      accountLabel: "route-test@example.com",
    });
    for (const appId of ["google_drive", "github"]) {
      expect(
        res.body.apps.find((entry: { app: string }) => entry.app === appId),
      ).toMatchObject({
        status: "not_connected",
        accountLabel: null,
      });
    }
  });

  it("reports Gmail as expired when its workspace account lacks required scopes", async () => {
    await db
      .update(googleAccountsTable)
      .set({ scopes: "openid email" })
      .where(eq(googleAccountsTable.workspaceId, workspaceId));
    try {
      const res = await request(app).get("/api/connected-apps");
      expect(res.status).toBe(200);
      const gmail = res.body.apps.find(
        (entry: { app: string }) => entry.app === "gmail",
      );
      expect(gmail.status).toBe("expired");
      expect(gmail.accountLabel).toBe("route-test@example.com");
      expect(gmail.statusDetail).toMatch(/missing required Gmail permissions/i);
    } finally {
      await db
        .update(googleAccountsTable)
        .set({
          scopes:
            "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send",
        })
        .where(eq(googleAccountsTable.workspaceId, workspaceId));
    }
  });

  it("rejects unknown apps and bad bodies", async () => {
    const bad = await request(app)
      .patch("/api/connected-apps/slack")
      .send({ enabled: false });
    expect(bad.status).toBe(400);
    const badBody = await request(app)
      .patch("/api/connected-apps/gmail")
      .send({ enabled: "nope" });
    expect(badBody.status).toBe(400);
  });

  it("toggles the workspace-wide switch and reports it", async () => {
    await rememberSetting("google_drive");
    const off = await request(app)
      .patch("/api/connected-apps/google_drive")
      .send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    const list = await request(app).get("/api/connected-apps");
    const drive = list.body.apps.find((a: { app: string }) => a.app === "google_drive");
    expect(drive.enabled).toBe(false);
    const on = await request(app)
      .patch("/api/connected-apps/google_drive")
      .send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
  });
});

describe("agent grant lifecycle", () => {
  it("creates an agent with grants and returns them everywhere", async () => {
    const res = await createAgent("Grantee", {
      appGrants: [
        { app: "gmail", accessLevel: "draft" },
        { app: "github", accessLevel: "read" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.appGrants).toEqual(
      expect.arrayContaining([
        { app: "gmail", accessLevel: "draft" },
        { app: "github", accessLevel: "read" },
      ]),
    );

    const detail = await request(app).get(`/api/agents/${res.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.agent.appGrants).toHaveLength(2);

    const list = await request(app).get("/api/agents");
    const mine = list.body.find((a: { id: string }) => a.id === res.body.id);
    expect(mine.appGrants).toHaveLength(2);
  });

  it("deduplicates conflicting grants for the same app, keeping the last", async () => {
    const res = await createAgent("Dedupe", {
      appGrants: [
        { app: "gmail", accessLevel: "read" },
        { app: "gmail", accessLevel: "write" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.appGrants).toEqual([{ app: "gmail", accessLevel: "write" }]);
  });

  it("replaces the grant set on update and leaves it alone when omitted", async () => {
    const created = await createAgent("Replacer", {
      appGrants: [{ app: "gmail", accessLevel: "read" }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    // Update without appGrants: grants unchanged.
    const rename = await request(app)
      .patch(`/api/agents/${id}`)
      .send({ title: "Renamed Analyst" });
    expect(rename.status).toBe(200);
    expect(rename.body.appGrants).toEqual([{ app: "gmail", accessLevel: "read" }]);

    // Update with a new set: full replacement.
    const swap = await request(app)
      .patch(`/api/agents/${id}`)
      .send({ appGrants: [{ app: "google_drive", accessLevel: "draft" }] });
    expect(swap.status).toBe(200);
    expect(swap.body.appGrants).toEqual([
      { app: "google_drive", accessLevel: "draft" },
    ]);

    // Empty set revokes everything.
    const revoke = await request(app)
      .patch(`/api/agents/${id}`)
      .send({ appGrants: [] });
    expect(revoke.status).toBe(200);
    expect(revoke.body.appGrants).toEqual([]);
  });

  it("caps a sandboxed agent at read regardless of the stored grant level", () => {
    const sandboxed = (
      entries: [ConnectedAppId, AppAccessLevel][],
    ) => ({ grants: new Map(entries), sensitiveDataSandbox: true });

    // Reads still work — that is the whole point of the sandbox.
    const read = authorizeAppAction(
      sandboxed([["gmail", "write"]]),
      "gmail.search",
      { query: "from:alice" },
    );
    expect(read.kind).toBe("allow");

    // Drafts are denied even though the grant says write.
    const draft = authorizeAppAction(
      sandboxed([["gmail", "write"]]),
      "gmail.create_draft",
      { to: "a@b.c", subject: "s", body: "b" },
    );
    expect(draft.kind).toBe("deny");
    if (draft.kind === "deny") {
      expect(draft.reason).toMatch(/sensitive data sandbox/i);
    }

    // Writes never even reach the approval queue.
    const write = authorizeAppAction(
      sandboxed([["gmail", "write"]]),
      "gmail.send_email",
      { to: "a@b.c", subject: "s", body: "b" },
    );
    expect(write.kind).toBe("deny");
  });

  it("shows a sandboxed agent only read operations, framed as read-only", () => {
    const grants = new Map<"gmail" | "google_drive" | "github", "read" | "draft" | "write">([
      ["gmail", "write"],
      ["github", "write"],
    ]);
    const prompt = buildAppsPromptSection(grants, { sensitiveDataSandbox: true });
    expect(prompt).toBeTruthy();
    expect(prompt!).toMatch(/sensitive data sandbox/i);
    expect(prompt!).toContain("gmail.search");
    expect(prompt!).not.toContain("gmail.send_email");
    expect(prompt!).not.toContain("gmail.create_draft");
    // Untrusted-data framing is present for everyone.
    expect(prompt!).toMatch(/UNTRUSTED EXTERNAL DATA/);
    // A sandboxed agent with only write-level operations available at its
    // grant sees a read list, never an empty write list.
    const unsandboxed = buildAppsPromptSection(grants);
    expect(unsandboxed!).toContain("gmail.send_email");
  });

  it("never copies grants when duplicating an agent", async () => {
    const created = await createAgent("Original", {
      appGrants: [{ app: "github", accessLevel: "write" }],
    });
    expect(created.status).toBe(201);
    const dup = await request(app).post(
      `/api/agents/${created.body.id}/duplicate`,
    );
    expect(dup.status).toBe(201);
    createdAgentIds.push(dup.body.id);
    expect(dup.body.appGrants).toEqual([]);
    const detail = await request(app).get(`/api/agents/${dup.body.id}`);
    expect(detail.body.agent.appGrants).toEqual([]);
  });
});
